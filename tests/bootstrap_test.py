"""Exercise the generated agent without connecting to a server or spawning a shell."""
import ast
import errno
import http.client
import io
import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
import urllib.response
from email.message import Message
from unittest.mock import Mock, patch

source = ast.parse(sys.stdin.read())
assert isinstance(source.body[-1], ast.If)
source.body.pop()
agent = {'__name__': 'bootstrap_test'}
exec(compile(source, '<bootstrap>', 'exec'), agent)
BASE_CONFIG = dict(agent['CONFIG'])


class Response(io.BytesIO):
    def __init__(self, body=b'{"ok":true}', status=200, headers=None):
        super().__init__(body)
        self.status = status
        self.headers = headers or {}


class Clock:
    def __init__(self):
        self.now = 1000
        self.sleeps = []
        self.stopped = False

    def wait(self, delay):
        if not self.stopped:
            self.sleeps.append(delay)
            self.now += delay
        return self.stopped

    def is_set(self):
        return self.stopped

    def set(self):
        self.stopped = True


class FakeTransport(urllib.request.BaseHandler):
    """Real urllib error/redirect processing, with no network below the handler."""
    handler_order = 100

    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def https_open(self, req):
        self.requests.append(req)
        status, header_values, body = self.responses.pop(0)
        headers = Message()
        for key, value in header_values.items():
            headers[key] = value
        response = urllib.response.addinfourl(io.BytesIO(body), headers, req.full_url, status)
        response.msg = 'offline response'
        return response

    http_open = https_open


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.stderr = io.StringIO()
        self.opener = Mock()
        self.state = patch.dict(agent, {
            'CONFIG': dict(BASE_CONFIG), 'SESSION_ID': 'test-run', 'TOKEN': 'private-bearer',
            'RUNNING': True, 'STOP_EVENT': self.clock, 'OUTCOME': None,
            'OUTCOME_LOCK': threading.Lock(), 'SESSION_EPOCH': None,
            'INPUT_ACK': 0, 'OUTPUT_SEQ': 1, 'CHILD_PID': None,
            'MASTER_FD': None, 'CHILD_EXIT_CODE': None, 'HTTP': self.opener,
            'REQUEST_HEADERS': {'Authorization': 'Bearer private-bearer', 'X-Raijin-Protocol': '2'},
        })
        self.state.start()
        self.addCleanup(self.state.stop)
        for item in [patch('time.monotonic', side_effect=lambda: self.clock.now),
                     patch('time.time', side_effect=lambda: self.clock.now),
                     patch('time.sleep', side_effect=self.clock.wait),
                     patch('secrets.randbelow', return_value=0),
                     patch('sys.stderr', self.stderr), patch('os.killpg'), patch('os.kill')]:
            item.start()
            self.addCleanup(item.stop)

    def request(self, **kwargs):
        return agent['request_json']('POST', '/agent/test-run/out', {'seq': 1, 'data': 'IyA='}, timeout=10, **kwargs)

    def error(self, code, body=None, headers=None):
        return urllib.error.HTTPError('https://example.invalid/agent/test-run/out', code, 'private raw error',
                                      headers or {}, io.BytesIO(json.dumps(body or {}).encode()))

    def failure(self, reason, call):
        with self.assertRaises(agent['RelayFailure']) as raised:
            call()
        self.assertEqual(raised.exception.reason, reason)
        return raised.exception

    def test_transport_failures_retry_identical_request(self):
        failures = [TimeoutError('private detail'), ConnectionResetError(), http.client.RemoteDisconnected(),
                    http.client.IncompleteRead(b'', 2), urllib.error.URLError('private proxy password')]
        for failure in failures:
            with self.subTest(failure=type(failure)):
                self.opener.open.reset_mock()
                self.opener.open.side_effect = [failure, Response()]
                self.assertEqual(self.request(), {'ok': True})
                self.assertEqual(self.opener.open.call_count, 2)
                self.assertIs(self.opener.open.call_args_list[0].args[0], self.opener.open.call_args_list[1].args[0])
        self.assertNotIn('private', self.stderr.getvalue())

    def test_real_redirect_chain_never_follows_or_forwards_authorization(self):
        for code in [301, 302, 303, 307, 308]:
            for target in ['https://example.invalid/agent/test-run/out', 'https://elsewhere.invalid/leak', 'http://elsewhere.invalid/leak']:
                with self.subTest(code=code, target=target):
                    transport = FakeTransport([(code, {'Location': target}, b''), (200, {}, b'{"ack":1}')])
                    agent['HTTP'] = urllib.request.build_opener(urllib.request.ProxyHandler({}), agent['NoRedirect'](), transport)
                    self.assertEqual(self.request(), {'ack': 1})
                    self.assertEqual(len(transport.requests), 2)
                    for req in transport.requests:
                        self.assertEqual(req.full_url, agent['BASE_URL'] + '/agent/test-run/out')
                        self.assertEqual(req.get_method(), 'POST')
                        self.assertEqual(req.get_header('Authorization'), 'Bearer private-bearer')
                        self.assertEqual(json.loads(req.data), {'seq': 1, 'data': 'IyA='})
                    self.assertEqual(transport.responses, [])
        self.assertNotIn('elsewhere', self.stderr.getvalue())

    def test_real_get_redirect_chain_stays_at_original_endpoint(self):
        transport = FakeTransport([(302, {'Location': 'https://elsewhere.invalid/leak'}, b''), (200, {}, b'{"events":[]}')])
        agent['HTTP'] = urllib.request.build_opener(urllib.request.ProxyHandler({}), agent['NoRedirect'](), transport)
        agent['request_json']('GET', '/agent/test-run/in')
        self.assertEqual([req.full_url for req in transport.requests], [agent['BASE_URL'] + '/agent/test-run/in'] * 2)

    def test_retry_exhaustion_has_five_attempts_and_bounded_backoff(self):
        self.opener.open.side_effect = TimeoutError('secret detail')
        error = self.failure('transport_exhausted', self.request)
        self.assertEqual(error.exit_code, 6)
        self.assertEqual(self.opener.open.call_count, 5)
        self.assertEqual(self.clock.sleeps, [0.5, 1, 2, 4])
        agent['finish'](error)
        self.assertNotIn('secret detail', self.stderr.getvalue())

    def test_http_retry_statuses_are_bounded(self):
        for code in [301, 302, 303, 307, 308, 429, 500, 502, 503, 599]:
            with self.subTest(code=code):
                self.opener.open.reset_mock()
                self.opener.open.side_effect = [self.error(code) for _ in range(5)]
                self.failure('rate_limited' if code == 429 else 'http_exhausted', self.request)
                self.assertEqual(self.opener.open.call_count, 5)

    def test_terminal_errors_do_not_retry_and_are_distinct(self):
        for code, body, reason, exit_code in [
            (400, {}, 'http_rejected', 9), (401, {}, 'authorization_rejected', 5),
            (403, {}, 'authorization_rejected', 5), (404, {}, 'http_rejected', 9),
            (410, {'status': 'ended'}, 'browser_closed', 0),
            (410, {'status': 'disconnected'}, 'browser_closed', 0),
            (410, {'status': 'expired'}, 'session_expired', 3),
            (410, {'code': 'session_reset'}, 'session_reset', 4),
            (410, {'status': 'ended', 'code': 'input_overflow'}, 'input_overflow', 8),
            (410, {'status': 'ended', 'code': 'too_many_polls'}, 'too_many_polls', 8),
            (410, {}, 'session_ended', 4),
        ]:
            with self.subTest(code=code, body=body):
                self.opener.open.reset_mock()
                self.opener.open.side_effect = self.error(code, body)
                error = self.failure(reason, self.request)
                self.assertEqual(error.exit_code, exit_code)
                self.assertEqual(self.opener.open.call_count, 1)
        self.assertEqual(self.clock.sleeps, [])

    def test_409_is_startup_wait_but_bounded_after_epoch_negotiation(self):
        self.opener.open.side_effect = self.error(409)
        self.assertEqual(self.request(), {'retry': True})
        agent['SESSION_EPOCH'] = 'negotiated-epoch-value'
        self.opener.open.reset_mock()
        self.opener.open.side_effect = [self.error(409) for _ in range(5)]
        self.failure('session_not_ready', self.request)
        self.assertEqual(self.opener.open.call_count, 5)

    def test_429_honors_retry_after_seconds_and_http_date(self):
        for value, delay in [('3', 3), ('Thu, 01 Jan 1970 00:16:44 GMT', 4)]:
            with self.subTest(value=value):
                self.clock.now = 1000
                self.clock.sleeps.clear()
                self.opener.open.side_effect = [self.error(429, headers={'Retry-After': value}), Response()]
                self.request()
                self.assertEqual(self.clock.sleeps, [delay])

    def test_429_delay_outside_deadline_fails_without_early_retry(self):
        self.opener.open.side_effect = self.error(429, headers={'Retry-After': '120'})
        error = self.failure('rate_limited', lambda: self.request(deadline=self.clock.now + 30))
        self.assertEqual(error.details['status'], 429)
        self.assertEqual(self.opener.open.call_count, 1)
        self.assertEqual(self.clock.sleeps, [])

    def test_request_timeout_is_limited_by_remaining_deadline(self):
        self.opener.open.return_value = Response()
        self.request(deadline=self.clock.now + 2)
        self.assertEqual(self.opener.open.call_args.kwargs['timeout'], 2)
        self.failure('request_deadline', lambda: self.request(deadline=self.clock.now))
        self.assertEqual(self.opener.open.call_count, 1)

    def test_stop_interrupts_retry_without_another_request(self):
        self.opener.open.side_effect = TimeoutError()
        def stop_wait(delay):
            self.clock.set()
            return True
        with patch.object(self.clock, 'wait', side_effect=stop_wait):
            self.failure('stopped', self.request)
        self.assertEqual(self.opener.open.call_count, 1)

    def test_malformed_json_truncation_and_nonobjects_retry(self):
        for body in [b'', b'{"ack":', b'\xff', b'[]', b'null', b'<html>bad gateway</html>']:
            with self.subTest(body=body):
                self.opener.open.reset_mock()
                self.opener.open.side_effect = [Response(body), Response()]
                self.assertEqual(self.request(), {'ok': True})
                self.assertEqual(self.opener.open.call_count, 2)

    def test_malformed_json_exhaustion_is_bounded(self):
        self.opener.open.side_effect = [Response(b'{') for _ in range(5)]
        self.failure('invalid_response', self.request)
        self.assertEqual(self.opener.open.call_count, 5)

    def test_diagnostics_include_safe_context_without_secrets_or_redirect_location(self):
        self.opener.open.side_effect = [self.error(302, headers={
            'Location': 'https://elsewhere.invalid/?token=secret-query', 'CF-Ray': 'abc123-SJC',
        }), Response()]
        agent['request_json']('POST', '/agent/test-run/out?token=secret-query', {'data': 'private-output'})
        record = json.loads(self.stderr.getvalue().split('raijin: ')[1])
        self.assertEqual(record['version'], '2026-09-29.1')
        self.assertEqual(record['runId'], 'test-run')
        self.assertEqual(record['path'], '/agent/test-run/out')
        self.assertEqual(record['status'], 302)
        self.assertEqual(record['ray'], 'abc123-SJC')
        self.assertEqual(record['attempt'], 1)
        self.assertEqual(record['maxAttempts'], 5)
        self.assertNotIn('private', self.stderr.getvalue())
        self.assertNotIn('secret-query', self.stderr.getvalue())
        self.assertNotIn('elsewhere', self.stderr.getvalue())
        self.assertNotIn('ray', agent['request_details']('POST', '/out', 1, 500, {'CF-Ray': 'unsafe\nheader'}))

    def test_first_failure_is_logged_once_and_survives_cleanup_failure(self):
        first = agent['RelayFailure']('session_reset', 4)
        agent['finish'](first)
        agent['finish'](agent['RelayFailure']('local_pty_failure', 7))
        self.assertIs(agent['OUTCOME'], first)
        self.assertEqual(self.stderr.getvalue().count('"event":"exit"'), 1)
        self.assertFalse(agent['RUNNING'])

    def test_request_headers_include_protocol_epoch_and_applied_input_ack(self):
        agent['SESSION_EPOCH'] = 'negotiated-epoch-value'
        agent['INPUT_ACK'] = 12
        self.opener.open.return_value = Response(b'{"events":[]}')
        agent['request_json']('GET', '/agent/test-run/in')
        headers = dict(self.opener.open.call_args.args[0].header_items())
        self.assertEqual(headers['X-raijin-protocol'], '2')
        self.assertEqual(headers['X-raijin-epoch'], 'negotiated-epoch-value')
        self.assertEqual(headers['X-raijin-input-ack'], '12')

    def test_legacy_configuration_negotiates_epoch_before_spawning(self):
        agent['CONFIG']['reusable'] = False
        with patch.dict(agent, request_json=Mock(side_effect=[{'retry': True}, {'browserConnected': False},
                    {'browserConnected': True, 'protocol': 2, 'epoch': 'negotiated-epoch-value'}])):
            agent['register_run']()
            self.assertEqual(agent['SESSION_EPOCH'], 'negotiated-epoch-value')
        self.assertIn('waiting_for_browser', self.stderr.getvalue())
        self.assertIn('terminal_connected', self.stderr.getvalue())

    def test_readiness_rejects_missing_protocol_or_epoch(self):
        for response in [{'browserConnected': True}, {'browserConnected': True, 'protocol': 2, 'epoch': ''}]:
            with patch.dict(agent, request_json=Mock(return_value=response)):
                self.failure('protocol_unavailable', agent['register_run'])

    def test_browser_startup_wait_is_bounded_and_reports_elapsed_gate(self):
        with patch.dict(agent, request_json=Mock(return_value={'retry': True})):
            error = self.failure('browser_timeout', agent['register_run'])
        self.assertEqual(error.exit_code, 10)
        self.assertEqual(error.details, {'gate': 'browser', 'elapsed': 300})

    def test_registration_reuses_run_credentials_and_one_startup_deadline(self):
        agent['CONFIG']['reusable'] = True
        request = Mock(side_effect=[{'retry': True}, {'ok': True},
                      {'browserConnected': True, 'protocol': 2, 'epoch': 'negotiated-epoch-value'}])
        with patch.dict(agent, request_json=request), patch('secrets.token_urlsafe', side_effect=['new-run-identity', 'new-agent-secret']):
            agent['register_run']()
        calls = request.call_args_list
        self.assertEqual(calls[0].args, calls[1].args)
        self.assertEqual(calls[0].args[2], {'runId': 'new-run-identity', 'agentToken': 'new-agent-secret'})
        self.assertEqual({c.kwargs['deadline'] for c in calls}, {1300})
        self.assertEqual(agent['REQUEST_HEADERS']['Authorization'], 'Bearer new-agent-secret')
        self.assertNotIn('new-agent-secret', self.stderr.getvalue())

    def test_output_sequence_survives_409_and_lost_ack(self):
        self.opener.open.side_effect = [self.error(409), http.client.RemoteDisconnected(), Response(b'{"ack":1}'), Response(b'{"ack":2}')]
        agent['send_output'](b'# ')
        agent['send_output'](b'next')
        packets = [json.loads(call.args[0].data) for call in self.opener.open.call_args_list]
        self.assertEqual(packets[:3], [{'seq': 1, 'data': 'IyA='}] * 3)
        self.assertEqual(packets[3]['seq'], 2)
        self.assertEqual(agent['OUTPUT_SEQ'], 3)

    def test_output_sequence_does_not_advance_without_ack(self):
        self.opener.open.return_value = Response(b'{"ack":0}')
        self.failure('invalid_output_ack', lambda: agent['send_output'](b'x'))
        self.assertEqual(agent['OUTPUT_SEQ'], 1)

    def test_input_duplicates_skipped_and_partial_writes_complete_before_ack(self):
        agent['MASTER_FD'] = 42
        observed = []
        def write(fd, data):
            observed.append((bytes(data), agent['INPUT_ACK']))
            return min(2, len(data))
        events = [{'seq': 1, 'type': 'stdin', 'data': 'hello'}, {'seq': 1, 'type': 'stdin', 'data': 'hello'},
                  {'seq': 2, 'type': 'resize', 'rows': 24, 'cols': 80}]
        with patch('os.write', side_effect=write), patch('fcntl.ioctl') as resize:
            agent['apply_events'](events)
            agent['apply_events'](events)
        self.assertEqual(observed, [(b'hello', 0), (b'llo', 0), (b'o', 0)])
        resize.assert_called_once()
        self.assertEqual(agent['INPUT_ACK'], 2)

    def test_failed_partial_write_does_not_ack_event(self):
        agent['MASTER_FD'] = 42
        with patch('os.write', side_effect=[2, OSError('write failed')]):
            with self.assertRaises(OSError):
                agent['apply_events']([{'seq': 1, 'type': 'stdin', 'data': 'hello'}])
        self.assertEqual(agent['INPUT_ACK'], 0)

    def test_interrupted_write_retries_without_advancing_ack(self):
        with patch('os.write', side_effect=[InterruptedError(), 2]) as write:
            agent['apply_events']([{'seq': 1, 'type': 'stdin', 'data': 'hi'}])
        self.assertEqual(write.call_count, 2)
        self.assertEqual(agent['INPUT_ACK'], 1)

    def test_input_gap_fails_without_applying_later_events(self):
        with patch('os.write') as write:
            self.failure('input_sequence_gap', lambda: agent['apply_events']([{'seq': 2, 'type': 'stdin', 'data': 'bad'}]))
        write.assert_not_called()
        self.assertEqual(agent['INPUT_ACK'], 0)

    def test_event_processing_failure_is_reported_not_silently_swallowed(self):
        with patch.dict(agent, request_json=Mock(return_value={'events': [{'seq': 1, 'type': 'stdin', 'data': 'hi'}]})), patch('os.write', side_effect=OSError()):
            agent['event_loop']()
            self.assertEqual(agent['OUTCOME'].reason, 'local_pty_failure')
            self.assertEqual(agent['OUTCOME'].exit_code, 7)
        self.assertIn('local_pty_failure', self.stderr.getvalue())

    def test_late_poll_after_shutdown_never_applies_input(self):
        def late_response(*args, **kwargs):
            agent['RUNNING'] = False
            return {'events': [{'seq': 1, 'type': 'stdin', 'data': 'late'}]}
        with patch.dict(agent, request_json=Mock(side_effect=late_response)), patch('os.write') as write:
            agent['event_loop']()
            self.assertEqual(agent['INPUT_ACK'], 0)
        write.assert_not_called()

    def test_shutdown_during_partial_write_does_not_ack_or_continue(self):
        def write_and_stop(fd, data):
            agent['RUNNING'] = False
            return 1
        with patch('os.write', side_effect=write_and_stop) as write:
            agent['apply_events']([{'seq': 1, 'type': 'stdin', 'data': 'hello'}])
        self.assertEqual(write.call_count, 1)
        self.assertEqual(agent['INPUT_ACK'], 0)

    def test_heartbeat_failure_retains_http_context(self):
        error = agent['RelayFailure']('authorization_rejected', 5, {'status': 403, 'ray': '123-SJC'})
        with patch.object(self.clock, 'wait', return_value=False), patch.dict(agent, request_json=Mock(side_effect=error)):
            agent['heartbeat_loop']()
            self.assertIs(agent['OUTCOME'], error)
        self.assertIn('"status":403', self.stderr.getvalue())

    def test_pty_eof_waits_for_real_nonzero_child_status(self):
        agent['MASTER_FD'] = 42
        agent['CHILD_PID'] = 123
        with patch('select.select', return_value=([42], [], [])), patch('os.read', side_effect=OSError(errno.EIO, 'PTY closed')), patch('os.waitpid', side_effect=[(0, 0), (123, 7 << 8)]):
            self.assertEqual(agent['read_and_forward'](), 7)
        self.assertEqual(agent['CHILD_EXIT_CODE'], 7)

    def test_main_preserves_failure_reason_and_nonzero_exit_during_cleanup(self):
        failure = agent['RelayFailure']('transport_exhausted', 6)
        close = Mock()
        agent['SESSION_EPOCH'] = 'negotiated-epoch-value'
        with patch.dict(agent, register_run=Mock(), spawn_process=Mock(return_value=(123, 42)),
                        read_and_forward=Mock(side_effect=failure), close_remote=close), \
             patch('threading.Thread'), patch('os.close'), patch('os.waitpid', return_value=(123, 9)):
            self.assertEqual(agent['main'](), 6)
        close.assert_called_once_with('transport_exhausted', 6)
        self.assertEqual(self.stderr.getvalue().count('"event":"exit"'), 1)

    def test_main_reports_remote_process_nonzero_exit(self):
        close = Mock()
        agent['SESSION_EPOCH'] = 'negotiated-epoch-value'
        with patch.dict(agent, register_run=Mock(), spawn_process=Mock(return_value=(123, 42)),
                        read_and_forward=Mock(return_value=7), close_remote=close), \
             patch('threading.Thread'), patch('os.close'), patch('os.waitpid', return_value=(123, 7 << 8)):
            self.assertEqual(agent['main'](), 7)
        close.assert_called_once_with('process_exited', 7)


unittest.main(verbosity=2)
