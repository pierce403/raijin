import "@xterm/xterm/css/xterm.css";
import "./styles.css";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  buildBootstrapCommand,
  decodeSessionFragment,
  deleteSession,
  loadSession,
  saveSession,
  sha256Base64Url,
} from "./session-store.js";

const statusBadge = document.querySelector("#status-badge");
const statusCopy = document.querySelector("#status-copy");
const modeLabel = document.querySelector("#mode-label");
const sessionIdNode = document.querySelector("#session-id");
const bootstrapNode = document.querySelector("#bootstrap-command");
const copyButton = document.querySelector("#copy-command");
const endButton = document.querySelector("#end-session");
const errorNode = document.querySelector("#session-error");
const terminalContainer = document.querySelector("#terminal");

const sessionId = window.location.pathname.split("/").filter(Boolean).at(-1);

const terminal = new Terminal({
  allowTransparency: false,
  cursorBlink: true,
  fontFamily: '"IBM Plex Mono", "SFMono-Regular", monospace',
  fontSize: 14,
  scrollback: 5000,
  theme: {
    background: "#050505",
    foreground: "#f6f1eb",
    cursor: "#ffab4d",
    black: "#090909",
    brightBlack: "#50433a",
    red: "#ff7657",
    brightRed: "#ff9e89",
    green: "#89d39b",
    brightGreen: "#b4eac1",
    yellow: "#f1bf73",
    brightYellow: "#ffd89f",
    blue: "#71b5ff",
    brightBlue: "#a6d1ff",
    magenta: "#e9a4ff",
    brightMagenta: "#f4c5ff",
    cyan: "#85ddd8",
    brightCyan: "#b5f3ef",
    white: "#e8ddd2",
    brightWhite: "#fff5ea",
  },
});

const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);
terminal.open(terminalContainer);

let websocket;
let sessionInfo;
let ended = false;
let inputDisposable;

function clearLocalSession() {
  deleteSession(sessionId);
}

function setError(message) {
  if (!message) {
    errorNode.hidden = true;
    errorNode.textContent = "";
    return;
  }
  errorNode.hidden = false;
  errorNode.textContent = message;
}

function setStatus(status) {
  const normalized = status || "waiting_for_agent";
  const label = normalized.replaceAll("_", " ");
  const badgeType = normalized.startsWith("waiting")
    ? "waiting"
    : normalized === "connected"
      ? "connected"
      : normalized.startsWith("agent")
        ? "agent"
        : normalized;

  statusBadge.textContent = label;
  statusBadge.className = `status-badge status-${badgeType}`;

  const copyMap = {
    waiting_for_browser: "Waiting for browser...",
    waiting_for_agent: "Listening for connection...",
    connected: "Remote shell connected.",
    expired: "Session expired.",
    disconnected: "Browser disconnected. Session terminated.",
    ended: "Session ended.",
    agent_closed: "Remote shell exited.",
  };

  statusCopy.textContent = copyMap[normalized] || label;

}

function decodeBase64ToBytes(base64) {
  const text = window.atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index);
  }
  return bytes;
}

function safeWriteLine(text) {
  terminal.writeln(text.replace(/\n/g, "\r\n"));
}

function loadSessionFromFragment() {
  const fragmentParams = new URLSearchParams(window.location.hash.slice(1));
  const encoded = fragmentParams.get("s");
  if (!encoded) {
    return null;
  }

  const candidate = decodeSessionFragment(encoded);
  if (!candidate || candidate.sessionId !== sessionId) {
    return null;
  }

  saveSession(candidate);
  window.history.replaceState(null, "", window.location.pathname);
  return candidate;
}

function sendMessage(message) {
  if (!websocket || websocket.readyState !== WebSocket.OPEN || ended) {
    return;
  }
  websocket.send(JSON.stringify(message));
}

function attachTerminalIO() {
  if (sessionInfo.readonly) {
    safeWriteLine("[readonly mode] keyboard input is disabled.");
    return;
  }

  inputDisposable = terminal.onData((data) => {
    sendMessage({ type: "stdin", data });
  });
}

function detachTerminalIO() {
  inputDisposable?.dispose();
  inputDisposable = undefined;
}

function fitTerminalAndNotify() {
  fitAddon.fit();
  sendMessage({
    type: "resize",
    cols: terminal.cols,
    rows: terminal.rows,
  });
}

function handleSocketMessage(event) {
  const message = JSON.parse(event.data);

  if (message.type === "status") {
    setStatus(message.status);
    if (message.status === "connected") {
      terminal.focus();
    }
    if (["expired", "disconnected", "ended", "agent_closed"].includes(message.status)) {
      ended = true;
      endButton.disabled = true;
      detachTerminalIO();
      clearLocalSession();
    }
    return;
  }

  if (message.type === "output" && message.data) {
    terminal.write(decodeBase64ToBytes(message.data));
    return;
  }

  if (message.type === "notice" && message.message) {
    safeWriteLine(`[raijin] ${message.message}`);
  }
}

async function connectBrowserSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const websocketUrl = new URL(`/connect/browser/${sessionId}`, window.location.origin);
  websocketUrl.protocol = protocol;

  websocket = new WebSocket(websocketUrl);

  websocket.addEventListener("open", async () => {
    const agentTokenHash = await sha256Base64Url(sessionInfo.agentToken);

    websocket.send(JSON.stringify({
      type: "hello",
      browserToken: sessionInfo.browserToken,
      agentTokenHash,
      mode: sessionInfo.mode,
      command: sessionInfo.command,
      readonly: sessionInfo.readonly,
      createdAt: sessionInfo.createdAt,
      idleTimeoutSeconds: sessionInfo.idleTimeoutSeconds,
      maxLifetimeSeconds: sessionInfo.maxLifetimeSeconds,
    }));

    fitTerminalAndNotify();
  });

  websocket.addEventListener("message", handleSocketMessage);

  websocket.addEventListener("close", () => {
    if (!ended) {
      setStatus("disconnected");
      safeWriteLine("[raijin] browser websocket closed.");
      detachTerminalIO();
    }
  });

  websocket.addEventListener("error", () => {
    setError("Browser websocket error.");
  });
}

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(bootstrapNode.value);
    copyButton.textContent = "Copied";
    window.setTimeout(() => {
      copyButton.textContent = "Copy Command";
    }, 1500);
  } catch {
    setError("Unable to copy bootstrap command.");
  }
});

endButton.addEventListener("click", async () => {
  endButton.disabled = true;
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/end`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sessionInfo.browserToken}`,
      },
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "Unable to end session.");
    }

    ended = true;
    setStatus("ended");
    safeWriteLine("[raijin] session terminated.");
    detachTerminalIO();
    clearLocalSession();
    websocket?.close(1000, "session ended");
  } catch (error) {
    setError(error instanceof Error ? error.message : "Unable to end session.");
    endButton.disabled = false;
  }
});

window.addEventListener("resize", () => {
  fitTerminalAndNotify();
});

window.addEventListener("beforeunload", () => {
  if (websocket && websocket.readyState === WebSocket.OPEN) {
    websocket.close(1000, "page unload");
  }
});

async function init() {
  try {
    sessionInfo = loadSession(sessionId) || loadSessionFromFragment();
    if (!sessionInfo) {
      throw new Error("Session metadata was not found for this origin.");
    }

    sessionIdNode.textContent = sessionInfo.sessionId;
    modeLabel.textContent = sessionInfo.mode;
    bootstrapNode.value = buildBootstrapCommand(sessionInfo, window.location.origin);
    setStatus("waiting_for_browser");
    attachTerminalIO();
    await connectBrowserSocket();
  } catch (error) {
    ended = true;
    endButton.disabled = true;
    setError(error instanceof Error ? error.message : "Unable to initialize session.");
    setStatus("expired");
    safeWriteLine("[raijin] session unavailable.");
  }
}

init();
