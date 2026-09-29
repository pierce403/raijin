import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Run the real frontend with small browser adapters. Actual tab rendering is covered by browser smoke tests.
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
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
}

function token() { return randomBytes(32).toString("base64url"); }
function newRun() { return { runId: token(), agentToken: token() }; }

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

async function openListener({ storage, launcher }, { blockPopups = false } = {}) {
  const nodes = new Map();
  const tabs = [];
  const timers = [];
  let popupsBlocked = blockPopups;
  class Socket {
    static instances = [];
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      Socket.instances.push(this);
    }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    send(value) { this.sent = JSON.parse(value); }
    close() {}
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
    open(url, name) {
      const tab = popupsBlocked ? null : { opener: {} };
      tabs.push({ url, name, tab });
      return tab;
    },
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    clearTimeout() {},
    addEventListener() {},
  };
  const context = vm.createContext({
    window, document, localStorage: storage,
    navigator: { clipboard: { async writeText() {} } },
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
  return {
    nodes, tabs, socket, timers, store: context.store,
    allowPopups() { popupsBlocked = false; },
    run: message => socket.emit("message", { data: JSON.stringify({ type: "run", ...message }) }),
  };
}

test("each invocation gets an isolated tab; replay and reload preserve existing credentials", async () => {
  const setup = fixture();
  const page = await openListener(setup);
  const first = newRun();
  const second = newRun();
  page.run(first);
  page.run(second);
  assert.equal(page.tabs.length, 2);
  assert.notEqual(page.tabs[0].name, page.tabs[1].name);
  assert.equal(page.tabs[0].tab.opener, null);
  const child = page.store.loadSession(first.runId);
  assert.equal(child.agentToken, first.agentToken);
  assert.equal(child.reusable, undefined);
  assert.equal(child.idleTimeoutSeconds, 600);
  assert.notEqual(child.browserToken, page.store.loadSession(second.runId).browserToken);
  assert.equal(page.store.listSessionHistory().length, 2);
  assert.equal(page.store.listLaunchers().length, 1);

  page.run(first);
  assert.equal(page.tabs.length, 2);
  const reloaded = await openListener(setup);
  reloaded.run(first);
  reloaded.run(second);
  assert.equal(reloaded.tabs.length, 0);
  assert.equal(reloaded.store.loadSession(first.runId).browserToken, child.browserToken);
  reloaded.store.deleteSession(first.runId);
  reloaded.run(first);
  assert.equal(reloaded.store.loadSession(first.runId), null);
  assert.equal(reloaded.tabs.length, 0);
});

test("blocked popups leave a working manual link without repeatedly opening tabs", async () => {
  const page = await openListener(fixture(), { blockPopups: true });
  const run = newRun();
  page.run(run);
  page.run(run);
  assert.equal(page.tabs.length, 1);
  assert.equal(page.tabs[0].tab, null);
  const actions = page.nodes.get("#launcher-runs").children[0].children[1];
  const link = actions.children.find(child => child.tag === "a");
  assert.equal(link.textContent, "Open Session");
  assert.equal(link.rel, "noopener");
  const url = new URL(link.href, "https://example.test");
  assert.equal(url.pathname, `/s/${run.runId}`);
  const bundle = page.store.decodeSessionFragment(new URLSearchParams(url.hash.slice(1)).get("s"));
  assert.equal(bundle.browserToken, page.store.loadSession(run.runId).browserToken);
  page.allowPopups();
  let prevented = false;
  link.listeners.get("click")({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(page.tabs.length, 2);
  assert.equal(page.tabs[1].tab.opener, null);
});

test("the run index and rendered list stay bounded while recent ended runs remain deduplicated", async () => {
  const setup = fixture();
  const page = await openListener(setup, { blockPopups: true });
  const invocations = Array.from({ length: 250 }, newRun);
  for (const run of invocations) page.run(run);
  assert.equal(page.tabs.length, 250);
  assert.equal(page.store.loadLauncherRuns(setup.launcher.sessionId).length, 200);
  assert.equal(page.nodes.get("#launcher-runs").children.length, 200);
  assert.equal(JSON.parse(setup.storage.getItem(`raijin:launcher-runs:${setup.launcher.sessionId}`)).length, 200);

  const recentRuns = invocations.slice(-100);
  for (const run of recentRuns) page.store.deleteSession(run.runId);
  const reloaded = await openListener(setup);
  for (const run of recentRuns) reloaded.run(run);
  assert.equal(reloaded.tabs.length, 0);
  assert.equal(reloaded.nodes.get("#launcher-runs").children.length, 200);
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
  const fragment = new URL(page.tabs[0].url, "https://example.test").hash;
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
