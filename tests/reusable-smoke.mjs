// Run against wrangler dev, or an explicitly selected deployment.
// Creates temporary launcher/terminal sessions and closes them afterward.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { WebSocket } from "ws";

const base = (process.env.RAIJIN_TEST_URL || "http://127.0.0.1:8787").replace(/\/$/u, "");
const sockets = new Set();
const processes = new Set();
const runs = new Map();
const token = () => randomBytes(32).toString("base64url");
const hash = value => createHash("sha256").update(value).digest("base64url");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    await delay(20);
  }
}

async function request(path, bearer, body = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}

async function socket(path, hello) {
  const ws = new WebSocket(`${base.replace(/^http/u, "ws")}${path}`);
  const channel = { ws, messages: [], output: "", close: null };
  sockets.add(ws);
  ws.on("message", data => {
    const message = JSON.parse(data);
    channel.messages.push(message);
    if (message.type === "output") channel.output += Buffer.from(message.data, "base64").toString();
    if (message.type === "run") runs.set(message.runId, message);
  });
  ws.on("close", (code, reason) => {
    channel.close = { code, reason: reason.toString() };
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify(hello));
  return channel;
}

async function listener(id, browserToken, agentTokenHash) {
  return socket(`/connect/launcher/${id}`, { type: "hello", browserToken, agentTokenHash });
}

async function terminal(run, browserToken = token()) {
  const channel = await socket(`/connect/browser/${run.runId}`, {
    type: "hello",
    browserToken,
    agentTokenHash: hash(run.agentToken),
    createdAt: Date.now(),
    idleTimeoutSeconds: 600,
  });
  channel.browserToken = browserToken;
  await until(() => channel.messages.some(message => message.type === "status"), "terminal hello");
  return channel;
}

function startBootstrap(script) {
  const process = spawn("python3", ["-"], { stdio: ["pipe", "ignore", "pipe"] });
  const execution = { process, stderr: "", exited: false, code: null, signal: null };
  processes.add(execution);
  process.stderr.on("data", data => { execution.stderr += data; });
  process.on("error", error => { execution.error = error; execution.exited = true; });
  process.on("exit", (code, signal) => {
    execution.exited = true;
    execution.code = code;
    execution.signal = signal;
  });
  process.stdin.end(script);
  return execution;
}

async function expectExit(execution) {
  await until(() => execution.exited, "Python bootstrap exit");
  assert.ifError(execution.error);
  assert.equal(execution.signal, null, execution.stderr);
  assert.equal(execution.code, 0, execution.stderr);
}

try {
  const browserToken = token();
  const launcherToken = token();
  const id = hash(browserToken);
  const runPath = `/api/launchers/${id}/runs`;
  const offered = { runId: token(), agentToken: token() };

  assert.equal((await request(runPath, launcherToken, offered)).status, 409);
  const unclaimed = await listener(id, token(), hash(launcherToken));
  await until(() => unclaimed.close, "reject incorrect launcher owner before initialization");
  assert.equal(unclaimed.close.code, 1008);
  const launcher = await listener(id, browserToken, hash(launcherToken));
  await until(() => launcher.messages.some(message => message.type === "ready"), "launcher ready");

  assert.equal((await request(runPath, token(), offered)).status, 403);
  assert.equal((await request(runPath, launcherToken, { ...offered, extra: "x".repeat(1025) })).status, 413);
  assert.equal((await request(runPath, launcherToken, { runId: "invalid" })).status, 400);
  assert.equal((await request(runPath, launcherToken, offered)).status, 200);
  await until(() => launcher.messages.some(message => message.runId === offered.runId), "first run offer");
  assert.equal((await request(runPath, launcherToken, offered)).status, 200);
  await until(() => launcher.messages.filter(message => message.runId === offered.runId).length >= 2, "registration retry");
  for (const message of launcher.messages.filter(message => message.type === "run")) {
    assert.equal(message.runId, offered.runId);
    assert.equal(message.agentToken, offered.agentToken);
  }
  assert.equal((await request(runPath, launcherToken, { ...offered, agentToken: token() })).status, 403);
  assert.equal((await request(`/agent/${offered.runId}/heartbeat`, offered.agentToken)).status, 409);

  for (const [owner, agentHash] of [[token(), hash(launcherToken)], [browserToken, hash(token())]]) {
    const rejected = await listener(id, owner, agentHash);
    await until(() => rejected.close, "reject mismatched launcher credentials");
    assert.equal(rejected.close.code, 1008);
    assert.equal(launcher.ws.readyState, WebSocket.OPEN);
    assert.equal((await request(runPath, launcherToken, offered)).status, 200);
  }
  console.log("Launcher registration: no-browser 409, owner validation, wrong-token 403, idempotence passed");

  // Initialization alone is not readiness: the child tab can close before startup.
  const detached = await terminal(offered);
  detached.ws.close();
  await until(() => detached.close, "child browser closes before the agent connects");
  const detachedHeartbeat = await request(`/agent/${offered.runId}/heartbeat`, offered.agentToken);
  assert.equal(detachedHeartbeat.status, 200);
  assert.equal((await detachedHeartbeat.json()).browserConnected, false);
  const reattached = await terminal(offered, detached.browserToken);
  const attachedHeartbeat = await request(`/agent/${offered.runId}/heartbeat`, offered.agentToken);
  assert.equal(attachedHeartbeat.status, 200);
  assert.equal((await attachedHeartbeat.json()).browserConnected, true);
  assert.equal((await request(`/agent/${offered.runId}/close`, offered.agentToken)).status, 200);
  await until(() => reattached.close, "readiness regression session cleanup");
  console.log("Readiness: initialized but detached child waits, then reports ready after reattach");

  const config = Buffer.from(JSON.stringify({
    baseUrl: base,
    sessionId: id,
    token: launcherToken,
    reusable: true,
    mode: "command",
    command: "printf 'raijin-reusable-ready\\n'; IFS= read -r line; printf 'raijin-reusable-reply:%s\\n' \"$line\"",
  })).toString("base64url");
  const response = await fetch(`${base}/bootstrap?c=${config}`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  const script = await response.text();
  const firstExecution = startBootstrap(script);
  const secondExecution = startBootstrap(script);
  const freshRuns = () => [...runs.values()].filter(run => run.runId !== offered.runId);
  await until(() => freshRuns().length === 2, "two independent runs from the same bootstrap");
  const [firstRun, secondRun] = freshRuns();
  assert.notEqual(firstRun.runId, secondRun.runId);
  assert.notEqual(firstRun.agentToken, secondRun.agentToken);
  for (const run of [firstRun, secondRun]) {
    assert.equal((await request(`/agent/${run.runId}/heartbeat`, run.agentToken)).status, 409);
  }
  assert.equal(firstExecution.exited, false);
  assert.equal(secondExecution.exited, false);
  let first = await terminal(firstRun);
  await until(() => first.output.includes("raijin-reusable-ready"), "first PTY start");
  // The second bootstrap remains waiting until its own browser tab is attached.
  assert.equal((await request(`/agent/${secondRun.runId}/heartbeat`, secondRun.agentToken)).status, 409);
  const second = await terminal(secondRun);
  await until(() => second.output.includes("raijin-reusable-ready"), "second PTY start");
  assert.equal((await request(`/agent/${firstRun.runId}/out`, secondRun.agentToken, { data: "bm8=" })).status, 403);
  assert.equal((await request(`/agent/${secondRun.runId}/close`, firstRun.agentToken)).status, 403);

  // Replacing an attached browser must not let its stale close terminate the session.
  const replaced = first;
  first = await terminal(firstRun, first.browserToken);
  await until(() => replaced.close, "replaced browser closes");
  assert.equal((await request(`/agent/${firstRun.runId}/heartbeat`, firstRun.agentToken)).status, 200);
  const unauthorized = await socket(`/connect/browser/${firstRun.runId}`, {
    type: "hello", browserToken: token(), agentTokenHash: hash(firstRun.agentToken),
  });
  await until(() => unauthorized.close, "unauthorized browser closes");
  assert.equal(unauthorized.close.code, 1008);
  assert.equal((await request(`/agent/${firstRun.runId}/heartbeat`, firstRun.agentToken)).status, 200);
  assert.equal(first.ws.readyState, WebSocket.OPEN);

  const firstLine = `first-${token()}`;
  const secondLine = `second-${token()}`;
  first.ws.send(JSON.stringify({ type: "stdin", data: `${firstLine}\n` }));
  await until(() => first.output.includes(`raijin-reusable-reply:${firstLine}`), "first isolated input/output");
  await until(() => first.close, "first session closes after its shell exits");
  assert.equal(second.output.includes(firstLine), false);
  assert.equal(second.ws.readyState, WebSocket.OPEN);
  assert.equal((await request(`/agent/${secondRun.runId}/heartbeat`, secondRun.agentToken)).status, 200);
  second.ws.send(JSON.stringify({ type: "stdin", data: `${secondLine}\n` }));
  await until(() => second.output.includes(`raijin-reusable-reply:${secondLine}`), "second isolated input/output");
  assert.equal(first.output.includes(secondLine), false);
  await Promise.all([expectExit(firstExecution), expectExit(secondExecution)]);
  console.log("Simultaneous Python runs: distinct credentials, isolated I/O, independent close, stale-socket regression passed");

  const thirdExecution = startBootstrap(script);
  await until(() => freshRuns().length === 3, "reuse after both shells exit");
  const thirdRun = freshRuns().find(run => run.runId !== firstRun.runId && run.runId !== secondRun.runId);
  const third = await terminal(thirdRun);
  await until(() => third.output.includes("raijin-reusable-ready"), "reused command starts a fresh PTY");
  third.ws.send(JSON.stringify({ type: "stdin", data: "reuse-after-exit\n" }));
  await until(() => third.output.includes("raijin-reusable-reply:reuse-after-exit"), "reused command output");
  await expectExit(thirdExecution);
  assert.equal(launcher.ws.readyState, WebSocket.OPEN);
  launcher.ws.close();
  await until(() => launcher.close, "launcher close");
  assert.equal((await request(runPath, launcherToken, { runId: token(), agentToken: token() })).status, 409);
  console.log("Same generated bootstrap: reuse after exit and no-listener waiting passed");
} finally {
  await Promise.allSettled([...runs.values()].map(run => request(`/agent/${run.runId}/close`, run.agentToken)));
  for (const ws of sockets) ws.close();
  await delay(100);
  for (const execution of processes) if (!execution.exited) execution.process.kill("SIGKILL");
  for (const ws of sockets) if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
}
