import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { SessionDurableObject } from "../src/session-do.js";

const token = () => randomBytes(32).toString("base64url");
const hash = value => createHash("sha256").update(value).digest("base64url");
const data = value => Buffer.from(value).toString("base64");
const settle = () => new Promise(resolve => setImmediate(resolve));

// Exercise actual DO methods and Request/Response objects. A socket adapter records
// the browser delivery boundary; the integration suite covers workerd and real PTYs.
async function fixture(t, protocol = "2", negotiate = true) {
  const object = new SessionDurableObject();
  const agentToken = token();
  const browserToken = token();
  const browser = {
    readyState: 1,
    messages: [],
    send(value) { this.messages.push(JSON.parse(value)); },
    close() { this.readyState = 3; },
  };
  t.after(() => {
    object.clearRuntimeState();
    for (const waiter of object.waiters) clearTimeout(waiter.timer);
  });
  await object.handleBrowserHello(browser, {
    browserToken,
    agentTokenHash: hash(agentToken),
    createdAt: Date.now(),
    idleTimeoutSeconds: 600,
  });
  let epoch;
  function request(action, body, options = {}) {
    const headers = new Headers({ "content-type": "application/json" });
    const bearer = options.token === undefined ? agentToken : options.token;
    if (bearer !== null) headers.set("authorization", `Bearer ${bearer}`);
    const version = options.protocol === undefined ? protocol : options.protocol;
    if (version !== null) headers.set("x-raijin-protocol", version);
    const requestedEpoch = options.epoch === undefined ? epoch : options.epoch;
    if (requestedEpoch !== undefined && requestedEpoch !== null) headers.set("x-raijin-epoch", requestedEpoch);
    for (const [key, value] of Object.entries(options.headers || {})) headers.set(key, value);
    return new Request(`https://session/agent/${action}`, {
      method: action === "in" ? "GET" : "POST",
      headers,
      ...(action === "in" ? {} : { body: JSON.stringify(body ?? {}) }),
    });
  }
  const call = (action, body, options) => object.fetch(request(action, body, options));
  if (negotiate) {
    const heartbeat = await call("heartbeat");
    assert.equal(heartbeat.status, 200);
    const ready = await heartbeat.json();
    if (protocol === "2") {
      assert.equal(ready.protocol, 2);
      assert.equal(ready.browserConnected, true);
      assert.equal(typeof ready.epoch, "string");
      assert.ok(ready.epoch.length >= 16);
      epoch = ready.epoch;
    } else {
      assert.equal(ready.protocol, undefined);
      assert.equal(ready.epoch, undefined);
    }
  }
  const input = message => object.handleBrowserMessage(browser, { data: JSON.stringify(message) });
  return { object, agentToken, browser, epoch, call, request, input,
    output: () => browser.messages.filter(message => message.type === "output") };
}

test("lost output acknowledgment retries forward each sequence once", async t => {
  const f = await fixture(t);
  await f.call("out", { seq: 1, data: data("first") }); // Pretend the HTTP response was lost.
  const retry = await f.call("out", { seq: 1, data: data("first") });
  assert.deepEqual(await retry.json(), { ok: true, ack: 1 });
  assert.equal(f.output().length, 1);
  assert.deepEqual(await (await f.call("out", { seq: 2, data: data("second") })).json(), { ok: true, ack: 2 });
  assert.deepEqual(await (await f.call("out", { seq: 1, data: data("first") })).json(), { ok: true, ack: 2 });
  assert.deepEqual(f.output().map(message => Buffer.from(message.data, "base64").toString()), ["first", "second"]);
});

test("concurrent output retries remain atomic", async t => {
  const f = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 8 }, () => f.call("out", { seq: 1, data: data("once") })));
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(f.output().length, 1);
});

test("invalid output and forward sequence gaps cannot advance acknowledgment", async t => {
  const f = await fixture(t);
  for (const payload of [
    { seq: 0, data: data("a") }, { seq: 1.5, data: data("a") },
    { seq: Number.MAX_SAFE_INTEGER + 1, data: data("a") },
    { seq: 1, data: "%%%" }, { seq: 1, data: "YR==" },
    { seq: 1, data: data("a".repeat(65_537)) },
  ]) assert.equal((await f.call("out", payload)).status, 400);
  const gap = await f.call("out", { seq: 2, data: data("skip") });
  assert.equal(gap.status, 422);
  assert.equal((await gap.json()).code, "sequence_gap");
  assert.equal(f.object.lastOutSeq, 0);
  assert.equal(f.output().length, 0);
  assert.equal((await f.call("out", { seq: 1, data: data("accepted") })).status, 200);
});

test("v2 output waits for a browser without acknowledging or advancing", async t => {
  const f = await fixture(t);
  f.object.browserSocket = null;
  assert.equal((await f.call("out", { seq: 1, data: data("kept") })).status, 409);
  assert.equal(f.object.lastOutSeq, 0);
  f.object.browserSocket = f.browser;
  assert.equal((await f.call("out", { seq: 1, data: data("kept") })).status, 200);
  assert.equal(f.output().length, 1);
});

test("lost input response replays unchanged events; applied ACK releases only its prefix", async t => {
  const f = await fixture(t);
  await f.input({ type: "stdin", data: "first" });
  await f.input({ type: "resize", cols: 80, rows: 24 });
  const first = await (await f.call("in")).json();
  assert.deepEqual(first.events, [
    { type: "stdin", data: "first", seq: 1 }, { type: "resize", cols: 80, rows: 24, seq: 2 },
  ]);
  const replay = await (await f.call("in")).json();
  assert.deepEqual(replay.events, first.events);
  await f.input({ type: "stdin", data: "second" });
  await f.input({ type: "resize", cols: 100, rows: 30 });
  const partial = await (await f.call("in", null, { headers: { "x-raijin-input-ack": "1" } })).json();
  assert.deepEqual(partial.events, [
    first.events[1], { type: "stdin", data: "second", seq: 3 }, { type: "resize", cols: 100, rows: 30, seq: 4 },
  ]);
  const stale = await (await f.call("in", null, { headers: { "x-raijin-input-ack": "0" } })).json();
  assert.deepEqual(stale.events, partial.events);
  assert.equal(f.object.inputAck, 1);
  await f.input({ type: "stdin", data: "third" });
  const next = await (await f.call("in", null, { headers: { "x-raijin-input-ack": "4" } })).json();
  assert.deepEqual(next.events, [{ type: "stdin", data: "third", seq: 5 }]);
});

test("sent stdin remains immutable and resize order remains intact", async t => {
  const f = await fixture(t);
  await f.input({ type: "stdin", data: "old" });
  const first = await (await f.call("in")).json();
  await f.input({ type: "stdin", data: "new" });
  await f.input({ type: "stdin", data: "er" });
  await f.input({ type: "resize", cols: 80, rows: 24 });
  await f.input({ type: "stdin", data: "after resize" });
  await f.input({ type: "resize", cols: 90, rows: 30 });
  const replay = await (await f.call("in")).json();
  assert.deepEqual(replay.events[0], first.events[0]);
  assert.deepEqual(replay.events.map(event => [event.seq, event.type, event.data ?? event.cols]), [
    [1, "stdin", "old"], [2, "stdin", "newer"], [3, "resize", 80],
    [4, "stdin", "after resize"], [5, "resize", 90],
  ]);
});

test("resize/stdin order is retained before the first agent negotiates v2", async t => {
  const f = await fixture(t, "2", false);
  assert.equal(f.object.agentProtocol, null);
  assert.equal(f.object.agentConnectedAt, null);
  await f.input({ type: "resize", cols: 80, rows: 24 });
  await f.input({ type: "stdin", data: "stty size\n" });
  await f.input({ type: "resize", cols: 100, rows: 30 });
  const ready = await (await f.call("heartbeat")).json();
  assert.equal(ready.protocol, 2);
  const response = await f.call("in", null, { epoch: ready.epoch });
  assert.deepEqual((await response.json()).events, [
    { type: "resize", cols: 80, rows: 24, seq: 1 },
    { type: "stdin", data: "stty size\n", seq: 2 },
    { type: "resize", cols: 100, rows: 30, seq: 3 },
  ]);
});

test("invalid or future input ACK cannot discard queued input", async t => {
  const f = await fixture(t);
  await f.input({ type: "stdin", data: "keep" });
  for (const ack of ["1", "-1", "1.5", "01", "NaN", "9007199254740992"]) {
    const response = await f.call("in", null, { headers: { "x-raijin-input-ack": ack } });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, "invalid_ack");
  }
  assert.deepEqual((await (await f.call("in")).json()).events, [{ type: "stdin", data: "keep", seq: 1 }]);
});

test("long polls share immutable events and ending v2 polls returns 410", async t => {
  const f = await fixture(t);
  const polls = [f.call("in"), f.call("in")];
  await settle();
  await f.input({ type: "stdin", data: "once" });
  const responses = await Promise.all(polls);
  assert.deepEqual((await responses[0].json()).events, (await responses[1].json()).events);
  const pending = f.call("in", null, { headers: { "x-raijin-input-ack": "1" } });
  await settle();
  assert.equal((await f.call("close", { reason: "finished" })).status, 200);
  const ended = await pending;
  assert.equal(ended.status, 410);
  assert.equal((await ended.json()).status, "agent_closed");
});

test("auth precedes epoch disclosure; stale epochs fail closed across resets", async t => {
  const f = await fixture(t);
  assert.equal((await f.call("heartbeat", {}, { token: null, epoch: "wrong" })).status, 401);
  const wrongToken = await f.call("heartbeat", {}, { token: token(), epoch: "wrong" });
  assert.equal(wrongToken.status, 403);
  assert.equal((await wrongToken.json()).code, undefined);
  const wrongEpoch = await f.call("heartbeat", {}, { epoch: token() });
  assert.equal(wrongEpoch.status, 410);
  assert.equal((await wrongEpoch.json()).code, "session_reset");
  const reset = new SessionDurableObject();
  const afterReset = await reset.fetch(f.request("heartbeat"));
  assert.equal(afterReset.status, 410);
  assert.equal((await afterReset.json()).code, "session_reset");
  assert.equal((await reset.fetch(f.request("heartbeat", {}, { epoch: null }))).status, 409);
  assert.equal((await reset.fetch(f.request("heartbeat", {}, { token: null }))).status, 401);
});

test("protocol is pinned and v2 data requests require the negotiated epoch", async t => {
  const f = await fixture(t);
  assert.equal((await f.call("heartbeat", {}, { protocol: null })).status, 400);
  assert.equal((await f.call("heartbeat", {}, { protocol: "3" })).status, 400);
  for (const action of ["out", "in", "close"]) {
    const response = await f.call(action, {}, { epoch: null });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "missing_epoch");
  }
  const legacy = await fixture(t, null);
  assert.equal((await legacy.call("heartbeat", {}, { protocol: "2" })).status, 400);
});

test("session ending while an output body is awaited cannot forward or advance it", async t => {
  const f = await fixture(t);
  let release;
  let reading;
  const started = new Promise(resolve => { reading = resolve; });
  const request = f.request("out", {});
  request.json = () => { reading(); return new Promise(resolve => { release = resolve; }); };
  const response = f.object.fetch(request);
  await started;
  await f.object.endSession("ended", { closeBrowser: true });
  release({ seq: 1, data: data("late") });
  assert.equal((await response).status, 410);
  assert.equal(f.output().length, 0);
  assert.equal(f.object.lastOutSeq, 0);
});

test("reinitialization during an output body read rejects the old epoch", async t => {
  const f = await fixture(t);
  let release;
  let reading;
  const started = new Promise(resolve => { reading = resolve; });
  const request = f.request("out", {});
  request.json = () => { reading(); return new Promise(resolve => { release = resolve; }); };
  const pending = f.object.fetch(request);
  await started;
  f.object.clearRuntimeState();
  await f.object.handleBrowserHello(f.browser, {
    browserToken: token(), agentTokenHash: hash(f.agentToken), createdAt: Date.now(), idleTimeoutSeconds: 600,
  });
  assert.notEqual(f.object.epoch, f.epoch);
  release({ seq: 1, data: data("old epoch") });
  const response = await pending;
  assert.equal(response.status, 410);
  assert.equal((await response.json()).code, "session_reset");
  assert.equal(f.output().length, 0);
  assert.equal(f.object.lastOutSeq, 0);
  assert.equal((await f.call("heartbeat")).status, 410);
});

test("expired status survives runtime credential cleanup for later requests", async t => {
  const f = await fixture(t);
  await f.object.endSession("expired", { closeBrowser: true });
  assert.equal(f.object.agentTokenHash, null);
  const response = await f.call("heartbeat");
  assert.equal(response.status, 410);
  assert.equal((await response.json()).status, "expired");
  assert.equal((await f.call("heartbeat", {}, { token: null })).status, 401);
});

test("legacy output and dequeuing semantics remain available without protocol header", async t => {
  const f = await fixture(t, null);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.deepEqual(await (await f.call("out", { data: data("legacy") })).json(), { ok: true });
  }
  assert.equal(f.output().length, 2);
  await f.input({ type: "stdin", data: "legacy input" });
  assert.deepEqual((await (await f.call("in")).json()).events, [{ type: "stdin", data: "legacy input" }]);
  assert.equal(f.object.pendingEvents.length, 0);
  f.object.browserSocket = null;
  assert.equal((await f.call("out", { data: data("drop") })).status, 200);
  assert.equal(f.output().length, 2);
  const pending = f.call("in");
  await settle();
  await f.call("close");
  const ended = await pending;
  assert.equal(ended.status, 200);
  assert.equal((await ended.json()).events[0].type, "terminate");
});

test("input byte and event limits end the session visibly without silent trimming", async t => {
  const bytes = await fixture(t);
  await bytes.input({ type: "stdin", data: "x".repeat(256 * 1024 + 1) });
  assert.equal(bytes.object.status, "ended");
  assert.equal(bytes.object.pendingEvents.length, 0);
  assert.equal(bytes.browser.readyState, 3);
  assert.ok(bytes.browser.messages.some(message => message.type === "notice" && message.message.includes("buffer limit")));
  assert.equal((await (await bytes.call("heartbeat")).json()).code, "input_overflow");
  const events = await fixture(t);
  for (let index = 0; index <= 1024; index += 1) {
    await events.input({ type: "resize", cols: 80, rows: 24 });
  }
  assert.equal(events.object.status, "ended");
  assert.ok(events.browser.messages.some(message => message.type === "notice" && message.message.includes("buffer limit")));
  assert.equal((await (await events.call("heartbeat")).json()).code, "input_overflow");
});

test("too many pending polls terminates the session and releases existing waiters", async t => {
  const f = await fixture(t);
  const polls = Array.from({ length: 17 }, () => f.call("in"));
  const responses = await Promise.all(polls);
  assert.ok(responses.every(response => response.status === 410));
  for (const response of responses) assert.equal((await response.json()).code, "too_many_polls");
  assert.equal(f.object.waiters.length, 0);
  assert.equal(f.object.status, "ended");
});
