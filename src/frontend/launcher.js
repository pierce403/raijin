import "./styles.css";
import {
  buildBootstrapCommand,
  decodeSessionFragment,
  deleteSession,
  encodeSessionFragment,
  loadLauncher,
  loadLauncherRuns,
  loadSession,
  MAX_LAUNCHER_RUNS,
  randomToken,
  saveLauncher,
  saveLauncherRuns,
  saveSession,
  sha256Base64Url,
} from "./session-store.js";

const launcherId = window.location.pathname.split("/").filter(Boolean).at(-1);
const statusNode = document.querySelector("#launcher-status");
const statusCopyNode = document.querySelector("#launcher-status-copy");
const errorNode = document.querySelector("#launcher-error");
const commandNode = document.querySelector("#bootstrap-command");
const copyButton = document.querySelector("#copy-command");
const runsNode = document.querySelector("#launcher-runs");
const panelsNode = document.querySelector("#launcher-panels");
const emptyNode = document.querySelector("#launcher-empty");
const commandDetails = document.querySelector("#launcher-command-details");
const endedStatuses = new Set(["expired", "disconnected", "ended", "agent_closed"]);
const sessionStatuses = new Set(["waiting_for_browser", "waiting_for_agent", "connected", ...endedStatuses]);

let launcher;
let websocket;
let reconnectTimer;
let reconnectDelay = 500;
let stopped = false;
const runs = new Map();
const tabs = new Map();
let activeSessionId;

function setError(message) {
  errorNode.textContent = message;
  errorNode.hidden = !message;
}

function setStatus(label, message, type = "waiting") {
  statusNode.textContent = label;
  statusNode.className = `status-badge status-${type}`;
  statusCopyNode.textContent = message;
}

function sessionUrl(session) {
  const fragment = encodeURIComponent(encodeSessionFragment(session));
  return `/s/${encodeURIComponent(session.sessionId)}?embedded=1#s=${fragment}`;
}

function persistRuns() {
  // The server replays at most 100 recent runs; keep extra local entries for ended sessions.
  while (runs.size > MAX_LAUNCHER_RUNS) {
    runs.delete(runs.keys().next().value);
  }
  saveLauncherRuns(launcherId, Array.from(runs.values()));
}

function activateSession(sessionId, focusTab = false) {
  const selected = tabs.get(sessionId);
  if (!selected) {
    return;
  }
  activeSessionId = sessionId;
  for (const [id, tab] of tabs) {
    const active = id === sessionId;
    tab.button.setAttribute("aria-selected", String(active));
    tab.button.tabIndex = active ? 0 : -1;
    tab.panel.hidden = !active;
    tab.header.classList.toggle("is-active", active);
    tab.frame.contentWindow?.postMessage({
      type: "raijin:activate", sessionId: id, active, focusTerminal: !focusTab,
    }, window.location.origin);
  }
  selected.button.scrollIntoView({ block: "nearest", inline: "nearest" });
  if (focusTab) {
    selected.button.focus();
  }
}

function updateTab(tab) {
  const { record } = tab;
  const status = record.status || "waiting_for_browser";
  tab.label.textContent = record.remoteIp || record.sessionId.slice(0, 8);
  tab.status.textContent = status === "agent_closed" ? "exited" : status.replaceAll("_", " ");
  tab.header.classList.toggle("is-ended", Boolean(record.ended));
  tab.button.title = `${record.sessionId}: ${tab.status.textContent}`;
  tab.close.setAttribute("aria-label", `${record.ended ? "Close" : "End and close"} session ${record.sessionId}`);
}

async function closeSessionTab(sessionId) {
  const tab = tabs.get(sessionId);
  if (!tab || tab.close.disabled) {
    return;
  }
  tab.close.disabled = true;
  try {
    const session = loadSession(sessionId);
    if (!tab.record.ended && session) {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/end`, {
        method: "POST",
        headers: { authorization: `Bearer ${session.browserToken}` },
      });
      if (!response.ok && response.status !== 404 && response.status !== 410) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Unable to end the session. Try closing it again.");
      }
    }
    tab.record.ended = true;
    tab.record.status = "ended";
    persistRuns();
    deleteSession(sessionId);
    const ids = Array.from(tabs.keys());
    const index = ids.indexOf(sessionId);
    tabs.delete(sessionId);
    tab.header.remove();
    tab.panel.remove();
    if (activeSessionId === sessionId) {
      activeSessionId = undefined;
      activateSession(ids[index + 1] || ids[index - 1]);
    }
    emptyNode.hidden = tabs.size > 0;
    if (!tabs.size) {
      commandDetails.open = true;
    }
    setError("");
  } catch (error) {
    tab.close.disabled = false;
    setError(error instanceof Error ? error.message : "Unable to close the session.");
  }
}

function openSessionTab(session, record) {
  if (tabs.has(session.sessionId) || record.ended) {
    return;
  }
  const header = document.createElement("div");
  header.className = "terminal-tab";
  header.setAttribute("role", "presentation");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "terminal-tab-select";
  button.id = `tab-${session.sessionId}`;
  button.setAttribute("role", "tab");
  button.setAttribute("aria-controls", `panel-${session.sessionId}`);
  const label = document.createElement("span");
  label.className = "terminal-tab-label";
  const status = document.createElement("span");
  status.className = "terminal-tab-status";
  button.append(label, status);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "terminal-tab-close";
  close.textContent = "×";
  close.title = "Close session";
  header.append(button, close);

  const panel = document.createElement("section");
  panel.className = "terminal-tab-panel";
  panel.id = `panel-${session.sessionId}`;
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-labelledby", button.id);
  const frame = document.createElement("iframe");
  frame.className = "terminal-session-frame";
  frame.title = `Terminal session ${session.sessionId}`;
  frame.src = sessionUrl(session);
  frame.allow = "clipboard-read; clipboard-write";
  panel.append(frame);

  const tab = { header, button, label, status, close, panel, frame, record };
  tabs.set(session.sessionId, tab);
  updateTab(tab);
  button.addEventListener("click", () => activateSession(session.sessionId));
  button.addEventListener("keydown", (event) => {
    const ids = Array.from(tabs.keys());
    const index = ids.indexOf(session.sessionId);
    const next = {
      ArrowLeft: ids[(index + ids.length - 1) % ids.length],
      ArrowRight: ids[(index + 1) % ids.length],
      Home: ids[0],
      End: ids.at(-1),
    }[event.key];
    if (next) {
      event.preventDefault();
      activateSession(next, true);
    } else if (event.key === "Delete") {
      event.preventDefault();
      void closeSessionTab(session.sessionId);
    }
  });
  close.addEventListener("click", () => { void closeSessionTab(session.sessionId); });
  frame.addEventListener("load", () => {
    frame.contentWindow?.postMessage({
      type: "raijin:activate", sessionId: session.sessionId, active: activeSessionId === session.sessionId,
    }, window.location.origin);
  });
  runsNode.append(header);
  panelsNode.append(panel);
  emptyNode.hidden = true;
  commandDetails.open = false;
  activateSession(session.sessionId);
}

function receiveRun(message) {
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(message.runId || "")
      || !/^[A-Za-z0-9_-]{16,128}$/u.test(message.agentToken || "")) {
    throw new Error("The listener received an invalid session.");
  }

  // Run events are replayed after reconnects. Never reopen a tab or replace its credentials.
  if (runs.has(message.runId) || tabs.has(message.runId)) {
    return;
  }

  const existing = loadSession(message.runId);
  if (existing && existing.agentToken !== message.agentToken) {
    throw new Error("The session credentials do not match the saved session.");
  }

  const session = existing || {
    sessionId: message.runId,
    launcherId,
    browserToken: randomToken(32),
    agentToken: message.agentToken,
    mode: launcher.mode,
    command: launcher.command,
    readonly: launcher.readonly,
    idleTimeoutSeconds: launcher.idleTimeoutSeconds,
    maxLifetimeSeconds: launcher.maxLifetimeSeconds,
    createdAt: Date.now(),
  };
  saveSession(session);
  if (loadSession(session.sessionId)?.browserToken !== session.browserToken) {
    throw new Error("Unable to save the session in this browser. Check available browser storage.");
  }

  const record = { sessionId: session.sessionId, createdAt: session.createdAt, status: "waiting_for_browser", ended: false };
  runs.set(session.sessionId, record);
  try {
    persistRuns();
  } catch (error) {
    runs.delete(session.sessionId);
    throw error;
  }
  openSessionTab(session, record);
}

function connect(agentTokenHash) {
  if (stopped) {
    return;
  }
  setStatus("connecting", "Connecting the listener...");
  const url = new URL(`/connect/launcher/${encodeURIComponent(launcherId)}`, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  websocket = new WebSocket(url);
  websocket.addEventListener("open", () => {
    websocket.send(JSON.stringify({
      type: "hello",
      browserToken: launcher.browserToken,
      agentTokenHash,
    }));
  });
  websocket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === "ready") {
        reconnectDelay = 500;
        setStatus("listening", "Ready for the next run.", "connected");
        setError("");
      } else if (message.type === "run") {
        receiveRun(message);
      } else if (message.type === "error") {
        setError(message.error || message.message || "The listener could not handle this request.");
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to open the session.");
    }
  });
  websocket.addEventListener("close", (event) => {
    if (stopped) {
      return;
    }
    if (event.code === 1008) {
      stopped = true;
      setStatus("disconnected", "This listener was replaced or rejected. Reload to reconnect.", "disconnected");
      return;
    }
    setStatus("reconnecting", "Connection lost. Reconnecting...");
    reconnectTimer = window.setTimeout(() => connect(agentTokenHash), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 5000);
  });
}

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(commandNode.value);
    copyButton.textContent = "Copied";
    window.setTimeout(() => { copyButton.textContent = "Copy Command"; }, 1500);
  } catch {
    setError("Unable to copy the command. Select and copy the text above.");
  }
});

window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin || event.data?.type !== "raijin:session-status") {
    return;
  }
  const tab = tabs.get(event.data.sessionId);
  if (!tab || event.source !== tab.frame.contentWindow || !sessionStatuses.has(event.data.status)) {
    return;
  }
  tab.record.status = event.data.status;
  if (typeof event.data.remoteIp === "string") {
    tab.record.remoteIp = event.data.remoteIp.slice(0, 64);
  }
  if (endedStatuses.has(event.data.status)) {
    tab.record.ended = true;
  }
  updateTab(tab);
  try {
    persistRuns();
  } catch (error) {
    setError(error.message);
  }
});
window.addEventListener("pagehide", () => {
  stopped = true;
  window.clearTimeout(reconnectTimer);
  websocket?.close();
  // Leaving this page closes its browser sockets, which terminates the shells.
  // Keep their tombstones so replays cannot recreate terminated runs on reload.
  for (const tab of tabs.values()) {
    tab.record.ended = true;
  }
  try {
    persistRuns();
  } catch {
    // Navigation must still finish when browser storage is unavailable.
  }
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    window.location.reload();
  }
});

async function start() {
  try {
    const encoded = new URLSearchParams(window.location.hash.slice(1)).get("s");
    const candidate = encoded ? decodeSessionFragment(encoded) : null;
    launcher = candidate?.sessionId === launcherId ? candidate : loadLauncher(launcherId);
    if (!launcher?.reusable || !launcher.browserToken || !launcher.agentToken) {
      throw new Error("The reusable command was not found in this browser. Create a new one from the homepage.");
    }
    saveLauncher({ ...launcher, lastOpenedAt: Date.now() });
    if (encoded) {
      window.history.replaceState(null, "", window.location.pathname);
    }
    for (const record of loadLauncherRuns(launcherId)) {
      if (!loadSession(record.sessionId)) {
        record.ended = true;
      }
      runs.set(record.sessionId, record);
    }
    persistRuns();
    commandNode.value = buildBootstrapCommand(launcher, window.location.origin);
    copyButton.disabled = false;
    for (const record of runs.values()) {
      const session = loadSession(record.sessionId);
      if (session && !record.ended) {
        openSessionTab(session, record);
      }
    }
    connect(await sha256Base64Url(launcher.agentToken));
  } catch (error) {
    setStatus("unavailable", "Create a new command from the homepage.", "disconnected");
    setError(error instanceof Error ? error.message : "Unable to start the listener.");
  }
}

void start();
