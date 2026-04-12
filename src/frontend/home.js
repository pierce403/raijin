import "./styles.css";
import {
  encodeSessionFragment,
  listSessionHistory,
  randomToken,
  saveSession,
} from "./session-store.js";

const errorNode = document.querySelector("#home-error");
const createButton = document.querySelector("#create-button");
const historyPanel = document.querySelector("#session-history-panel");
const historyCountNode = document.querySelector("#session-history-count");
const historySearchNode = document.querySelector("#session-search");
const historyListNode = document.querySelector("#session-history-list");
const historyEmptyNode = document.querySelector("#session-history-empty");

const DEFAULT_IDLE_TIMEOUT_SECONDS = 600;
const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

let sessionHistory = [];

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
  return [
    entry.sessionId,
    entry.mode,
    entry.readonly ? "readonly" : "",
    entry.lastStatus,
    entry.remoteIp,
    entry.command,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
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

createButton.addEventListener("click", async () => {
  setError("");

  try {
    createButton.disabled = true;

    const now = Date.now();
    const session = {
      sessionId: randomToken(12),
      browserToken: randomToken(32),
      agentToken: randomToken(32),
      mode: "interactive",
      command: "",
      readonly: false,
      createdAt: now,
      idleTimeoutSeconds: DEFAULT_IDLE_TIMEOUT_SECONDS,
      maxLifetimeSeconds: null,
    };

    saveSession(session);
    const fragment = encodeURIComponent(encodeSessionFragment(session));
    window.location.assign(`/s/${encodeURIComponent(session.sessionId)}#s=${fragment}`);
  } catch (error) {
    setError(error instanceof Error ? error.message : "Unable to create session.");
    createButton.disabled = false;
  }
});

historySearchNode.addEventListener("input", () => {
  renderSessionHistory();
});

renderSessionHistory();
