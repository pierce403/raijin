import "./styles.css";
import {
  buildSessionTranscriptText,
  deleteLocalSessionRecord,
  encodeSessionFragment,
  listLaunchers,
  listSessionHistory,
  randomToken,
  saveLauncher,
  sha256Base64Url,
} from "./session-store.js";

const errorNode = document.querySelector("#home-error");
const createButton = document.querySelector("#create-button");
const historyPanel = document.querySelector("#session-history-panel");
const historyCountNode = document.querySelector("#session-history-count");
const historySearchNode = document.querySelector("#session-search");
const historyListNode = document.querySelector("#session-history-list");
const historyEmptyNode = document.querySelector("#session-history-empty");
const launcherHistoryPanel = document.querySelector("#launcher-history-panel");
const launcherHistoryList = document.querySelector("#launcher-history-list");

const DEFAULT_IDLE_TIMEOUT_SECONDS = 600;
const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

let sessionHistory = [];

function triggerTranscriptDownload(entry) {
  const transcriptText = buildSessionTranscriptText(entry, entry.transcript);
  const blob = new Blob([transcriptText], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `raijin-${entry.sessionId}-transcript.txt`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
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

function formatStatusLabel(status) {
  return (status || "waiting_for_browser").replaceAll("_", " ");
}

function badgeTypeForStatus(status) {
  if (status?.startsWith("waiting")) {
    return "waiting";
  }

  if (status === "connected") {
    return "connected";
  }

  if (status?.startsWith("agent")) {
    return "agent";
  }

  return status || "waiting";
}

function buildSessionSummary(entry) {
  if (entry.command) {
    return entry.command;
  }

  if (entry.readonly || entry.mode === "readonly") {
    return "Readonly relay";
  }

  if (entry.mode === "command") {
    return "Command relay";
  }

  return "Interactive shell";
}

function buildSearchText(entry) {
  return entry.searchText || "";
}

function formatTimestamp(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "Unknown";
  }

  return dateTimeFormatter.format(value);
}

function updateHistoryCount(total, visible) {
  historyCountNode.hidden = total === 0;
  historyCountNode.textContent = visible === total
    ? `${total} session${total === 1 ? "" : "s"}`
    : `${visible} of ${total} shown`;
}

function createHistoryCard(entry) {
  const card = document.createElement("article");
  card.className = "session-history-card";

  const header = document.createElement("div");
  header.className = "session-history-card-header";

  const titleBlock = document.createElement("div");
  titleBlock.className = "session-history-card-title";

  const sessionIdNode = document.createElement("code");
  sessionIdNode.textContent = entry.sessionId;

  const summaryNode = document.createElement("p");
  summaryNode.className = "session-history-summary";
  summaryNode.textContent = buildSessionSummary(entry);

  titleBlock.append(sessionIdNode, summaryNode);

  const statusNode = document.createElement("span");
  statusNode.className = `status-badge status-${badgeTypeForStatus(entry.lastStatus)}`;
  statusNode.textContent = formatStatusLabel(entry.lastStatus);

  header.append(titleBlock, statusNode);

  const meta = document.createElement("div");
  meta.className = "session-history-meta";

  const metaFields = [
    `Mode ${entry.readonly ? "readonly" : entry.mode}`,
    `Created ${formatTimestamp(entry.createdAt)}`,
    `Seen ${formatTimestamp(entry.lastSeenAt)}`,
    entry.remoteIp ? `IP ${entry.remoteIp}` : "",
  ].filter(Boolean);

  for (const field of metaFields) {
    const chip = document.createElement("span");
    chip.textContent = field;
    meta.append(chip);
  }

  const actions = document.createElement("div");
  actions.className = "session-history-actions";

  const availability = document.createElement("span");
  availability.className = "session-history-flag";
  availability.textContent = entry.hasLocalSession ? "Ready to reopen" : "Archived";

  actions.append(availability);

  if (entry.hasLocalSession) {
    const link = document.createElement("a");
    link.className = "secondary-button session-history-link";
    link.href = `/s/${encodeURIComponent(entry.sessionId)}`;
    link.textContent = "Open Session";
    actions.append(link);
  }

  const downloadButton = document.createElement("button");
  downloadButton.className = "secondary-button session-history-button";
  downloadButton.type = "button";
  downloadButton.textContent = "Download Transcript";
  downloadButton.addEventListener("click", () => {
    triggerTranscriptDownload(entry);
  });
  actions.append(downloadButton);

  const deleteButton = document.createElement("button");
  deleteButton.className = "danger-button session-history-button";
  deleteButton.type = "button";
  deleteButton.textContent = "Delete Local Copy";
  deleteButton.addEventListener("click", () => {
    const confirmed = window.confirm(`Delete local history for session ${entry.sessionId}?`);
    if (!confirmed) {
      return;
    }

    deleteLocalSessionRecord(entry.sessionId);
    renderSessionHistory();
  });
  actions.append(deleteButton);

  card.append(header, meta, actions);
  return card;
}

function renderSessionHistory() {
  sessionHistory = listSessionHistory();
  const hasHistory = sessionHistory.length > 0;

  historyPanel.hidden = !hasHistory;
  document.body.classList.toggle("has-session-history", hasHistory);

  if (!hasHistory) {
    historyListNode.replaceChildren();
    historyEmptyNode.hidden = true;
    historyCountNode.hidden = true;
    return;
  }

  const query = historySearchNode.value.trim().toLowerCase();
  const visibleEntries = query
    ? sessionHistory.filter((entry) => buildSearchText(entry).includes(query))
    : sessionHistory;

  updateHistoryCount(sessionHistory.length, visibleEntries.length);
  historyListNode.replaceChildren(...visibleEntries.map(createHistoryCard));
  historyEmptyNode.hidden = visibleEntries.length > 0;
}

function renderLauncherHistory() {
  const launchers = listLaunchers();
  launcherHistoryPanel.hidden = launchers.length === 0;
  document.body.classList.toggle("has-launcher-history", launchers.length > 0);
  launcherHistoryList.replaceChildren(...launchers.map((launcher) => {
    const card = document.createElement("article");
    card.className = "session-history-card";
    const header = document.createElement("div");
    header.className = "session-history-card-header";
    const title = document.createElement("code");
    title.className = "launcher-history-id";
    title.textContent = launcher.sessionId;
    const link = document.createElement("a");
    link.className = "secondary-button session-history-link";
    link.href = `/l/${encodeURIComponent(launcher.sessionId)}`;
    link.textContent = "Open Listener";
    header.append(title, link);
    const summary = document.createElement("p");
    summary.className = "session-history-summary";
    summary.textContent = `${buildSessionSummary(launcher)} · Created ${formatTimestamp(launcher.createdAt)}`;
    card.append(header, summary);
    return card;
  }));
}

createButton.addEventListener("click", async () => {
  setError("");

  try {
    createButton.disabled = true;

    const now = Date.now();
    const browserToken = randomToken(32);
    const session = {
      sessionId: await sha256Base64Url(browserToken),
      browserToken,
      agentToken: randomToken(32),
      mode: "interactive",
      command: "",
      readonly: false,
      createdAt: now,
      idleTimeoutSeconds: DEFAULT_IDLE_TIMEOUT_SECONDS,
      maxLifetimeSeconds: null,
      reusable: true,
    };

    saveLauncher(session);
    const fragment = encodeURIComponent(encodeSessionFragment(session));
    window.location.assign(`/l/${encodeURIComponent(session.sessionId)}#s=${fragment}`);
  } catch (error) {
    setError(error instanceof Error ? error.message : "Unable to create session.");
    createButton.disabled = false;
  }
});

historySearchNode.addEventListener("input", () => {
  renderSessionHistory();
});

renderSessionHistory();
renderLauncherHistory();

window.addEventListener("pageshow", () => {
  renderSessionHistory();
  renderLauncherHistory();
});
