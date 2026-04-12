const STORAGE_PREFIX = "raijin:session:";
const HISTORY_KEY = "raijin:session-history";
const TRANSCRIPT_PREFIX = "raijin:session-log:";
const MAX_HISTORY_ENTRIES = 200;
const MAX_TRANSCRIPT_CHARS = 8_192;
const ANSI_ESCAPE_PATTERN = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/gu;
const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F]/gu;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function parseStoredJson(raw) {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function safeSetItem(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function normalizeTimestamp(value, fallback = Date.now()) {
  const candidate = Number(value);
  return Number.isFinite(candidate) && candidate > 0 ? candidate : fallback;
}

function normalizeTimeout(value, fallback = null) {
  if (value === null) {
    return null;
  }

  const candidate = Number(value);
  return Number.isFinite(candidate) && candidate > 0 ? candidate : fallback;
}

function normalizeMode(value, fallback = "interactive") {
  return ["interactive", "command", "readonly"].includes(value) ? value : fallback;
}

function normalizeStatus(value, fallback = "waiting_for_browser") {
  return typeof value === "string" && value ? value : fallback;
}

function sanitizeCommand(value) {
  return typeof value === "string" ? value.slice(0, 240) : "";
}

function sanitizeTranscriptChunk(value) {
  return typeof value === "string" ? value.slice(-MAX_TRANSCRIPT_CHARS) : "";
}

function trimTranscript(value) {
  const text = sanitizeTranscriptChunk(value);
  return text.length > MAX_TRANSCRIPT_CHARS ? text.slice(-MAX_TRANSCRIPT_CHARS) : text;
}

function normalizeTranscriptRecord(record) {
  if (!record || typeof record !== "object") {
    return { tx: "", rx: "" };
  }

  return {
    tx: trimTranscript(record.tx),
    rx: trimTranscript(record.rx),
  };
}

function normalizeSearchText(value) {
  if (typeof value !== "string" || !value) {
    return "";
  }

  return value
    .replaceAll(ANSI_ESCAPE_PATTERN, " ")
    .replaceAll(CONTROL_CHAR_PATTERN, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function normalizeHistoryEntry(record, existing = {}) {
  if (!record || typeof record !== "object") {
    return null;
  }

  const sessionId = typeof record.sessionId === "string"
    ? record.sessionId
    : existing.sessionId;

  if (!sessionId) {
    return null;
  }

  const createdAt = normalizeTimestamp(record.createdAt, existing.createdAt ?? Date.now());
  const maxLifetimeSeconds = record.maxLifetimeSeconds === null
    ? null
    : normalizeTimeout(record.maxLifetimeSeconds, existing.maxLifetimeSeconds ?? null);

  return {
    sessionId,
    createdAt,
    lastSeenAt: normalizeTimestamp(record.lastSeenAt, existing.lastSeenAt ?? createdAt),
    mode: normalizeMode(record.mode, existing.mode ?? "interactive"),
    command: sanitizeCommand(record.command ?? existing.command ?? ""),
    readonly: typeof record.readonly === "boolean" ? record.readonly : Boolean(existing.readonly),
    idleTimeoutSeconds: normalizeTimeout(
      record.idleTimeoutSeconds,
      existing.idleTimeoutSeconds ?? null,
    ),
    maxLifetimeSeconds,
    lastStatus: normalizeStatus(record.lastStatus ?? record.status, existing.lastStatus),
    remoteIp: typeof record.remoteIp === "string" ? record.remoteIp : (existing.remoteIp ?? ""),
    hasLocalSession: typeof record.hasLocalSession === "boolean"
      ? record.hasLocalSession
      : Boolean(existing.hasLocalSession),
  };
}

function readHistoryEntries() {
  const parsed = parseStoredJson(localStorage.getItem(HISTORY_KEY));
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .map((entry) => normalizeHistoryEntry(entry))
    .filter(Boolean);
}

function writeHistoryEntries(entries) {
  safeSetItem(HISTORY_KEY, JSON.stringify(entries.slice(0, MAX_HISTORY_ENTRIES)));
}

function listStoredSessions() {
  const sessions = [];

  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(STORAGE_PREFIX)) {
      continue;
    }

    const session = parseStoredJson(localStorage.getItem(key));
    if (!session || typeof session !== "object" || typeof session.sessionId !== "string") {
      continue;
    }

    sessions.push(session);
  }

  return sessions;
}

export function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function decodeBase64Url(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const binary = atob(`${normalized}${padding}`);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

export function randomToken(byteLength = 24) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return encodeBase64Url(bytes);
}

export async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return encodeBase64Url(new Uint8Array(digest));
}

export function sessionStorageKey(sessionId) {
  return `${STORAGE_PREFIX}${sessionId}`;
}

export function transcriptStorageKey(sessionId) {
  return `${TRANSCRIPT_PREFIX}${sessionId}`;
}

export function saveSession(session) {
  safeSetItem(sessionStorageKey(session.sessionId), JSON.stringify(session));
  upsertSessionHistory({
    ...session,
    hasLocalSession: true,
    lastSeenAt: Date.now(),
  });
}

export function loadSession(sessionId) {
  return parseStoredJson(localStorage.getItem(sessionStorageKey(sessionId)));
}

export function loadSessionTranscript(sessionId) {
  if (!sessionId) {
    return { tx: "", rx: "" };
  }

  return normalizeTranscriptRecord(parseStoredJson(localStorage.getItem(transcriptStorageKey(sessionId))));
}

export function writeSessionTranscript(sessionId, transcript) {
  if (!sessionId) {
    return { tx: "", rx: "" };
  }

  const normalized = normalizeTranscriptRecord(transcript);
  if (!normalized.tx && !normalized.rx) {
    localStorage.removeItem(transcriptStorageKey(sessionId));
    return normalized;
  }

  safeSetItem(transcriptStorageKey(sessionId), JSON.stringify(normalized));
  return normalized;
}

export function appendSessionTranscript(sessionId, direction, chunk) {
  if (!sessionId || !["tx", "rx"].includes(direction)) {
    return { tx: "", rx: "" };
  }

  const text = sanitizeTranscriptChunk(chunk);
  if (!text) {
    return loadSessionTranscript(sessionId);
  }

  const transcript = loadSessionTranscript(sessionId);
  transcript[direction] = trimTranscript(transcript[direction] + text);
  return writeSessionTranscript(sessionId, transcript);
}

export function deleteSession(sessionId) {
  const existing = loadSession(sessionId);
  upsertSessionHistory({
    ...(existing || {}),
    sessionId,
    hasLocalSession: false,
    lastSeenAt: Date.now(),
  });
  localStorage.removeItem(sessionStorageKey(sessionId));
}

export function deleteLocalSessionRecord(sessionId) {
  if (!sessionId) {
    return;
  }

  const entries = readHistoryEntries()
    .filter((entry) => entry.sessionId !== sessionId);
  writeHistoryEntries(entries);
  localStorage.removeItem(sessionStorageKey(sessionId));
  localStorage.removeItem(transcriptStorageKey(sessionId));
}

export function upsertSessionHistory(record) {
  const entries = readHistoryEntries();
  const index = entries.findIndex((entry) => entry.sessionId === record?.sessionId);
  const existing = index >= 0 ? entries[index] : {};
  const normalized = normalizeHistoryEntry(record, existing);

  if (!normalized) {
    return null;
  }

  if (index >= 0) {
    entries[index] = normalized;
  } else {
    entries.push(normalized);
  }

  entries.sort((left, right) => right.lastSeenAt - left.lastSeenAt);
  writeHistoryEntries(entries);
  return normalized;
}

export function listSessionHistory() {
  const merged = new Map();

  for (const entry of readHistoryEntries()) {
    merged.set(entry.sessionId, entry);
  }

  for (const session of listStoredSessions()) {
    const existing = merged.get(session.sessionId);
    const normalized = normalizeHistoryEntry({
      ...session,
      hasLocalSession: true,
      lastSeenAt: existing?.lastSeenAt ?? session.createdAt ?? Date.now(),
      lastStatus: existing?.lastStatus ?? "waiting_for_browser",
      remoteIp: existing?.remoteIp ?? "",
    }, existing ?? {});

    if (normalized) {
      merged.set(normalized.sessionId, normalized);
    }
  }

  return Array.from(merged.values())
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
    .map((entry) => {
      const transcript = loadSessionTranscript(entry.sessionId);
      const searchText = [
        entry.sessionId,
        entry.mode,
        entry.readonly ? "readonly" : "",
        entry.lastStatus,
        entry.remoteIp,
        entry.command,
        normalizeSearchText(transcript.tx),
        normalizeSearchText(transcript.rx),
      ]
        .filter(Boolean)
        .join(" ");

      return {
        ...entry,
        searchText,
        transcript,
      };
    });
}

export function buildBootstrapCommand(session, origin) {
  const userAgent = `raijin-agent/0.1 (+${origin})`;
  const config = {
    baseUrl: origin,
    sessionId: session.sessionId,
    token: session.agentToken,
    mode: session.mode,
    command: session.command,
    readonly: session.readonly,
    idleTimeoutSeconds: session.idleTimeoutSeconds,
    maxLifetimeSeconds: session.maxLifetimeSeconds,
  };

  const encodedConfig = encodeBase64Url(encoder.encode(JSON.stringify(config)));
  const bootstrapUrl = `${origin}/bootstrap?c=${encodedConfig}`;
  return `python3 -c "import urllib.request; req = urllib.request.Request('${bootstrapUrl}', headers={'User-Agent': '${userAgent}'}); exec(urllib.request.urlopen(req).read().decode())"`;
}

export function encodeSessionFragment(session) {
  return encodeBase64Url(encoder.encode(JSON.stringify(session)));
}

export function decodeSessionFragment(encoded) {
  try {
    return JSON.parse(decoder.decode(decodeBase64Url(encoded)));
  } catch {
    return null;
  }
}
