const STORAGE_PREFIX = "raijin:session:";
const encoder = new TextEncoder();

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
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

export function saveSession(session) {
  localStorage.setItem(sessionStorageKey(session.sessionId), JSON.stringify(session));
}

export function loadSession(sessionId) {
  const raw = localStorage.getItem(sessionStorageKey(sessionId));
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function deleteSession(sessionId) {
  localStorage.removeItem(sessionStorageKey(sessionId));
}

export function buildBootstrapCommand(session, origin) {
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
  return `python3 -c "import urllib.request; exec(urllib.request.urlopen('${bootstrapUrl}').read().decode())"`;
}
