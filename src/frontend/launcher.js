import "./styles.css";
import {
  buildBootstrapCommand,
  decodeSessionFragment,
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
const emptyNode = document.querySelector("#launcher-empty");
const dateTimeFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

let launcher;
let websocket;
let reconnectTimer;
let reconnectDelay = 500;
let stopped = false;
const runs = new Map();

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
  return `/s/${encodeURIComponent(session.sessionId)}#s=${fragment}`;
}

function persistRuns() {
  saveLauncherRuns(launcherId, Array.from(runs.values()));
  // The server replays at most 100 recent runs; keep extra local entries for ended sessions.
  while (runs.size > MAX_LAUNCHER_RUNS) {
    runs.delete(runs.keys().next().value);
  }
}

function openSessionTab(session, record) {
  const tab = window.open(sessionUrl(session), `raijin-${session.sessionId}`);
  if (tab) {
    tab.opener = null;
  }
  record.opened = Boolean(tab);
  persistRuns();
  renderRuns();
}

function renderRuns() {
  emptyNode.hidden = runs.size > 0;
  const cards = Array.from(runs.values()).reverse().map((record) => {
    const session = loadSession(record.sessionId);
    const card = document.createElement("article");
    card.className = "session-history-card";

    const header = document.createElement("div");
    header.className = "session-history-card-header";
    const idNode = document.createElement("code");
    idNode.textContent = record.sessionId;
    const createdNode = document.createElement("span");
    createdNode.className = "session-history-summary";
    createdNode.textContent = dateTimeFormatter.format(record.createdAt);
    header.append(idNode, createdNode);

    const actions = document.createElement("div");
    actions.className = "session-history-actions";
    const note = document.createElement("p");
    note.className = "session-history-summary";
    note.textContent = session
      ? record.opened ? "Session tab opened." : "Open the session tab to connect."
      : "Session ended. Run the command again for a new shell.";
    actions.append(note);

    if (session) {
      const link = document.createElement("a");
      link.className = "secondary-button session-history-link";
      link.href = sessionUrl(session);
      link.target = `raijin-${session.sessionId}`;
      link.rel = "noopener";
      link.textContent = "Open Session";
      link.addEventListener("click", (event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
          return;
        }
        event.preventDefault();
        try {
          openSessionTab(session, record);
        } catch (error) {
          setError(error.message);
        }
      });
      actions.append(link);
    }

    card.append(header, actions);
    return card;
  });
  runsNode.replaceChildren(...cards);
}

function receiveRun(message) {
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(message.runId || "")
      || !/^[A-Za-z0-9_-]{16,128}$/u.test(message.agentToken || "")) {
    throw new Error("The listener received an invalid session.");
  }

  // Run events are replayed after reconnects. Never reopen a tab or replace its credentials.
  if (runs.has(message.runId)) {
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

  const record = { sessionId: session.sessionId, createdAt: session.createdAt, opened: false };
  runs.set(session.sessionId, record);
  try {
    persistRuns();
  } catch (error) {
    runs.delete(session.sessionId);
    throw error;
  }
  renderRuns();
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

window.addEventListener("storage", () => {
  renderRuns();
});
window.addEventListener("pagehide", () => {
  stopped = true;
  window.clearTimeout(reconnectTimer);
  websocket?.close();
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
      runs.set(record.sessionId, record);
    }
    persistRuns();
    commandNode.value = buildBootstrapCommand(launcher, window.location.origin);
    copyButton.disabled = false;
    renderRuns();
    connect(await sha256Base64Url(launcher.agentToken));
  } catch (error) {
    setStatus("unavailable", "Create a new command from the homepage.", "disconnected");
    setError(error instanceof Error ? error.message : "Unable to start the listener.");
  }
}

void start();
