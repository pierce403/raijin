"""Exercise the generated script without spawning its shell or contacting a server."""
import ast
import io
import sys
import unittest
from unittest.mock import patch
import urllib.error
import http.client

source = ast.parse(sys.stdin.read())
# The last top-level try starts the agent; load only definitions for isolated tests.
assert isinstance(source.body[-1], ast.Try)
source.body.pop()
agent = {}
exec(compile(source, '<bootstrap>', 'exec'), agent)

class BootstrapTests(unittest.TestCase):
    def request(self):
        return agent['request_json']('POST', '/agent/test/out', {'data': 'IyA='}, timeout=10)

    def response(self):
        return io.BytesIO(b'{"ok":true}')

    def test_transient_errors_retry_identical_body(self):
        failures = [TimeoutError(), ConnectionResetError(), http.client.RemoteDisconnected(),
                    http.client.IncompleteRead(b'', 2), urllib.error.URLError('temporary'),
                    urllib.error.HTTPError('url', 503, 'unavailable', {}, None)]
        for failure in failures:
            with self.subTest(failure=type(failure)), patch('urllib.request.urlopen', side_effect=[failure, self.response()]) as send, patch('time.sleep') as sleep:
                self.assertEqual(self.request(), {'ok': True})
                self.assertEqual(send.call_count, 2)
                self.assertEqual(send.call_args_list[0].args[0].data, send.call_args_list[1].args[0].data)
                sleep.assert_called_once_with(0.5)

    def test_exhaustion_is_bounded(self):
        with patch('urllib.request.urlopen', side_effect=TimeoutError()) as send, patch('time.sleep') as sleep:
            with self.assertRaises(RuntimeError):
                self.request()
            self.assertEqual(send.call_count, 3)
            self.assertEqual([c.args[0] for c in sleep.call_args_list], [0.5, 1.0])

    def test_http_exhaustion_is_bounded(self):
        with patch('urllib.request.urlopen', side_effect=[urllib.error.HTTPError('url', 502, 'bad gateway', {}, None) for _ in range(3)]) as send, patch('time.sleep'):
            with self.assertRaises(RuntimeError):
                self.request()
            self.assertEqual(send.call_count, 3)

    def test_terminal_errors_do_not_retry(self):
        for code in [401, 403, 404, 410]:
            with self.subTest(code=code), patch('urllib.request.urlopen', side_effect=urllib.error.HTTPError('url', code, 'error', {}, None)) as send, patch('time.sleep') as sleep:
                with self.assertRaises(RuntimeError):
                    self.request()
                self.assertEqual(send.call_count, 1)
                sleep.assert_not_called()

    def test_409_preserves_contract(self):
        with patch('urllib.request.urlopen', side_effect=urllib.error.HTTPError('url', 409, 'waiting', {}, None)):
            self.assertEqual(self.request(), {'retry': True})

    def test_output_is_retained_across_409(self):
        agent['RUNNING'] = True
        agent['MASTER_FD'] = 42
        with patch('select.select', return_value=([42], [], [])), patch('os.read', side_effect=[b'# ', b'']), patch('time.sleep'), patch.dict(agent) as state:
            from unittest.mock import Mock
            state['request_json'] = Mock(side_effect=[{'retry': True}, {'ok': True}])
            state['close_remote'] = Mock()
            agent['read_and_forward']()
            calls = state['request_json'].call_args_list
            self.assertEqual(len(calls), 2)
            self.assertEqual(calls[0], calls[1])
            self.assertEqual(calls[0].args[2], {'data': 'IyA='})
            state['close_remote'].assert_called_once()

unittest.main()
