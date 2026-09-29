const WAIT_TIMEOUT_MS = 25_000;
const DEFAULT_IDLE_TIMEOUT_MS = 600_000;
const MIN_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 7_200_000;
const MAX_SWEEP_INTERVAL_MS = 3_600_000;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_INPUT_EVENTS = 1024;
const MAX_WAITERS = 16;
const MAX_OUTPUT_BYTES = 64 * 1024;

const encoder = new TextEncoder();

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status || 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...(init.headers || {}),
    },
  });
}

function readBearerToken(request) {
  const authorization = request.headers.get("authorization") || "";
  if (authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length);
  }
  return null;
}

function readClientIp(request) {
  const direct = request.headers.get("cf-connecting-ip") || request.headers.get("x-real-ip");
  if (direct) {
    return direct;
  }

  const forwarded = request.headers.get("x-forwarded-for");
  if (!forwarded) {
    return null;
  }

  return forwarded.split(",")[0].trim() || null;
}

function clampTimeout(value, fallback) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, value));
}

function parseOptionalTimeoutMs(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, value));
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  let binary = "";
  for (const byte of new Uint8Array(digest)) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export class SessionDurableObject {
  constructor() {
    this.browserSocket = null;
    this.browserTokenHash = null;
    this.agentTokenHash = null;
    this.mode = "interactive";
    this.command = "";
    this.readonly = false;
    this.createdAt = 0;
    this.idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
    this.maxLifetimeMs = null;
    this.initialized = false;
    this.agentConnectedAt = null;
    this.agentIp = null;
    this.lastActivityAt = 0;
    this.pendingEvents = [];
    this.waiters = [];
    this.status = "waiting_for_browser";
    this.endedAt = null;
    this.endCode = null;
    this.expiryTimer = null;
    this.epoch = null;
    this.agentProtocol = null;
    this.lastOutSeq = 0;
    this.lastInputSeq = 0;
    this.inputAck = 0;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === "/connect/browser" && request.method === "GET") {
      return this.handleBrowserConnect(request);
    }

    if (pathname === "/internal/end" && request.method === "POST") {
      return this.handleExplicitEnd(request);
    }

    if (pathname === "/agent/in" && request.method === "GET") {
      return this.handleAgentIn(request);
    }

    if (pathname === "/agent/out" && request.method === "POST") {
      return this.handleAgentOut(request);
    }

    if (pathname === "/agent/heartbeat" && request.method === "POST") {
      return this.handleAgentHeartbeat(request);
    }

    if (pathname === "/agent/close" && request.method === "POST") {
      return this.handleAgentClose(request);
    }

    return jsonResponse({ error: "Unknown session route." }, { status: 404 });
  }

  currentStatus() {
    if (this.endedAt) {
      return this.status;
    }

    const browserConnected = this.browserSocket && this.browserSocket.readyState === 1;
    if (browserConnected && this.agentConnectedAt) {
      return "connected";
    }
    if (browserConnected) {
      return "waiting_for_agent";
    }
    return "waiting_for_browser";
  }

  async checkExpiry() {
    if (!this.initialized || this.endedAt) {
      return;
    }

    const now = Date.now();
    const maxDeadline = Number.isFinite(this.maxLifetimeMs) ? this.createdAt + this.maxLifetimeMs : null;
    const idleDeadline = this.lastActivityAt + this.idleTimeoutMs;

    if ((maxDeadline !== null && now >= maxDeadline) || now >= idleDeadline) {
      await this.endSession("expired", { closeBrowser: true });
      return;
    }

    this.scheduleExpiryCheck();
  }

  clearExpiryTimer() {
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  scheduleExpiryCheck() {
    this.clearExpiryTimer();
    if (!this.initialized || this.endedAt) {
      return;
    }

    const now = Date.now();
    const maxDeadline = Number.isFinite(this.maxLifetimeMs) ? this.createdAt + this.maxLifetimeMs : null;
    const idleDeadline = this.lastActivityAt + this.idleTimeoutMs;
    const nextDeadline = maxDeadline === null
      ? idleDeadline
      : Math.min(maxDeadline, idleDeadline);
    const delay = Math.max(0, Math.min(nextDeadline - now, MAX_SWEEP_INTERVAL_MS));

    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      void this.checkExpiry();
    }, delay);
  }

  clearRuntimeState() {
    this.clearExpiryTimer();
    this.browserSocket = null;
    this.browserTokenHash = null;
    this.agentTokenHash = null;
    this.mode = "interactive";
    this.command = "";
    this.readonly = false;
    this.createdAt = 0;
    this.idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
    this.maxLifetimeMs = null;
    this.initialized = false;
    this.agentConnectedAt = null;
    this.agentIp = null;
    this.lastActivityAt = 0;
    this.pendingEvents = [];
    this.epoch = null;
    this.agentProtocol = null;
    this.lastOutSeq = 0;
    this.lastInputSeq = 0;
    this.inputAck = 0;
  }

  async handleBrowserConnect(request) {
    if (request.headers.get("upgrade") !== "websocket") {
      return jsonResponse({ error: "Expected websocket upgrade." }, { status: 426 });
    }

    if (this.endedAt) {
      return jsonResponse({ error: "Session is no longer active.", status: this.status }, { status: 410 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const helloTimer = setTimeout(() => {
      if (server.readyState === 1 && (!this.browserSocket || this.browserSocket !== server)) {
        server.close(1008, "hello required");
      }
    }, 5_000);

    server.addEventListener("message", (event) => {
      void this.handleBrowserMessage(server, event, helloTimer);
    });
    server.addEventListener("close", () => {
      void this.handleBrowserClose(server, helloTimer);
    });
    server.addEventListener("error", () => {
      clearTimeout(helloTimer);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  async handleBrowserMessage(server, event, helloTimer) {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    if (payload.type === "hello") {
      await this.handleBrowserHello(server, payload, helloTimer);
      return;
    }

    if (server !== this.browserSocket || !this.initialized || this.endedAt) {
      return;
    }

    await this.checkExpiry();
    if (server !== this.browserSocket || !this.initialized || this.endedAt) {
      return;
    }

    if (payload.type === "stdin" && typeof payload.data === "string" && !this.readonly) {
      if (!this.queueEvent({ type: "stdin", data: payload.data })) return;
      this.touchActivity();
      return;
    }

    if (
      payload.type === "resize"
      && Number.isInteger(payload.cols)
      && Number.isInteger(payload.rows)
      && payload.cols > 0
      && payload.rows > 0
    ) {
      if (!this.queueEvent({ type: "resize", cols: payload.cols, rows: payload.rows })) return;
      this.touchActivity();
      return;
    }

    if (payload.type === "ping") {
      this.sendStatus(server);
      return;
    }

    if (payload.type === "end") {
      await this.endSession("ended", { closeBrowser: true });
    }
  }

  async handleBrowserHello(server, payload, helloTimer) {
    if (typeof payload.browserToken !== "string" || !payload.browserToken) {
      server.close(1008, "browser token required");
      return;
    }

    const browserTokenHash = await sha256Base64Url(payload.browserToken);
    if (server.readyState !== 1) return;
    if (this.endedAt) {
      server.close(1000, "session ended");
      return;
    }
    if (this.browserTokenHash && this.browserTokenHash !== browserTokenHash) {
      server.close(1008, "invalid browser token");
      return;
    }

    if (!this.browserTokenHash) {
      this.browserTokenHash = browserTokenHash;
    }

    if (
      !this.initialized
      && (typeof payload.agentTokenHash !== "string" || !payload.agentTokenHash)
    ) {
      server.close(1008, "agent token hash required");
      return;
    }

    if (this.initialized && payload.agentTokenHash && payload.agentTokenHash !== this.agentTokenHash) {
      server.close(1008, "session metadata mismatch");
      return;
    }

    const previousSocket = this.browserSocket;
    this.browserSocket = server;

    if (previousSocket && previousSocket !== server && previousSocket.readyState === 1) {
      previousSocket.close(1000, "replaced");
    }
    clearTimeout(helloTimer);

    if (!this.initialized) {
      this.initialized = true;
      this.epoch = crypto.randomUUID();
      this.agentTokenHash = payload.agentTokenHash;
      this.mode = ["interactive", "command", "readonly"].includes(payload.mode) ? payload.mode : "interactive";
      this.command = typeof payload.command === "string" ? payload.command : "";
      this.readonly = Boolean(payload.readonly);
      this.createdAt = Number.isFinite(Number(payload.createdAt)) ? Number(payload.createdAt) : Date.now();
      this.idleTimeoutMs = clampTimeout(Number(payload.idleTimeoutSeconds) * 1000, DEFAULT_IDLE_TIMEOUT_MS);
      this.maxLifetimeMs = parseOptionalTimeoutMs(Number(payload.maxLifetimeSeconds) * 1000);
    }

    this.touchActivity();

    await this.checkExpiry();
    this.sendStatus(server);

    if (!this.agentConnectedAt && !this.endedAt && server === this.browserSocket && server.readyState === 1) {
      server.send(JSON.stringify({ type: "notice", message: "Waiting for remote agent..." }));
    }
  }

  async handleBrowserClose(server, helloTimer) {
    clearTimeout(helloTimer);

    // A replaced tab closing must not terminate the replacement's session.
    if (this.browserSocket !== server) return;
    this.browserSocket = null;

    if (!this.initialized || this.endedAt) {
      return;
    }

    if (this.agentConnectedAt) {
      await this.endSession("disconnected", { closeBrowser: false });
    }
  }

  async handleExplicitEnd(request) {
    if (this.endedAt) {
      return jsonResponse({ ok: true, status: this.status });
    }

    if (!this.browserTokenHash) {
      return jsonResponse({ error: "Session not initialized." }, { status: 404 });
    }

    const browserToken = readBearerToken(request);
    if (!browserToken || (await sha256Base64Url(browserToken)) !== this.browserTokenHash) {
      return jsonResponse({ error: "Unauthorized session access." }, { status: 403 });
    }

    await this.endSession("ended", { closeBrowser: true });
    return jsonResponse({ ok: true, status: this.status });
  }

  async authenticateAgentRequest(request) {
    const token = readBearerToken(request);
    if (!token) {
      return { ok: false, response: jsonResponse({ error: "Missing agent token." }, { status: 401 }) };
    }
    // An empty object cannot authenticate an old epoch. Reveal no prior session details.
    if (!this.initialized || !this.agentTokenHash) {
      if (this.endedAt) {
        return { ok: false, response: this.sessionEndedResponse() };
      }
      return { ok: false, response: request.headers.has("x-raijin-epoch")
        ? this.sessionResetResponse()
        : jsonResponse({ error: "Browser has not initialized this session yet." }, { status: 409 }) };
    }
    const tokenHash = this.agentTokenHash;
    const epoch = this.epoch;
    if ((await sha256Base64Url(token)) !== tokenHash) {
      return { ok: false, response: jsonResponse({ error: "Unauthorized agent token." }, { status: 403 }) };
    }
    const auth = { ok: true, tokenHash, epoch };
    let error = this.agentStateError(auth);
    if (error) return { ok: false, response: error };
    await this.checkExpiry();
    error = this.agentStateError(auth);
    if (error) return { ok: false, response: error };

    const header = request.headers.get("x-raijin-protocol");
    const protocol = header === null ? 1 : header === "2" ? 2 : null;
    if (!protocol || (this.agentProtocol !== null && protocol !== this.agentProtocol)) {
      return { ok: false, response: jsonResponse({ error: "Agent protocol mismatch.", code: "protocol_mismatch" }, { status: 400 }) };
    }
    const requestedEpoch = request.headers.get("x-raijin-epoch");
    if (requestedEpoch !== null && requestedEpoch !== this.epoch) {
      return { ok: false, response: this.sessionResetResponse() };
    }
    if (protocol === 2 && requestedEpoch === null && new URL(request.url).pathname !== "/agent/heartbeat") {
      return { ok: false, response: jsonResponse({ error: "Negotiate an epoch with a heartbeat first.", code: "missing_epoch" }, { status: 400 }) };
    }
    this.agentProtocol = protocol;
    return { ...auth, protocol };
  }

  sessionResetResponse() {
    return jsonResponse({ error: "Session state was reset. Start a new session.", code: "session_reset" }, { status: 410 });
  }

  sessionEndedResponse() {
    return jsonResponse({ error: "Session is no longer active.", status: this.status,
      ...(this.endCode ? { code: this.endCode } : {}) }, { status: 410 });
  }

  agentStateError(auth) {
    if (this.endedAt) {
      return this.sessionEndedResponse();
    }
    if (!this.initialized || this.epoch !== auth.epoch || this.agentTokenHash !== auth.tokenHash) {
      return this.sessionResetResponse();
    }
    return null;
  }

  updateAgentIdentity(request) {
    const nextIp = readClientIp(request);
    if (nextIp && nextIp !== this.agentIp) {
      this.agentIp = nextIp;
      return true;
    }
    return false;
  }

  markAgentConnected(request) {
    const ipChanged = this.updateAgentIdentity(request);
    if (!this.agentConnectedAt) {
      this.agentConnectedAt = Date.now();
      this.sendStatus();
      return;
    }

    if (ipChanged) {
      this.sendStatus();
    }
  }

  async handleAgentIn(request) {
    const auth = await this.authenticateAgentRequest(request);
    if (!auth.ok) {
      return auth.response;
    }
    const error = this.agentStateError(auth);
    if (error) return error;

    this.markAgentConnected(request);
    if (auth.protocol === 2) {
      const value = request.headers.get("x-raijin-input-ack") ?? "0";
      const ack = Number(value);
      if (!/^(0|[1-9]\d*)$/u.test(value) || !Number.isSafeInteger(ack) || ack > this.lastInputSeq) {
        return jsonResponse({ error: "Invalid input acknowledgment.", code: "invalid_ack" }, { status: 422 });
      }
      if (ack > this.inputAck) {
        this.inputAck = ack;
        this.pendingEvents = this.pendingEvents.filter(event => event.seq === undefined || event.seq > ack);
      }
    }

    const immediate = this.flushEvents();
    if (immediate) {
      return jsonResponse(immediate);
    }

    if (this.waiters.length >= MAX_WAITERS) {
      await this.endSession("ended", { closeBrowser: true, code: "too_many_polls", message: "Too many pending input polls. Session ended." });
      return this.sessionEndedResponse();
    }
    return new Promise((resolve) => {
      const waiter = {
        auth,
        resolve,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((entry) => entry !== waiter);
          void this.checkExpiry().then(() => {
            resolve(this.agentStateError(auth) || jsonResponse(this.flushEvents() || { events: [], status: this.currentStatus() }));
          });
        }, WAIT_TIMEOUT_MS),
      };

      this.waiters.push(waiter);
    });
  }

  async handleAgentOut(request) {
    const auth = await this.authenticateAgentRequest(request);
    if (!auth.ok) {
      return auth.response;
    }
    const initialError = this.agentStateError(auth);
    if (initialError) return initialError;

    this.markAgentConnected(request);
    const payload = await request.json().catch(() => ({}));
    const error = this.agentStateError(auth);
    if (error) return error;
    if (auth.protocol === 2) {
      if (!Number.isSafeInteger(payload?.seq) || payload.seq < 1 || typeof payload.data !== "string"
        || payload.data.length > 4 * Math.ceil(MAX_OUTPUT_BYTES / 3)) {
        return jsonResponse({ error: "Invalid output chunk.", code: "invalid_output" }, { status: 400 });
      }
      try {
        const decoded = atob(payload.data);
        if (decoded.length > MAX_OUTPUT_BYTES || btoa(decoded) !== payload.data) throw new Error("Invalid base64");
      } catch {
        return jsonResponse({ error: "Invalid output encoding.", code: "invalid_output" }, { status: 400 });
      }
      // No await between checking, forwarding, and advancing the accepted sequence.
      if (payload.seq <= this.lastOutSeq) return jsonResponse({ ok: true, ack: this.lastOutSeq });
      if (payload.seq !== this.lastOutSeq + 1) {
        return jsonResponse({ error: "Output sequence gap.", code: "sequence_gap", expected: this.lastOutSeq + 1 }, { status: 422 });
      }
      if (!this.browserSocket || this.browserSocket.readyState !== 1) {
        return jsonResponse({ error: "Waiting for the browser to attach." }, { status: 409 });
      }
      this.browserSocket.send(JSON.stringify({ type: "output", data: payload.data }));
      this.lastOutSeq = payload.seq;
      this.touchActivity();
      return jsonResponse({ ok: true, ack: this.lastOutSeq });
    }
    if (payload?.data && this.browserSocket && this.browserSocket.readyState === 1) {
      this.browserSocket.send(JSON.stringify({ type: "output", data: payload.data }));
    }

    this.touchActivity();
    return jsonResponse({ ok: true });
  }

  async handleAgentHeartbeat(request) {
    const auth = await this.authenticateAgentRequest(request);
    if (!auth.ok) {
      return auth.response;
    }
    const error = this.agentStateError(auth);
    if (error) return error;

    this.markAgentConnected(request);
    return jsonResponse({ ok: true, browserConnected: this.browserSocket?.readyState === 1,
      ...(auth.protocol === 2 ? { protocol: 2, epoch: this.epoch } : {}) });
  }

  async handleAgentClose(request) {
    const auth = await this.authenticateAgentRequest(request);
    if (!auth.ok) {
      return auth.response;
    }

    const payload = await request.json().catch(() => ({}));
    const error = this.agentStateError(auth);
    if (error) return error;
    if (!this.endedAt) {
      await this.endSession("agent_closed", { closeBrowser: true, message: payload.reason });
    }
    return jsonResponse({ ok: true });
  }

  touchActivity() {
    this.lastActivityAt = Date.now();
    this.scheduleExpiryCheck();
  }

  queueEvent(event) {
    if (event.type === "resize" && this.agentProtocol === 1) {
      this.pendingEvents = this.pendingEvents.filter((entry) => entry.type !== "resize");
    }

    if (event.type === "stdin") {
      const lastEvent = this.pendingEvents.at(-1);
      if (lastEvent?.type === "stdin" && lastEvent.seq === undefined) {
        lastEvent.data += event.data;
      } else {
        this.pendingEvents.push(event);
      }
    } else {
      this.pendingEvents.push(event);
    }

    const bytes = this.pendingEvents.reduce((total, entry) => total + (entry.type === "stdin" ? encoder.encode(entry.data).byteLength : 16), 0);
    if (this.pendingEvents.length > MAX_INPUT_EVENTS || bytes > MAX_INPUT_BYTES) {
      void this.endSession("ended", { closeBrowser: true, code: "input_overflow", message: "Input buffer limit exceeded. Session ended." });
      return false;
    }

    this.flushWaiters();
    return true;
  }

  flushEvents() {
    if (this.endedAt) {
      return {
        events: [{ type: "terminate", reason: this.status }],
        status: this.status,
      };
    }

    if (this.pendingEvents.length === 0) {
      return null;
    }

    if (this.agentProtocol === 2) {
      for (const event of this.pendingEvents) {
        if (event.seq === undefined) event.seq = ++this.lastInputSeq;
      }
      return { events: this.pendingEvents.map(event => ({ ...event })), status: this.currentStatus() };
    }
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return { events, status: this.currentStatus() };
  }

  flushWaiters() {
    if (this.waiters.length === 0) {
      return;
    }

    const payload = this.flushEvents();
    if (!payload) {
      return;
    }

    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(waiter.auth.protocol === 2 && this.endedAt
        ? this.agentStateError(waiter.auth)
        : jsonResponse(payload));
    }
    this.waiters = [];
  }

  sendStatus(socket = this.browserSocket) {
    if (!socket || socket.readyState !== 1) {
      return;
    }
    socket.send(JSON.stringify({
      type: "status",
      status: this.currentStatus(),
      remoteIp: this.agentIp,
      connectedAt: this.agentConnectedAt,
    }));
  }

  async endSession(reason, options = {}) {
    if (this.endedAt) {
      return;
    }

    this.status = reason;
    this.endCode = options.code || null;
    this.endedAt = Date.now();
    this.pendingEvents = [];
    this.flushWaiters();

    if (this.browserSocket && this.browserSocket.readyState === 1) {
      this.browserSocket.send(JSON.stringify({
        type: "status",
        status: reason,
        remoteIp: this.agentIp,
        connectedAt: this.agentConnectedAt,
      }));
      if (options.message) {
        this.browserSocket.send(JSON.stringify({ type: "notice", message: options.message }));
      }
      if (options.closeBrowser) {
        this.browserSocket.close(1000, reason);
      }
    }

    this.clearRuntimeState();
  }
}
