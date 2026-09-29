// One in-memory listener per reusable command. Terminal sessions use separate DOs.
const MAX_RUNS = 100;
const RUN_TTL_MS = 10 * 60_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/u;

function json(payload, status = 200) {
  return Response.json(payload, { status, headers: { "cache-control": "no-store" } });
}

async function hash(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export class LauncherDurableObject {
  constructor() {
    this.socket = null;
    this.browserTokenHash = null;
    this.agentTokenHash = null;
    this.runs = new Map();
    this.cleanupTimer = null;
  }

  pruneRuns() {
    for (const [id, run] of this.runs) {
      if (Date.now() - run.createdAt >= RUN_TTL_MS) this.runs.delete(id);
    }
  }

  sendRun(run) {
    this.socket.send(JSON.stringify({ type: "run", runId: run.runId, agentToken: run.agentToken }));
  }

  async hello(socket, message, timer, listenerId) {
    if (message.type !== "hello" || !TOKEN_PATTERN.test(message.browserToken || "")
      || !TOKEN_PATTERN.test(message.agentTokenHash || "")) {
      socket.close(1008, "invalid listener hello");
      return;
    }
    const browserHash = await hash(message.browserToken);
    if (socket.readyState !== 1) return;
    if (browserHash !== listenerId) { socket.close(1008, "invalid listener identity"); return; }
    if ((this.browserTokenHash && browserHash !== this.browserTokenHash)
      || (this.agentTokenHash && message.agentTokenHash !== this.agentTokenHash)) {
      socket.close(1008, "invalid listener credentials");
      return;
    }
    this.browserTokenHash = browserHash;
    this.agentTokenHash = message.agentTokenHash;
    const previous = this.socket;
    this.socket = socket;
    clearTimeout(timer);
    clearTimeout(this.cleanupTimer);
    if (previous && previous !== socket && previous.readyState === 1) {
      previous.close(1008, "listener opened elsewhere");
    }
    this.pruneRuns();
    socket.send(JSON.stringify({ type: "ready" }));
    for (const run of this.runs.values()) this.sendRun(run);
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/connect" && request.method === "GET") {
      if (request.headers.get("upgrade") !== "websocket") return json({ error: "Expected websocket upgrade." }, 426);
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      const timer = setTimeout(() => {
        if (server !== this.socket && server.readyState === 1) server.close(1008, "hello required");
      }, 5000);
      server.addEventListener("message", event => {
        void (async () => {
          try {
            const message = JSON.parse(event.data);
            if (message.type === "ping" && server === this.socket) return;
            await this.hello(server, message, timer, new URL(request.url).searchParams.get("id"));
          } catch {
            server.close(1008, "invalid listener message");
          }
        })();
      });
      server.addEventListener("close", () => {
        clearTimeout(timer);
        if (this.socket !== server) return;
        this.socket = null;
        this.cleanupTimer = setTimeout(() => {
          this.runs.clear();
          this.browserTokenHash = null;
          this.agentTokenHash = null;
        }, RUN_TTL_MS);
      });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (path !== "/runs" || request.method !== "POST") return json({ error: "Unknown listener route." }, 404);
    if (!this.agentTokenHash || !this.socket || this.socket.readyState !== 1) {
      return json({ error: "Open the command's listener page in your browser." }, 409);
    }
    const authorization = request.headers.get("authorization") || "";
    if (!authorization.startsWith("Bearer ") || await hash(authorization.slice(7)) !== this.agentTokenHash) {
      return json({ error: "Invalid command token." }, 403);
    }
    // The Worker bounds and buffers registration bodies before forwarding them.
    const payload = await request.json().catch(() => null);
    if (!TOKEN_PATTERN.test(payload?.runId || "") || !TOKEN_PATTERN.test(payload?.agentToken || "")) {
      return json({ error: "Invalid run details." }, 400);
    }
    if (!this.socket || this.socket.readyState !== 1) return json({ error: "Listener disconnected." }, 409);
    this.pruneRuns();
    let run = this.runs.get(payload.runId);
    if (run && run.agentToken !== payload.agentToken) return json({ error: "Run already registered." }, 403);
    if (!run) {
      if (this.runs.size >= MAX_RUNS) return json({ error: "Too many runs. Try again later." }, 429);
      run = { runId: payload.runId, agentToken: payload.agentToken, createdAt: Date.now() };
      this.runs.set(run.runId, run);
    }
    this.sendRun(run);
    return json({ ok: true });
  }
}
