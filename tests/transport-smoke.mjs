// Run against local Wrangler, or an explicitly selected deployment.
// Fresh owned sessions run fixed commands through a local HTTP fault relay.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket } from "ws";

const base = (process.env.RAIJIN_TEST_URL || "http://127.0.0.1:8787").replace(/\/$/u, "");
const agentUserAgent = "raijin-agent/0.1 (+https://raijin.sh)";
const fixtures = new Map();
const connections = new Set();
const controllers = new Set();
const token = () => randomBytes(32).toString("base64url");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, label, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    await delay(20);
  }
}

function occurrences(text, marker) {
  return text.split(marker).length - 1;
}

// Only this process's agent routes are accepted; the browser WebSocket goes
// directly to Wrangler/Cloudflare so a lost HTTP ACK remains observable there.
const relay = createServer((request, response) => {
  void forward(request, response).catch(() => {
    const match = request.url?.match(/^\/agent\/([A-Za-z0-9_-]+)\//u);
    const fixture = fixtures.get(match?.[1]);
    if (fixture && !fixture.closing) fixture.errors.push("HTTP fault relay failed to reach upstream");
    if (!response.destroyed) {
      response.writeHead(502, { "content-type": "application/json" });
      response.end('{"error":"test relay upstream unavailable"}');
    }
  });
});
relay.on("connection", connection => {
  connections.add(connection);
  connection.on("close", () => connections.delete(connection));
});

async function forward(request, response) {
  const match = request.url?.match(/^\/agent\/([A-Za-z0-9_-]+)\/(in|out|heartbeat|close)$/u);
  const fixture = fixtures.get(match?.[1]);
  if (!fixture) {
    response.writeHead(404);
    response.end();
    return;
  }
  const action = match[2];
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    assert.ok(length <= 65_536, "Unexpectedly large test request body");
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const observation = {
    action,
    method: request.method,
    body: body.toString(),
    protocol: request.headers["x-raijin-protocol"],
    epoch: request.headers["x-raijin-epoch"],
    inputAck: request.headers["x-raijin-input-ack"],
  };
  fixture.requests.push(observation);

  if (action === "out" && fixture.statuses.length) {
    const status = fixture.statuses.shift();
    observation.injected = status;
    fixture.injected.push(status);
    response.writeHead(status, {
      "content-type": "application/json",
      "cf-ray": `transport-test-${status}`,
      ...(status === 429 ? { "retry-after": "0" } : {
        // Any redirect-following client would change path or leak this value.
        location: `${relayBase}${request.url}?do-not-follow=${fixture.redirectSecret}`,
      }),
    });
    response.end('{"error":"injected transient response"}');
    return;
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (!["host", "connection", "content-length"].includes(name) && typeof value === "string") {
      headers.set(name, value);
    }
  }
  const controller = new AbortController();
  controllers.add(controller);
  const deadline = setTimeout(() => controller.abort(), 35_000);
  try {
    const upstream = await fetch(`${base}${request.url}`, {
      method: request.method,
      headers,
      ...(request.method === "GET" ? {} : { body }),
      redirect: "manual",
      signal: controller.signal,
    });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    observation.upstreamStatus = upstream.status;
    let payload;
    try { payload = JSON.parse(bytes.toString()); } catch { payload = null; }
    observation.payload = payload;

    if (action === "out" && fixture.dropOutput && upstream.status === 200) {
      fixture.dropOutput = false;
      fixture.droppedOutput = observation;
      response.destroy();
      return;
    }
    if (action === "in" && payload?.events?.some(event => event.type === "stdin")) {
      fixture.inputDeliveries.push(observation);
      if (fixture.dropInput && upstream.status === 200) {
        fixture.dropInput = false;
        fixture.droppedInput = observation;
        response.destroy();
        return;
      }
    }

    const responseHeaders = {};
    for (const name of ["content-type", "cf-ray", "retry-after", "location"]) {
      if (upstream.headers.has(name)) responseHeaders[name] = upstream.headers.get(name);
    }
    response.writeHead(upstream.status, responseHeaders);
    response.end(bytes);
  } finally {
    clearTimeout(deadline);
    controllers.delete(controller);
  }
}

await new Promise((resolve, reject) => {
  relay.once("error", reject);
  relay.listen(0, "127.0.0.1", resolve);
});
const relayBase = `http://127.0.0.1:${relay.address().port}`;

async function createFixture({ command, statuses = [], dropOutput = false, dropInput = false }) {
  const fixture = {
    id: token(), token: token(), browserToken: token(), redirectSecret: token(),
    command, statuses: [...statuses], injected: [], dropOutput, dropInput,
    requests: [], inputDeliveries: [], errors: [], output: "", messages: [], stderr: "",
  };
  fixtures.set(fixture.id, fixture);
  fixture.ws = new WebSocket(`${base.replace(/^http/u, "ws")}/connect/browser/${fixture.id}`);
  fixture.ws.on("message", data => {
    const message = JSON.parse(data);
    fixture.messages.push(message);
    if (message.type === "output") fixture.output += Buffer.from(message.data, "base64").toString();
  });
  fixture.ws.on("close", () => { fixture.socketClosed = true; });
  fixture.ws.on("error", () => { fixture.errors.push("Browser WebSocket failed"); });
  await new Promise((resolve, reject) => {
    fixture.ws.once("open", resolve);
    fixture.ws.once("error", reject);
  });
  fixture.ws.send(JSON.stringify({
    type: "hello", browserToken: fixture.browserToken,
    agentTokenHash: createHash("sha256").update(fixture.token).digest("base64url"),
    mode: "command", command, createdAt: Date.now(), idleTimeoutSeconds: 600,
  }));
  await until(() => fixture.messages.some(message => message.type === "status"), "browser initialization");

  const config = Buffer.from(JSON.stringify({
    baseUrl: relayBase, sessionId: fixture.id, token: fixture.token, mode: "command", command,
  })).toString("base64url");
  const response = await fetch(`${base}/bootstrap?c=${config}`, {
    headers: { "user-agent": agentUserAgent }, signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200, "Generated bootstrap request failed");
  const script = await response.text();
  fixture.process = spawn("python3", ["-"], {
    stdio: ["pipe", "ignore", "pipe"],
    env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
  });
  fixture.process.stderr.on("data", data => { fixture.stderr += data; });
  fixture.process.on("error", () => { fixture.errors.push("Unable to start Python"); fixture.exited = true; });
  fixture.process.on("exit", (code, signal) => { fixture.exited = true; fixture.code = code; fixture.signal = signal; });
  fixture.process.stdin.on("error", () => { fixture.errors.push("Python did not accept its bootstrap"); });
  fixture.process.stdin.end(script);
  return fixture;
}

async function expectSuccess(fixture) {
  await until(() => fixture.exited, "Python bootstrap exit");
  assert.deepEqual(fixture.errors, []);
  assert.equal(fixture.signal, null, "Bootstrap was killed");
  // Check redaction before using stderr as an assertion detail.
  for (const secret of [fixture.token, fixture.browserToken, fixture.redirectSecret]) {
    assert.equal(fixture.stderr.includes(secret), false, "Diagnostics exposed a test credential");
  }
  assert.equal(fixture.code, 0, fixture.stderr);
  await until(() => fixture.socketClosed, "session cleanup");
  assert.ok(fixture.requests.length > 0);
  assert.ok(fixture.requests.every(request => request.protocol === "2"), "Agent must select protocol v2");
  const ready = fixture.requests.find(request => request.action === "heartbeat" && request.payload?.browserConnected);
  assert.equal(ready?.payload?.protocol, 2, "Readiness must advertise v2");
  assert.equal(typeof ready.payload.epoch, "string");
  for (const request of fixture.requests.filter(request => ["in", "out", "close"].includes(request.action))) {
    assert.equal(request.epoch, ready.payload.epoch, "Agent must carry the session epoch");
  }
  return fixture.stderr.split("\n").flatMap(line => {
    const start = line.indexOf("{");
    if (!line.startsWith("raijin:") || start < 0) return [];
    try { return [JSON.parse(line.slice(start))]; } catch { return []; }
  });
}

function checkOutputAttempts(fixture, expected) {
  const requests = fixture.requests.filter(request => request.action === "out");
  assert.equal(requests.length, expected);
  assert.ok(requests.every(request => request.method === "POST"), "Output retries must preserve POST");
  assert.ok(requests.every(request => request.body === requests[0].body), "Retries must preserve body and sequence");
  const sent = JSON.parse(requests[0].body);
  assert.equal(sent.seq, 1);
  for (const request of requests.filter(request => request.upstreamStatus === 200)) {
    assert.equal(request.payload.ack, sent.seq);
  }
}

function checkRetryDiagnostic(fixture, diagnostics, status) {
  const event = diagnostics.find(candidate => candidate.event === "retry" && candidate.status === status);
  assert.ok(event, `Missing HTTP ${status} retry diagnostic`);
  assert.equal(event.method, "POST");
  assert.equal(event.path, `/agent/${fixture.id}/out`);
  assert.equal(event.runId, fixture.id);
  assert.equal(typeof event.version, "string");
  assert.equal(event.ray, `transport-test-${status}`);
  assert.ok(Number.isInteger(event.attempt) && event.attempt >= 1);
  assert.ok(event.maxAttempts >= event.attempt);
}

try {
  const redirects = await createFixture({
    command: "printf 'transport-redirect-ok\\n'", statuses: [301, 302],
  });
  const redirectDiagnostics = await expectSuccess(redirects);
  assert.deepEqual(redirects.injected, [301, 302]);
  checkOutputAttempts(redirects, 3);
  assert.equal(occurrences(redirects.output, "transport-redirect-ok"), 1);
  for (const status of [301, 302]) {
    checkRetryDiagnostic(redirects, redirectDiagnostics, status);
  }
  console.log("Redirects: 301/302 retried as the same POST; no redirect followed; credentials redacted");

  const throttled = await createFixture({ command: "printf 'transport-rate-limit-ok\\n'", statuses: [429] });
  const throttleDiagnostics = await expectSuccess(throttled);
  assert.deepEqual(throttled.injected, [429]);
  checkOutputAttempts(throttled, 2);
  assert.equal(occurrences(throttled.output, "transport-rate-limit-ok"), 1);
  checkRetryDiagnostic(throttled, throttleDiagnostics, 429);
  console.log("Rate limit: 429 retried with preserved output and successful recovery");

  const outputLoss = await createFixture({ command: "printf 'transport-output-once\\n'", dropOutput: true });
  const outputDiagnostics = await expectSuccess(outputLoss);
  assert.equal(outputLoss.droppedOutput?.upstreamStatus, 200, "Must lose an ACK after upstream acceptance");
  checkOutputAttempts(outputLoss, 2);
  assert.equal(occurrences(outputLoss.output, "transport-output-once"), 1);
  assert.ok(outputDiagnostics.some(event => event.event === "retry" && event.reason === "transport_exhausted"
    && event.method === "POST" && event.path === `/agent/${outputLoss.id}/out`));
  console.log("Lost output ACK: upstream accepted both POSTs; browser received the output once");

  const inputLoss = await createFixture({
    command: "stty -echo; n=0; printf 'transport-input-ready\\n'; while IFS= read -r line; do "
      + "if [ \"$line\" = finish ]; then break; fi; n=$((n + 1)); "
      + "printf 'transport-input-applied:%s:%s\\n' \"$n\" \"$line\"; done; printf 'transport-input-done\\n'",
    dropInput: true,
  });
  await until(() => inputLoss.output.includes("transport-input-ready"), "input test PTY ready");
  inputLoss.ws.send(JSON.stringify({ type: "stdin", data: "probe\n" }));
  await until(() => inputLoss.output.includes("transport-input-applied:1:probe"), "replayed input applied");
  await until(() => inputLoss.requests.some(request => request.action === "in" && Number(request.inputAck) >= 1), "applied input acknowledged");
  inputLoss.ws.send(JSON.stringify({ type: "stdin", data: "finish\n" }));
  await expectSuccess(inputLoss);
  assert.equal(inputLoss.droppedInput?.upstreamStatus, 200, "Must lose an input response after upstream delivery");
  const firstEvent = inputLoss.droppedInput.payload.events.find(event => event.type === "stdin");
  assert.equal(firstEvent.data, "probe\n");
  assert.equal(firstEvent.seq, 1);
  const redelivery = inputLoss.inputDeliveries.filter(request => request.payload.events.some(event => event.seq === firstEvent.seq));
  assert.equal(redelivery.length, 2, "Unacknowledged input must be redelivered");
  assert.deepEqual(redelivery[0].payload.events, redelivery[1].payload.events, "Redelivery must keep immutable input events");
  assert.equal(occurrences(inputLoss.output, "transport-input-applied:"), 1, "The shell must apply the command once");
  assert.equal(occurrences(inputLoss.output, "transport-input-done"), 1);
  console.log("Lost input response: retained event redelivered, applied once, then acknowledged");
} finally {
  for (const fixture of fixtures.values()) fixture.closing = true;
  await Promise.allSettled([...fixtures.values()].map(fixture => fetch(`${base}/api/sessions/${fixture.id}/end`, {
    method: "POST", headers: { authorization: `Bearer ${fixture.browserToken}`, "user-agent": agentUserAgent },
    signal: AbortSignal.timeout(5_000),
  })));
  for (const fixture of fixtures.values()) fixture.ws?.close();
  await delay(100);
  for (const fixture of fixtures.values()) {
    if (fixture.process && !fixture.exited) fixture.process.kill("SIGKILL");
    if (fixture.ws?.readyState !== WebSocket.CLOSED) fixture.ws?.terminate();
  }
  for (const controller of controllers) controller.abort();
  for (const connection of connections) connection.destroy();
  await new Promise(resolve => relay.close(resolve));
}
