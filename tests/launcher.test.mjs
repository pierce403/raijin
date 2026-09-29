import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Exercise the real frontend with small DOM adapters. Real frame rendering and PTYs
// are checked in browser smoke tests; these checks cover tab ownership and lifecycle.
const storeSource = await readFile(new URL("../src/frontend/session-store.js", import.meta.url), "utf8");
const storeExports = Array.from(storeSource.matchAll(/export (?:async )?(?:function|const) (\w+)/gu), match => match[1]);
const launcherSource = (await readFile(new URL("../src/frontend/launcher.js", import.meta.url), "utf8"))
  .replace('import "./styles.css";', "")
  .replace(/import \{[\s\S]*?\} from "\.\/session-store\.js";/u, "");

class Element {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.hidden = false;
    this.srcWrites = 0;
    this.detachments = 0;
    this.focusCalls = 0;
    this.classList = {
      toggle: (name, force) => {
        const classes = new Set((this.className || "").split(" ").filter(Boolean));
        const add = force ?? !classes.has(name);
        if (add) classes.add(name); else classes.delete(name);
        this.className = Array.from(classes).join(" ");
        return add;
      },
      contains: name => (this.className || "").split(" ").includes(name),
    };
    if (tag === "iframe") {
      this.messages = [];
      this.contentWindow = {
        postMessage: (message, origin) => this.messages.push({ ...message, origin }),
      };
    }
  }
  set src(value) { this._src = value; this.srcWrites += 1; }
  get src() { return this._src; }
  append(...children) {
    for (const child of children) {
      if (child.parentNode) child.remove();
      child.parentNode = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    for (const child of [...this.children]) child.remove();
    this.append(...children);
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
    this.detachments += 1;
  }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  emit(name, event = {}) { return this.listeners.get(name)?.(event); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  focus() { this.focusCalls += 1; }
  scrollIntoView() {}
}

function token() { return randomBytes(32).toString("base64url"); }
function newRun() { return { runId: token(), agentToken: token() }; }
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const data = new Map();
  const storage = {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key),
    key: index => Array.from(data.keys())[index] ?? null,
    get length() { return data.size; },
  };
  const browserToken = token();
  const launcher = {
    sessionId: createHash("sha256").update(browserToken).digest("base64url"),
    browserToken,
    agentToken: token(),
    mode: "interactive",
    command: "",
    readonly: false,
    createdAt: Date.now(),
    idleTimeoutSeconds: 600,
    maxLifetimeSeconds: null,
    reusable: true,
  };
  storage.setItem(`raijin:launcher:${launcher.sessionId}`, JSON.stringify(launcher));
  return { storage, launcher };
}

async function openListener({ storage, launcher }) {
  const nodes = new Map();
  const popupCalls = [];
  const timers = [];
  const windowListeners = new Map();
  const requests = [];
  let endResponse = { ok: true, status: 200, json: async () => ({ ok: true }) };
  class Socket {
    static instances = [];
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.closeCalls = 0;
      Socket.instances.push(this);
    }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    send(value) { this.sent = JSON.parse(value); }
    close() { this.closeCalls += 1; }
    emit(name, event) { this.listeners.get(name)?.(event); }
  }
  const document = {
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, new Element());
      return nodes.get(selector);
    },
    createElement: tag => new Element(tag),
  };
  const window = {
    location: { pathname: `/l/${launcher.sessionId}`, origin: "https://example.test", hash: "" },
    history: { replaceState() {} },
    open(...args) { popupCalls.push(args); throw new Error("Popups are blocked"); },
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    clearTimeout() {},
    requestAnimationFrame(callback) { callback(); },
    addEventListener(name, callback) { windowListeners.set(name, callback); },
  };
  const context = vm.createContext({
    window, document, localStorage: storage,
    navigator: { clipboard: { async writeText() {} } },
    fetch: async (url, options) => { requests.push({ url, options }); return endResponse; },
    WebSocket: Socket, URL, URLSearchParams, Intl, Date,
    crypto: webcrypto, TextEncoder, TextDecoder, btoa, atob,
  });
  vm.runInContext(`${storeSource.replace(/^export /gmu, "")}\nglobalThis.store = {${storeExports.join(",")}};`, context);
  vm.runInContext(launcherSource, context);
  for (let attempt = 0; attempt < 100 && !Socket.instances.length; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(Socket.instances.length, 1, nodes.get("#launcher-error").textContent);
  const socket = Socket.instances[0];
  socket.emit("open", {});
  assert.equal(socket.sent.browserToken, launcher.browserToken);
  assert.equal(socket.sent.agentTokenHash, createHash("sha256").update(launcher.agentToken).digest("base64url"));
  socket.emit("message", { data: JSON.stringify({ type: "ready" }) });
  const headers = () => nodes.get("#launcher-runs").children;
  const panels = () => nodes.get("#launcher-panels").children;
  const header = id => headers().find(node => node.children[0].id === `tab-${id}`);
  const panel = id => panels().find(node => node.id === `panel-${id}`);
  const frame = id => panel(id)?.children[0];
  return {
    nodes, popupCalls, socket, timers, requests, store: context.store,
    headers, panels, header, panel, frame,
    frames: () => panels().map(node => node.children[0]),
    run: message => socket.emit("message", { data: JSON.stringify({ type: "run", ...message }) }),
    select: id => header(id).children[0].emit("click"),
    async close(id) { header(id).children[1].emit("click"); await settle(); },
    setEndResponse(response) { endResponse = response; },
    emit: (type, event = {}) => windowListeners.get(type)?.(event),
    status(id, status, extra = {}) {
      windowListeners.get("message")?.({
        origin: window.location.origin,
        source: frame(id)?.contentWindow,
        data: { type: "raijin:session-status", sessionId: id, status, ...extra },
      });
    },
  };
}

test("each invocation opens its own embedded terminal without popups or replayed credentials", async () => {
  const page = await openListener(fixture());
  const first = newRun();
  const second = newRun();
  page.run(first);
  page.run(second);
  assert.equal(page.frames().length, 2, page.nodes.get("#launcher-error").textContent);
  assert.equal(page.popupCalls.length, 0);
  const child = page.store.loadSession(first.runId);
  assert.equal(child.agentToken, first.agentToken);
  assert.equal(child.reusable, undefined);
  assert.equal(child.idleTimeoutSeconds, 600);
  assert.notEqual(child.browserToken, page.store.loadSession(second.runId).browserToken);
  assert.equal(page.store.listSessionHistory().length, 2);
  assert.equal(page.store.listLaunchers().length, 1);
  for (const run of [first, second]) {
    const url = new URL(page.frame(run.runId).src, "https://example.test");
    assert.equal(url.pathname, `/s/${run.runId}`);
    assert.equal(url.searchParams.get("embedded"), "1");
    const bundle = page.store.decodeSessionFragment(new URLSearchParams(url.hash.slice(1)).get("s"));
    assert.equal(bundle.browserToken, page.store.loadSession(run.runId).browserToken);
  }
  page.run(first);
  assert.equal(page.frames().length, 2);
  assert.equal(page.store.loadSession(first.runId).browserToken, child.browserToken);
  assert.equal(page.panel(first.runId).hidden, true);
  assert.equal(page.panel(second.runId).hidden, false);
});

test("switching keeps both terminal documents mounted and tells each frame whether it is active", async () => {
  const page = await openListener(fixture());
  const first = newRun();
  const second = newRun();
  page.run(first);
  const firstFrame = page.frame(first.runId);
  const firstPanel = page.panel(first.runId);
  page.run(second);
  const secondFrame = page.frame(second.runId);
  const secondPanel = page.panel(second.runId);
  for (const id of [first.runId, second.runId, first.runId]) page.select(id);
  assert.equal(page.frame(first.runId), firstFrame);
  assert.equal(page.frame(second.runId), secondFrame);
  for (const node of [firstFrame, firstPanel, secondFrame, secondPanel]) assert.equal(node.detachments, 0);
  for (const frame of [firstFrame, secondFrame]) assert.equal(frame.srcWrites, 1);
  assert.equal(firstPanel.hidden, false);
  assert.equal(secondPanel.hidden, true);
  assert.deepEqual(firstFrame.messages.at(-1), {
    type: "raijin:activate", sessionId: first.runId, active: true, focusTerminal: true, origin: "https://example.test",
  });
  assert.deepEqual(secondFrame.messages.at(-1), {
    type: "raijin:activate", sessionId: second.runId, active: false, focusTerminal: true, origin: "https://example.test",
  });
  // A delayed load/status from the background shell must not select its tab.
  secondFrame.emit("load");
  page.status(second.runId, "connected");
  assert.equal(firstPanel.hidden, false);
  assert.equal(secondPanel.hidden, true);
  assert.equal(page.header(first.runId).children[0].getAttribute("aria-selected"), "true");
});

test("arrow navigation keeps focus on the tab strip while click selection focuses the terminal", async () => {
  const page = await openListener(fixture());
  const first = newRun();
  const second = newRun();
  page.run(first);
  page.run(second);
  const firstButton = page.header(first.runId).children[0];
  const secondButton = page.header(second.runId).children[0];
  let prevented = false;
  secondButton.emit("keydown", { key: "ArrowLeft", preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(firstButton.focusCalls, 1);
  assert.equal(firstButton.getAttribute("aria-selected"), "true");
  assert.equal(page.frame(first.runId).messages.at(-1).active, true);
  assert.equal(page.frame(first.runId).messages.at(-1).focusTerminal, false);
  assert.equal(page.frame(second.runId).messages.at(-1).active, false);
  assert.equal(page.frame(second.runId).messages.at(-1).focusTerminal, false);
  firstButton.emit("keydown", { key: "ArrowRight", preventDefault() {} });
  assert.equal(secondButton.focusCalls, 1);
  assert.equal(page.frame(second.runId).messages.at(-1).focusTerminal, false);
  page.select(first.runId);
  assert.equal(page.frame(first.runId).messages.at(-1).focusTerminal, true);
});

test("closing a live tab ends only its child session and leaves the listener and other frame running", async () => {
  const setup = fixture();
  const page = await openListener(setup);
  const first = newRun();
  const second = newRun();
  page.run(first);
  page.run(second);
  const firstToken = page.store.loadSession(first.runId).browserToken;
  const otherFrame = page.frame(second.runId);
  await page.close(first.runId);
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].url, `/api/sessions/${first.runId}/end`);
  assert.equal(page.requests[0].options.method, "POST");
  assert.equal(page.requests[0].options.headers.authorization, `Bearer ${firstToken}`);
  assert.equal(page.frame(first.runId), undefined);
  assert.equal(page.store.loadSession(first.runId), null);
  assert.equal(page.frame(second.runId), otherFrame);
  assert.equal(otherFrame.srcWrites, 1);
  assert.equal(otherFrame.detachments, 0);
  assert.equal(page.socket.closeCalls, 0);
  page.run(first);
  assert.equal(page.frames().length, 1);
  const record = page.store.loadLauncherRuns(setup.launcher.sessionId).find(item => item.sessionId === first.runId);
  assert.equal(record.ended, true);
});

test("a failed end request keeps its tab available for retry", async () => {
  const page = await openListener(fixture());
  const run = newRun();
  page.run(run);
  const frame = page.frame(run.runId);
  page.setEndResponse({ ok: false, status: 500, json: async () => ({ error: "Try again" }) });
  await page.close(run.runId);
  assert.equal(page.frame(run.runId), frame);
  assert.equal(page.header(run.runId).children[1].disabled, false);
  assert.equal(page.nodes.get("#launcher-error").textContent, "Try again");
  assert.ok(page.store.loadSession(run.runId));
  page.setEndResponse({ ok: true, status: 200 });
  await page.close(run.runId);
  assert.equal(page.frames().length, 0);
});

test("only the matching same-origin frame can change its session tab status", async () => {
  const page = await openListener(fixture());
  const first = newRun();
  const second = newRun();
  page.run(first);
  page.run(second);
  const firstButton = page.header(first.runId).children[0];
  const statusNode = firstButton.children[1];
  const originalStatus = statusNode.textContent;
  const data = { type: "raijin:session-status", sessionId: first.runId, status: "agent_closed" };
  for (const event of [
    { origin: "https://elsewhere.test", source: page.frame(first.runId).contentWindow, data },
    { origin: "https://example.test", source: page.frame(second.runId).contentWindow, data },
    { origin: "https://example.test", source: {}, data },
    { origin: "https://example.test", source: page.frame(first.runId).contentWindow, data: { ...data, status: "untrusted" } },
    { origin: "https://example.test", source: page.frame(first.runId).contentWindow, data: { ...data, type: "close" } },
  ]) page.emit("message", event);
  assert.equal(statusNode.textContent, originalStatus);
  assert.equal(page.frames().length, 2);
  assert.equal(page.requests.length, 0);
  page.status(first.runId, "connected", { remoteIp: "192.0.2.12" });
  assert.equal(statusNode.textContent, "connected");
  assert.equal(firstButton.children[0].textContent, "192.0.2.12");
  assert.equal(page.panel(first.runId).hidden, true);
  page.status(first.runId, "agent_closed");
  assert.equal(statusNode.textContent, "exited");
  page.store.deleteSession(first.runId);
  await page.close(first.runId);
  assert.equal(page.requests.length, 0);
  page.run(first);
  assert.equal(page.frames().length, 1);
});

test("pagehide records ended children so reload and run replay do not resurrect closed shells", async () => {
  const setup = fixture();
  const page = await openListener(setup);
  const first = newRun();
  const second = newRun();
  page.run(first);
  page.run(second);
  page.status(first.runId, "agent_closed");
  page.store.deleteSession(first.runId);
  page.emit("pagehide");
  assert.equal(page.socket.closeCalls, 1);
  const reloaded = await openListener(setup);
  assert.equal(reloaded.frames().length, 0);
  reloaded.run(first);
  reloaded.run(second);
  assert.equal(reloaded.frames().length, 0);
  const fresh = newRun();
  reloaded.run(fresh);
  assert.equal(reloaded.frames().length, 1);
  assert.equal(reloaded.store.loadSession(first.runId), null);
});

test("recent ended runs stay deduplicated while saved run history remains bounded", async () => {
  const setup = fixture();
  const page = await openListener(setup);
  const invocations = Array.from({ length: 250 }, newRun);
  for (const run of invocations) {
    page.run(run);
    page.status(run.runId, "agent_closed");
    page.store.deleteSession(run.runId);
    await page.close(run.runId);
  }
  assert.equal(page.frames().length, 0);
  assert.equal(page.headers().length, 0);
  assert.equal(page.store.loadLauncherRuns(setup.launcher.sessionId).length, 200);
  assert.equal(JSON.parse(setup.storage.getItem(`raijin:launcher-runs:${setup.launcher.sessionId}`)).length, 200);
  const recentRuns = invocations.slice(-100);
  const reloaded = await openListener(setup);
  for (const run of recentRuns) reloaded.run(run);
  assert.equal(reloaded.frames().length, 0);
  for (const run of recentRuns) assert.equal(reloaded.store.loadSession(run.runId), null);
});

test("replacement closes stop reconnecting and transient disconnects retry", async () => {
  const replaced = await openListener(fixture());
  replaced.socket.emit("close", { code: 1008 });
  assert.equal(replaced.timers.length, 0);
  assert.equal(replaced.nodes.get("#launcher-status").textContent, "disconnected");
  const disconnected = await openListener(fixture());
  disconnected.socket.emit("close", { code: 1006 });
  assert.equal(disconnected.timers.length, 1);
  assert.equal(disconnected.timers[0].delay, 500);
});

test("child tabs copy the reusable command without carrying the listener's browser token", async () => {
  const setup = fixture();
  const page = await openListener(setup);
  const config = session => {
    const command = page.store.buildBootstrapCommand(session, "https://example.test");
    return JSON.parse(Buffer.from(command.match(/bootstrap\?c=([^']+)/u)[1], "base64url").toString());
  };
  assert.equal(config(setup.launcher).reusable, true);
  const run = newRun();
  page.run(run);
  const child = page.store.loadSession(run.runId);
  const childConfig = config(child);
  assert.equal(childConfig.reusable, true);
  assert.equal(childConfig.sessionId, setup.launcher.sessionId);
  assert.equal(childConfig.token, setup.launcher.agentToken);
  const fragment = new URL(page.frame(run.runId).src, "https://example.test").hash;
  const bundle = page.store.decodeSessionFragment(new URLSearchParams(fragment.slice(1)).get("s"));
  assert.equal(bundle.launcherId, setup.launcher.sessionId);
  assert.equal(bundle.browserToken, child.browserToken);
  assert.ok(!JSON.stringify(bundle).includes(setup.launcher.browserToken));

  const { launcherId, ...legacy } = child;
  assert.equal(config(legacy).reusable, undefined);
  assert.equal(config(legacy).sessionId, child.sessionId);
  setup.storage.removeItem(`raijin:launcher:${setup.launcher.sessionId}`);
  assert.equal(config(child).reusable, undefined);
  assert.equal(config(child).sessionId, child.sessionId);
});
