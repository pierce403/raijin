import { SessionDurableObject } from "./session-do.js";
import { LauncherDurableObject } from "./launcher-do.js";

export { SessionDurableObject, LauncherDurableObject };

const DEFAULT_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

const CSP_HEADER = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

const decoder = new TextDecoder();

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      if (error instanceof Response) {
        return error;
      }

      console.error(error);
      return jsonResponse(
        { error: error instanceof Error ? error.message : "Internal server error." },
        { status: 500 },
      );
    }
  },
};

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status || 200,
    headers: {
      ...DEFAULT_HEADERS,
      ...(init.headers || {}),
    },
  });
}

function htmlHeaders(extra = {}) {
  return {
    "cache-control": "no-store",
    "content-security-policy": CSP_HEADER,
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "clipboard-read=(self), clipboard-write=(self)",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    ...extra,
  };
}

function decodeBase64Url(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const binary = atob(`${normalized}${padding}`);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function isAllowedMode(mode) {
  return ["interactive", "command", "readonly"].includes(mode);
}

function getSessionIdFromPath(pathname, prefix) {
  const suffix = pathname.slice(prefix.length);
  return decodeURIComponent(suffix.split("/")[0] || "");
}

function buildBaseUrl(request) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function assertBrowserOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) {
    return;
  }

  const requestUrl = new URL(request.url);
  const expectedOrigin = `${requestUrl.protocol}//${requestUrl.host}`;
  if (origin !== expectedOrigin) {
    throw new Response(JSON.stringify({ error: "Origin not allowed." }), {
      status: 403,
      headers: DEFAULT_HEADERS,
    });
  }
}

async function readRunBody(request, limit = 1024) {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw jsonResponse({ error: "Request body too large." }, { status: 413 });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

async function forwardToSession(env, sessionId, path, init) {
  const id = env.SESSIONS.idFromName(sessionId);
  const stub = env.SESSIONS.get(id);
  return stub.fetch(`https://session${path}`, init);
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;

  if (pathname === "/api/sessions" && request.method === "POST") {
    return jsonResponse(
      { error: "Sessions are browser-generated in this build. Use the web UI to create one." },
      { status: 410 },
    );
  }

  if (pathname.startsWith("/api/sessions/") && pathname.endsWith("/end") && request.method === "POST") {
    return handleEndSession(request, env, pathname);
  }

  if (pathname.startsWith("/bootstrap") && request.method === "GET") {
    return handleBootstrap(request);
  }

  const listenerMatch = pathname.match(/^\/connect\/launcher\/([A-Za-z0-9_-]+)$/u);
  const runMatch = pathname.match(/^\/api\/launchers\/([A-Za-z0-9_-]+)\/runs$/u);
  if (listenerMatch && request.method === "GET") {
    assertBrowserOrigin(request);
    return env.LAUNCHERS.get(env.LAUNCHERS.idFromName(listenerMatch[1])).fetch(`https://launcher/connect?id=${listenerMatch[1]}`, {
      method: "GET", headers: request.headers,
    });
  }
  if (runMatch && request.method === "POST") {
    return env.LAUNCHERS.get(env.LAUNCHERS.idFromName(runMatch[1])).fetch("https://launcher/runs", {
      method: "POST", headers: request.headers, body: await readRunBody(request),
    });
  }
  if (/^\/l\/[^/]+$/u.test(pathname)) {
    return serveAssetHtml(env, request, "/launcher.html");
  }

  if (pathname.startsWith("/connect/browser/") && request.method === "GET") {
    return handleBrowserConnect(request, env, pathname);
  }

  if (pathname.startsWith("/agent/")) {
    return handleAgentRequest(request, env, pathname);
  }

  if (pathname === "/" || pathname === "/index.html") {
    return serveAssetHtml(env, request, "/index.html");
  }

  if (pathname === "/og-preview" || pathname === "/og-preview.html") {
    return serveAssetHtml(env, request, "/og-preview.html");
  }

  if (/^\/s\/[^/]+$/u.test(pathname)) {
    return serveAssetHtml(env, request, "/session.html");
  }

  return env.ASSETS.fetch(request);
}

async function serveAssetHtml(env, request, assetPath) {
  const assetRequest = new Request(new URL(assetPath, request.url), request);
  let response = await env.ASSETS.fetch(assetRequest);

  if (
    response.status >= 300
    && response.status < 400
    && response.headers.has("location")
  ) {
    const redirectedUrl = new URL(response.headers.get("location"), request.url);
    response = await env.ASSETS.fetch(new Request(redirectedUrl, request));
  }

  const headers = new Headers(response.headers);
  const securityHeaders = htmlHeaders(assetPath === "/session.html" ? {
    // xterm's DOM renderer generates style elements for its fixed-width grid
    // and style attributes for ANSI colors. Allow both only on terminal pages.
    "content-security-policy": CSP_HEADER
      .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
      .replace("frame-ancestors 'none'", "frame-ancestors 'self'"),
  } : {});
  for (const [key, value] of Object.entries(securityHeaders)) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

function parseBootstrapConfig(request) {
  const encoded = new URL(request.url).searchParams.get("c");
  if (!encoded) {
    throw new Response(JSON.stringify({ error: "Missing bootstrap config." }), {
      status: 400,
      headers: DEFAULT_HEADERS,
    });
  }

  let config;
  try {
    config = JSON.parse(decoder.decode(decodeBase64Url(encoded)));
  } catch {
    throw new Response(JSON.stringify({ error: "Invalid bootstrap config." }), {
      status: 400,
      headers: DEFAULT_HEADERS,
    });
  }

  if (
    !config
    || typeof config.baseUrl !== "string"
    || typeof config.sessionId !== "string"
    || typeof config.token !== "string"
    || !isAllowedMode(config.mode)
  ) {
    throw new Response(JSON.stringify({ error: "Incomplete bootstrap config." }), {
      status: 400,
      headers: DEFAULT_HEADERS,
    });
  }

  return {
    reusable: config.reusable === true,
    baseUrl: config.baseUrl,
    sessionId: config.sessionId,
    token: config.token,
    mode: config.mode,
    command: typeof config.command === "string" ? config.command : "",
    readonly: Boolean(config.readonly),
    idleTimeoutSeconds: Number(config.idleTimeoutSeconds || 600),
    maxLifetimeSeconds: config.maxLifetimeSeconds != null
      && Number.isFinite(Number(config.maxLifetimeSeconds))
      && Number(config.maxLifetimeSeconds) > 0
      ? Number(config.maxLifetimeSeconds)
      : null,
  };
}

function handleBootstrap(request) {
  const config = parseBootstrapConfig(request);
  return new Response(buildBootstrapScript(config), {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/x-python; charset=utf-8",
    },
  });
}

async function handleBrowserConnect(request, env, pathname) {
  assertBrowserOrigin(request);
  const sessionId = pathname.slice("/connect/browser/".length);
  return forwardToSession(
    env,
    sessionId,
    "/connect/browser",
    {
      method: "GET",
      headers: request.headers,
    },
  );
}

async function handleAgentRequest(request, env, pathname) {
  const [, , sessionId, action] = pathname.split("/");
  if (!["in", "out", "heartbeat", "close"].includes(action)) {
    return jsonResponse({ error: "Unknown agent route." }, { status: 404 });
  }

  const headers = new Headers(request.headers);
  const body = request.method === "GET" ? undefined : await readRunBody(request, action === "out" ? 16384 : 4096);

  return forwardToSession(
    env,
    sessionId,
    `/agent/${action}`,
    {
      method: request.method,
      headers,
      body,
    },
  );
}

async function handleEndSession(request, env, pathname) {
  assertBrowserOrigin(request);
  const sessionId = getSessionIdFromPath(pathname, "/api/sessions/");
  const headers = new Headers(request.headers);

  const response = await forwardToSession(
    env,
    sessionId,
    "/internal/end",
    {
      method: "POST",
      headers,
      body: "",
    },
  );

  const payload = await response.json().catch(() => ({}));
  return jsonResponse(payload, { status: response.status });
}

function buildBootstrapScript(config) {
  const bootstrapConfig = JSON.stringify(JSON.stringify(config));
  return `#!/usr/bin/env python3
import base64
import email.utils
import errno
import fcntl
import http.client
import json
import os
import pty
import re
import select
import secrets
import sys
import signal
import struct
import threading
import time
import urllib.error
import urllib.request
import termios

CONFIG = json.loads(${bootstrapConfig})
VERSION = "2026-09-29.1"
BASE_URL = CONFIG["baseUrl"].rstrip("/")
SESSION_ID = CONFIG["sessionId"]
TOKEN = CONFIG["token"]
MODE = CONFIG["mode"]
COMMAND = CONFIG.get("command", "")
READONLY = bool(CONFIG.get("readonly"))
HEARTBEAT_INTERVAL = 15
POLL_TIMEOUT = 30
MAX_ATTEMPTS = 5
REQUEST_BUDGET = 90
RUNNING = True
CHILD_PID = None
MASTER_FD = None
CHILD_EXIT_CODE = None
SESSION_EPOCH = None
INPUT_ACK = 0
OUTPUT_SEQ = 1
OUTCOME = None
OUTCOME_LOCK = threading.Lock()
STOP_EVENT = threading.Event()
REQUEST_HEADERS = {
    "Authorization": "Bearer " + TOKEN,
    "Content-Type": "application/json",
    "User-Agent": "raijin-agent/" + VERSION,
    "X-Raijin-Protocol": "2",
}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

# Keep proxy environment support, but never send credentials to a redirect target.
HTTP = urllib.request.build_opener(NoRedirect())

class RelayFailure(Exception):
    def __init__(self, reason, exit_code, details=None):
        super().__init__(reason)
        self.reason = reason
        self.exit_code = exit_code
        self.details = details or {}

def safe_field(value, limit=128):
    return re.sub(r"[^A-Za-z0-9_./:-]", "_", str(value))[:limit]

def diagnostic(event, **details):
    fields = {"version": VERSION, "runId": safe_field(SESSION_ID), "event": event}
    fields.update(details)
    print("raijin: " + json.dumps(fields, separators=(",", ":")), file=sys.stderr, flush=True)

def request_details(method, path, attempt, status=None, headers=None):
    details = {"method": safe_field(method), "path": safe_field(path.split("?", 1)[0].split("#", 1)[0], 256),
               "attempt": attempt, "maxAttempts": MAX_ATTEMPTS}
    if status is not None:
        details["status"] = status
    ray = (headers or {}).get("CF-Ray", "")
    if re.fullmatch(r"[A-Za-z0-9_-]{1,80}", ray):
        details["ray"] = ray
    return details

def retry_after(headers):
    value = (headers or {}).get("Retry-After", "")
    if not value:
        return 0
    try:
        if value.strip().isdigit():
            return int(value.strip())
        date = email.utils.parsedate_to_datetime(value)
        return max(0, date.timestamp() - time.time())
    except (ValueError, TypeError, OverflowError):
        return 0

def terminal_http_failure(status, body, details):
    if status in (401, 403):
        return RelayFailure("authorization_rejected", 5, details)
    if status == 410:
        if body.get("code") == "session_reset":
            return RelayFailure("session_reset", 4, details)
        if body.get("code") in ("input_overflow", "too_many_polls"):
            return RelayFailure(body["code"], 8, details)
        if body.get("status") == "expired":
            return RelayFailure("session_expired", 3, details)
        if body.get("status") in ("ended", "disconnected"):
            return RelayFailure("browser_closed", 0, details)
        return RelayFailure("session_ended", 4, details)
    return RelayFailure("http_rejected", 9, details)

def request_json(method, path, payload=None, timeout=POLL_TIMEOUT, deadline=None, quiet=False):
    deadline = min(deadline if deadline is not None else float("inf"), time.monotonic() + REQUEST_BUDGET)
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = dict(REQUEST_HEADERS)
    if SESSION_EPOCH:
        headers["X-Raijin-Epoch"] = SESSION_EPOCH
    if path.endswith("/in"):
        headers["X-Raijin-Input-Ack"] = str(INPUT_ACK)
    req = urllib.request.Request(BASE_URL + path, data=data, method=method, headers=headers)
    for attempt in range(1, MAX_ATTEMPTS + 1):
        if not quiet and STOP_EVENT.is_set():
            raise OUTCOME or RelayFailure("stopped", 0)
        remaining = deadline - time.monotonic()
        details = request_details(method, path, attempt)
        if remaining <= 0:
            raise RelayFailure("request_deadline", 6, details)
        retry_delay = 0
        reason = "transport_exhausted"
        try:
            with HTTP.open(req, timeout=min(timeout, remaining)) as response:
                body = response.read(4 * 1024 * 1024 + 1)
                details = request_details(method, path, attempt, response.status, response.headers)
                if len(body) > 4 * 1024 * 1024:
                    raise ValueError("response too large")
                parsed = json.loads(body.decode("utf-8"))
                if not isinstance(parsed, dict):
                    raise ValueError("response is not an object")
                if time.monotonic() >= deadline:
                    raise RelayFailure("request_deadline", 6, details)
                return parsed
        except urllib.error.HTTPError as error:
            status = error.code
            details = request_details(method, path, attempt, status, error.headers)
            retry_delay = retry_after(error.headers)
            error_body = {}
            try:
                parsed = json.loads(error.read(65536).decode("utf-8"))
                if isinstance(parsed, dict):
                    error_body = parsed
            except (ValueError, OSError, http.client.HTTPException):
                pass
            finally:
                error.close()
            if status == 409 and not SESSION_EPOCH:
                return {"retry": True}
            retryable = status in (301, 302, 303, 307, 308, 409, 429) or 500 <= status < 600
            if not retryable:
                raise terminal_http_failure(status, error_body, details) from None
            reason = "rate_limited" if status == 429 else "session_not_ready" if status == 409 else "http_exhausted"
        except (urllib.error.URLError, OSError, http.client.HTTPException) as error:
            details["errorType"] = safe_field(type(error).__name__)
            reason = "transport_exhausted"
        except (ValueError, UnicodeError):
            reason = "invalid_response"
        delay = max(retry_delay, 0.5 * (2 ** (attempt - 1)) + secrets.randbelow(101) / 1000)
        if attempt == MAX_ATTEMPTS or time.monotonic() + delay >= deadline:
            raise RelayFailure(reason, 6, details) from None
        if not quiet and OUTCOME is None:
            diagnostic("retry", reason=reason, delay=round(delay, 3), **details)
        if quiet:
            time.sleep(delay)
        else:
            STOP_EVENT.wait(delay)

def register_run():
    global SESSION_ID, TOKEN, SESSION_EPOCH
    started = time.monotonic()
    deadline = started + 300
    if CONFIG.get("reusable"):
        SESSION_ID = secrets.token_urlsafe(24)
        run_token = secrets.token_urlsafe(32)
        diagnostic("waiting_for_listener")
        while time.monotonic() < deadline:
            result = request_json("POST", f"/api/launchers/{CONFIG['sessionId']}/runs",
                                  {"runId": SESSION_ID, "agentToken": run_token}, timeout=10, deadline=deadline)
            if not result.get("retry"):
                break
            time.sleep(min(1, max(0, deadline - time.monotonic())))
        else:
            raise RelayFailure("listener_timeout", 10, {"gate": "listener", "elapsed": round(time.monotonic() - started, 3)})
        TOKEN = run_token
        REQUEST_HEADERS["Authorization"] = "Bearer " + TOKEN
    diagnostic("waiting_for_browser")
    # Both reusable and older commands must negotiate before starting a shell.
    while time.monotonic() < deadline:
        result = request_json("POST", f"/agent/{SESSION_ID}/heartbeat", {}, timeout=10, deadline=deadline)
        if result.get("browserConnected"):
            epoch = result.get("epoch")
            if result.get("protocol") != 2 or not isinstance(epoch, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", epoch):
                raise RelayFailure("protocol_unavailable", 8)
            SESSION_EPOCH = epoch
            diagnostic("terminal_connected")
            return
        time.sleep(min(1, max(0, deadline - time.monotonic())))
    raise RelayFailure("browser_timeout", 10, {"gate": "browser", "elapsed": round(time.monotonic() - started, 3)})

def kill_child(graceful=True):
    global RUNNING
    RUNNING = False
    STOP_EVENT.set()
    if not CHILD_PID:
        return
    try:
        os.killpg(CHILD_PID, signal.SIGTERM if graceful else signal.SIGKILL)
    except OSError:
        try:
            os.kill(CHILD_PID, signal.SIGTERM if graceful else signal.SIGKILL)
        except OSError:
            pass

def finish(failure):
    global OUTCOME
    with OUTCOME_LOCK:
        if OUTCOME is not None:
            return
        OUTCOME = failure
        diagnostic("exit", reason=failure.reason, exitCode=failure.exit_code, **failure.details)
    kill_child()

def heartbeat_loop():
    while not STOP_EVENT.wait(HEARTBEAT_INTERVAL):
        try:
            request_json("POST", f"/agent/{SESSION_ID}/heartbeat", {})
        except RelayFailure as error:
            finish(error)
            return
        except Exception:
            finish(RelayFailure("local_agent_failure", 7))
            return

def apply_events(events):
    global INPUT_ACK
    if not isinstance(events, list):
        raise RelayFailure("invalid_input_sequence", 8)
    for event in events:
        if not RUNNING:
            return
        if not isinstance(event, dict):
            raise RelayFailure("invalid_input_sequence", 8)
        seq = event.get("seq")
        if not isinstance(seq, int) or isinstance(seq, bool) or not (1 <= seq <= 9007199254740991):
            raise RelayFailure("invalid_input_sequence", 8)
        if seq <= INPUT_ACK:
            continue
        if seq != INPUT_ACK + 1:
            raise RelayFailure("input_sequence_gap", 8)
        if event.get("type") == "stdin":
            if not READONLY:
                data = event.get("data")
                if not isinstance(data, str):
                    raise RelayFailure("invalid_input_event", 8)
                pending = memoryview(data.encode("utf-8"))
                while pending:
                    if not RUNNING:
                        return
                    try:
                        written = os.write(MASTER_FD, pending)
                    except InterruptedError:
                        continue
                    if written <= 0:
                        raise OSError("PTY write made no progress")
                    pending = pending[written:]
        elif event.get("type") == "resize":
            rows, cols = event.get("rows"), event.get("cols")
            if not isinstance(rows, int) or not isinstance(cols, int) or not (1 <= rows <= 65535 and 1 <= cols <= 65535):
                raise RelayFailure("invalid_resize", 8)
            fcntl.ioctl(MASTER_FD, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        else:
            raise RelayFailure("invalid_input_event", 8)
        # Advance only after the complete write or resize has been applied locally.
        INPUT_ACK = seq

def event_loop():
    while RUNNING:
        try:
            payload = request_json("GET", f"/agent/{SESSION_ID}/in", timeout=POLL_TIMEOUT)
            if not RUNNING:
                return
            apply_events(payload.get("events", []))
        except RelayFailure as error:
            finish(error)
            return
        except Exception:
            finish(RelayFailure("local_pty_failure", 7))
            return

def spawn_process():
    env = os.environ.copy()
    env.setdefault("TERM", "xterm-256color")
    pid, fd = pty.fork()
    if pid == 0:
        if MODE == "command":
            os.execvpe("/bin/sh", ["/bin/sh", "-lc", COMMAND], env)
        os.execvpe("/bin/sh", ["/bin/sh", "-li"], env)
    return pid, fd

def close_remote(reason, exit_code=None):
    payload = {"reason": reason}
    if exit_code is not None:
        payload["exitCode"] = exit_code
    try:
        request_json("POST", f"/agent/{SESSION_ID}/close", payload, timeout=5,
                     deadline=time.monotonic() + 5, quiet=True)
    except Exception:
        pass

def send_output(chunk):
    global OUTPUT_SEQ
    deadline = time.monotonic() + REQUEST_BUDGET
    packet = {"seq": OUTPUT_SEQ, "data": base64.b64encode(chunk).decode("ascii")}
    while RUNNING:
        payload = request_json("POST", f"/agent/{SESSION_ID}/out", packet, timeout=10, deadline=deadline)
        if payload.get("retry"):
            if time.monotonic() + 1 >= deadline:
                raise RelayFailure("session_not_ready", 6)
            time.sleep(1)
            continue
        ack = payload.get("ack")
        if not isinstance(ack, int) or isinstance(ack, bool) or ack < OUTPUT_SEQ:
            raise RelayFailure("invalid_output_ack", 8)
        OUTPUT_SEQ += 1
        return

def child_exit(block=False):
    global CHILD_EXIT_CODE
    if CHILD_EXIT_CODE is not None or CHILD_PID is None:
        return CHILD_EXIT_CODE
    try:
        waited_pid, status = os.waitpid(CHILD_PID, 0 if block else os.WNOHANG)
    except ChildProcessError:
        return CHILD_EXIT_CODE
    if waited_pid == CHILD_PID:
        CHILD_EXIT_CODE = os.waitstatus_to_exitcode(status)
    return CHILD_EXIT_CODE

def read_and_forward():
    while RUNNING:
        readable, _, _ = select.select([MASTER_FD], [], [], 0.25)
        if MASTER_FD not in readable:
            exit_code = child_exit()
            if exit_code is not None:
                return exit_code
            continue
        try:
            chunk = os.read(MASTER_FD, 4096)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            chunk = b""
        if not chunk:
            # PTY EOF can precede waitpid readiness by a few milliseconds.
            deadline = time.monotonic() + 0.5
            while child_exit() is None and time.monotonic() < deadline:
                time.sleep(0.01)
            if CHILD_EXIT_CODE is None:
                kill_child(graceful=False)
                child_exit(block=True)
            return CHILD_EXIT_CODE if CHILD_EXIT_CODE is not None else 7
        send_output(chunk)
    return 0

def main():
    global CHILD_PID, MASTER_FD
    try:
        register_run()
        CHILD_PID, MASTER_FD = spawn_process()
        threading.Thread(target=heartbeat_loop, daemon=True).start()
        threading.Thread(target=event_loop, daemon=True).start()
        exit_code = read_and_forward()
        finish(RelayFailure("process_exited", exit_code if exit_code >= 0 else 128 - exit_code))
    except RelayFailure as error:
        finish(error)
    except KeyboardInterrupt:
        finish(RelayFailure("operator_interrupted", 130))
    except Exception:
        finish(RelayFailure("local_pty_failure", 7))
    finally:
        if SESSION_EPOCH and OUTCOME:
            close_remote(OUTCOME.reason, OUTCOME.exit_code)
        kill_child(graceful=False)
        child_exit(block=True)
        if MASTER_FD is not None:
            os.close(MASTER_FD)
    return OUTCOME.exit_code if OUTCOME else 7

if __name__ == "__main__":
    sys.exit(main())
`;
}
