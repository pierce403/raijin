import "@xterm/xterm/css/xterm.css";
import "./styles.css";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  appendSessionTranscript,
  buildSessionTranscriptText,
  buildBootstrapCommand,
  decodeSessionFragment,
  deleteSession,
  loadSession,
  loadSessionTranscript,
  saveSession,
  sha256Base64Url,
  upsertSessionHistory,
} from "./session-store.js";

const statusBadge = document.querySelector("#status-badge");
const statusCopy = document.querySelector("#status-copy");
const modeLabel = document.querySelector("#mode-label");
const sessionIdNode = document.querySelector("#session-id");
const remoteIpNode = document.querySelector("#remote-ip");
const bootstrapOverlay = document.querySelector("#bootstrap-overlay");
const bootstrapNode = document.querySelector("#bootstrap-command");
const copyButton = document.querySelector("#copy-command");
const downloadTranscriptButton = document.querySelector("#download-transcript");
const endButton = document.querySelector("#end-session");
const errorNode = document.querySelector("#session-error");
const terminalStage = document.querySelector(".terminal-stage");
const terminalContainer = document.querySelector("#terminal");
const txIndicator = document.querySelector("#tx-indicator");
const rxIndicator = document.querySelector("#rx-indicator");
const txCountNode = document.querySelector("#tx-count");
const rxCountNode = document.querySelector("#rx-count");

const sessionId = window.location.pathname.split("/").filter(Boolean).at(-1);
const encoder = new TextEncoder();
const outputDecoder = new TextDecoder();
const platform = navigator.userAgentData?.platform || navigator.platform || "";
const isApplePlatform = /mac|iphone|ipad/i.test(platform);
const TRANSCRIPT_FLUSH_DELAY_MS = 400;

const terminal = new Terminal({
  allowTransparency: false,
  cursorBlink: true,
  cursorInactiveStyle: "outline",
  cursorStyle: "block",
  fontFamily: '"IBM Plex Mono", "SFMono-Regular", monospace',
  fontSize: 14,
  scrollback: 5000,
  theme: {
    background: "#050505",
    foreground: "#f6f1eb",
    cursor: "#ffab4d",
    cursorAccent: "#050505",
    selectionBackground: "rgba(255, 171, 77, 0.28)",
    selectionInactiveBackground: "rgba(255, 171, 77, 0.2)",
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
terminal.attachCustomKeyEventHandler((event) => {
  if (shouldCopySelection(event)) {
    event.preventDefault();
    void copyTerminalSelection();
    return false;
  }

  if (shouldPasteFromClipboard(event)) {
    event.preventDefault();
    void pasteFromClipboard();
    return false;
  }

  return true;
});

let websocket;
let sessionInfo;
let ended = false;
let inputDisposable;
let currentStatus = "waiting_for_browser";
let txBytes = 0;
let rxBytes = 0;
let flashTimer;
let transcriptFlushTimer;
const transcriptBuffers = { tx: "", rx: "" };
const trafficTimers = new WeakMap();

function clearLocalSession() {
  flushTranscriptBuffers();
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

function formatTraffic(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderTraffic() {
  txCountNode.textContent = formatTraffic(txBytes);
  rxCountNode.textContent = formatTraffic(rxBytes);
}

function pulseIndicator(node) {
  if (!node) {
    return;
  }

  node.classList.remove("is-active");
  void node.offsetWidth;
  node.classList.add("is-active");

  const existingTimer = trafficTimers.get(node);
  if (existingTimer) {
    window.clearTimeout(existingTimer);
  }

  const timer = window.setTimeout(() => {
    node.classList.remove("is-active");
    trafficTimers.delete(node);
  }, 260);

  trafficTimers.set(node, timer);
}

function recordTraffic(direction, size) {
  if (!Number.isFinite(size) || size <= 0) {
    return;
  }

  if (direction === "tx") {
    txBytes += size;
    renderTraffic();
    pulseIndicator(txIndicator);
    return;
  }

  rxBytes += size;
  renderTraffic();
  pulseIndicator(rxIndicator);
}

function flushTranscriptBuffers() {
  if (transcriptFlushTimer) {
    window.clearTimeout(transcriptFlushTimer);
    transcriptFlushTimer = undefined;
  }

  if (!sessionInfo?.sessionId) {
    transcriptBuffers.tx = "";
    transcriptBuffers.rx = "";
    return;
  }

  if (transcriptBuffers.tx) {
    appendSessionTranscript(sessionInfo.sessionId, "tx", transcriptBuffers.tx);
    transcriptBuffers.tx = "";
  }

  if (transcriptBuffers.rx) {
    appendSessionTranscript(sessionInfo.sessionId, "rx", transcriptBuffers.rx);
    transcriptBuffers.rx = "";
  }
}

function scheduleTranscriptAppend(direction, text) {
  if (!sessionInfo?.sessionId || !text || !["tx", "rx"].includes(direction)) {
    return;
  }

  transcriptBuffers[direction] += text;
  if (transcriptFlushTimer) {
    return;
  }

  transcriptFlushTimer = window.setTimeout(() => {
    flushTranscriptBuffers();
  }, TRANSCRIPT_FLUSH_DELAY_MS);
}

function setRemoteIp(remoteIp) {
  remoteIpNode.textContent = remoteIp || "pending";

  if (sessionInfo?.sessionId && remoteIp) {
    upsertSessionHistory({
      sessionId,
      remoteIp,
      lastSeenAt: Date.now(),
    });
  }
}

function playConnectionFlash() {
  if (!terminalStage) {
    return;
  }

  terminalStage.classList.remove("connection-strike");
  void terminalStage.offsetWidth;
  terminalStage.classList.add("connection-strike");
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    terminalStage.classList.remove("connection-strike");
  }, 840);
}

function requestTerminalFocus() {
  if (currentStatus !== "connected") {
    return;
  }

  window.requestAnimationFrame(() => {
    terminal.focus();
  });
}

function updateLayoutForStatus(status) {
  const overlayVisible = status === "waiting_for_browser" || status === "waiting_for_agent";
  const terminalActive = status === "connected";

  document.body.classList.toggle("session-live", terminalActive);
  bootstrapOverlay.classList.toggle("is-hidden", !overlayVisible);
  bootstrapOverlay.setAttribute("aria-hidden", String(!overlayVisible));

  if (terminalActive) {
    window.requestAnimationFrame(() => {
      fitTerminalAndNotify();
      requestTerminalFocus();
    });
  }
}

function setStatus(status) {
  const normalized = status || "waiting_for_agent";
  const previousStatus = currentStatus;
  currentStatus = normalized;
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
    connected: "",
    expired: "Session expired.",
    disconnected: "Browser disconnected. Session terminated.",
    ended: "Session ended.",
    agent_closed: "Remote shell exited.",
  };

  const statusText = copyMap[normalized] ?? label;
  statusCopy.textContent = statusText;
  statusCopy.hidden = statusText.length === 0;
  if (sessionInfo?.sessionId) {
    upsertSessionHistory({
      sessionId,
      lastStatus: normalized,
      lastSeenAt: Date.now(),
    });
  }
  updateLayoutForStatus(normalized);

  if (previousStatus !== "connected" && normalized === "connected") {
    playConnectionFlash();
  }
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

  if (message.type === "stdin" && typeof message.data === "string") {
    scheduleTranscriptAppend("tx", message.data);
  }

  const payload = JSON.stringify(message);
  websocket.send(payload);
  recordTraffic("tx", encoder.encode(payload).length);
}

function usesPrimaryModifier(event) {
  if (isApplePlatform) {
    return event.metaKey && !event.ctrlKey;
  }

  return event.ctrlKey && !event.metaKey;
}

function shouldCopySelection(event) {
  const key = event.key.toLowerCase();

  if (!terminal.hasSelection()) {
    return false;
  }

  if (key !== "c") {
    return false;
  }

  if (isApplePlatform) {
    return event.metaKey && !event.ctrlKey && !event.altKey;
  }

  return (
    (usesPrimaryModifier(event) && !event.shiftKey && !event.altKey)
    || (event.ctrlKey && event.shiftKey && !event.altKey)
  );
}

function fallbackCopyText(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }

  textarea.remove();
  return copied;
}

async function copyTerminalSelection() {
  const selection = terminal.getSelection();
  if (!selection) {
    return;
  }

  try {
    await navigator.clipboard.writeText(selection);
  } catch {
    fallbackCopyText(selection);
  }
}

function shouldPasteFromClipboard(event) {
  if (currentStatus !== "connected" || sessionInfo?.readonly) {
    return false;
  }

  if (event.key === "Insert") {
    return event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
  }

  const key = event.key.toLowerCase();
  if (key !== "v") {
    return false;
  }

  if (isApplePlatform) {
    return event.metaKey && !event.ctrlKey && !event.altKey;
  }

  return (
    (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey)
    || (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey)
  );
}

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) {
      return;
    }

    setError("");
    requestTerminalFocus();
    terminal.paste(text);
  } catch {
    setError("Unable to read from clipboard.");
  }
}

function downloadTranscript() {
  flushTranscriptBuffers();

  const transcript = loadSessionTranscript(sessionId);
  const transcriptText = buildSessionTranscriptText({
    ...sessionInfo,
    sessionId,
    lastStatus: currentStatus,
    remoteIp: remoteIpNode.textContent === "pending" ? "" : remoteIpNode.textContent,
    lastSeenAt: Date.now(),
  }, transcript);
  const blob = new Blob([transcriptText], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `raijin-${sessionId}-transcript.txt`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

function handleTerminalPaste(event) {
  if (currentStatus !== "connected" || sessionInfo?.readonly) {
    return;
  }

  const text = event.clipboardData?.getData("text/plain");
  if (!text) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  requestTerminalFocus();
  terminal.paste(text);
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
  if (typeof event.data === "string") {
    recordTraffic("rx", encoder.encode(event.data).length);
  }

  const message = JSON.parse(event.data);

  if (message.type === "status") {
    setRemoteIp(message.remoteIp);
    setStatus(message.status);
    if (message.status === "connected") {
      requestTerminalFocus();
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
    const bytes = decodeBase64ToBytes(message.data);
    terminal.write(bytes);
    scheduleTranscriptAppend("rx", outputDecoder.decode(bytes, { stream: true }));
    return;
  }

  if (message.type === "notice" && message.message) {
    scheduleTranscriptAppend("rx", `[raijin] ${message.message}\n`);
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

terminalContainer.addEventListener("paste", handleTerminalPaste, true);

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

downloadTranscriptButton.addEventListener("click", () => {
  downloadTranscript();
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

window.addEventListener("focus", () => {
  requestTerminalFocus();
});

window.addEventListener("beforeunload", () => {
  flushTranscriptBuffers();
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
    upsertSessionHistory({
      ...sessionInfo,
      hasLocalSession: true,
      lastSeenAt: Date.now(),
    });
    setRemoteIp("");
    bootstrapNode.value = buildBootstrapCommand(sessionInfo, window.location.origin);
    renderTraffic();
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
