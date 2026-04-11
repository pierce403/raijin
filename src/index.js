import { SessionDurableObject } from "./session-do.js";

export { SessionDurableObject };

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
    "permissions-policy": "clipboard-write=(self)",
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
  for (const [key, value] of Object.entries(htmlHeaders())) {
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
    baseUrl: config.baseUrl,
    sessionId: config.sessionId,
    token: config.token,
    mode: config.mode,
    command: typeof config.command === "string" ? config.command : "",
    readonly: Boolean(config.readonly),
    idleTimeoutSeconds: Number(config.idleTimeoutSeconds || 600),
    maxLifetimeSeconds: Number.isFinite(Number(config.maxLifetimeSeconds))
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
  const body = request.method === "GET" ? undefined : await request.text();

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
import fcntl
import json
import os
import pty
import select
import signal
import struct
import threading
import time
import urllib.error
import urllib.request
import termios

CONFIG = json.loads(${bootstrapConfig})
BASE_URL = CONFIG["baseUrl"]
SESSION_ID = CONFIG["sessionId"]
TOKEN = CONFIG["token"]
MODE = CONFIG["mode"]
COMMAND = CONFIG.get("command", "")
READONLY = bool(CONFIG.get("readonly"))
USER_AGENT = "raijin-agent/0.1 (+" + BASE_URL + ")"
HEARTBEAT_INTERVAL = 15
POLL_TIMEOUT = 30
RUNNING = True
CHILD_PID = None
MASTER_FD = None
REQUEST_HEADERS = {
    "Authorization": "Bearer " + TOKEN,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
}

def request_json(method, path, payload=None, timeout=POLL_TIMEOUT):
    url = BASE_URL + path
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method, headers=REQUEST_HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            body = response.read()
            if not body:
                return {}
            return json.loads(body.decode("utf-8"))
    except urllib.error.HTTPError as error:
        if error.code == 409:
            return {"retry": True}
        body = error.read().decode("utf-8", "replace")
        raise RuntimeError(f"{method} {path} failed with {error.code}: {body}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"{method} {path} failed: {error}") from error

def kill_child(graceful=True):
    global RUNNING
    RUNNING = False
    if not CHILD_PID:
        return
    try:
        os.killpg(CHILD_PID, signal.SIGTERM if graceful else signal.SIGKILL)
    except OSError:
        try:
            os.kill(CHILD_PID, signal.SIGTERM if graceful else signal.SIGKILL)
        except OSError:
            return

def heartbeat_loop():
    while RUNNING:
        time.sleep(HEARTBEAT_INTERVAL)
        if not RUNNING:
            return
        try:
            payload = request_json("POST", f"/agent/{SESSION_ID}/heartbeat", {})
            if payload.get("retry"):
                continue
        except Exception:
            kill_child()
            return

def event_loop():
    while RUNNING:
        try:
            payload = request_json("GET", f"/agent/{SESSION_ID}/in", timeout=POLL_TIMEOUT)
        except Exception:
            kill_child()
            return
        if payload.get("retry"):
            time.sleep(1)
            continue
        for event in payload.get("events", []):
            if event.get("type") == "stdin" and not READONLY:
                os.write(MASTER_FD, event.get("data", "").encode("utf-8", "ignore"))
            elif event.get("type") == "resize":
                rows = int(event.get("rows", 24))
                cols = int(event.get("cols", 80))
                packed = struct.pack("HHHH", rows, cols, 0, 0)
                fcntl.ioctl(MASTER_FD, termios.TIOCSWINSZ, packed)
            elif event.get("type") == "terminate":
                kill_child()
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
        request_json("POST", f"/agent/{SESSION_ID}/close", payload, timeout=5)
    except Exception:
        pass

def read_and_forward():
    exit_code = 0
    try:
        while RUNNING:
            readable, _, _ = select.select([MASTER_FD], [], [], 0.25)
            if MASTER_FD not in readable:
                waited_pid, status = os.waitpid(CHILD_PID, os.WNOHANG)
                if waited_pid == CHILD_PID:
                    exit_code = os.waitstatus_to_exitcode(status)
                    break
                continue
            try:
                chunk = os.read(MASTER_FD, 4096)
            except OSError:
                break
            if not chunk:
                break
            payload = request_json(
                "POST",
                f"/agent/{SESSION_ID}/out",
                {"data": base64.b64encode(chunk).decode("ascii")},
                timeout=10,
            )
            if payload.get("retry"):
                time.sleep(1)
    finally:
        close_remote("process exited", exit_code)

try:
    CHILD_PID, MASTER_FD = spawn_process()
    threading.Thread(target=heartbeat_loop, daemon=True).start()
    threading.Thread(target=event_loop, daemon=True).start()
    read_and_forward()
finally:
    kill_child(graceful=False)
`;
}
