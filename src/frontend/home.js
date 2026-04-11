import "./styles.css";
import { encodeSessionFragment, randomToken, saveSession } from "./session-store.js";

const errorNode = document.querySelector("#home-error");
const createButton = document.querySelector("#create-button");

const DEFAULT_IDLE_TIMEOUT_SECONDS = 600;
const DEFAULT_MAX_LIFETIME_SECONDS = 3600;

function setError(message) {
  if (!message) {
    errorNode.hidden = true;
    errorNode.textContent = "";
    return;
  }
  errorNode.hidden = false;
  errorNode.textContent = message;
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
      maxLifetimeSeconds: DEFAULT_MAX_LIFETIME_SECONDS,
    };

    saveSession(session);
    const fragment = encodeURIComponent(encodeSessionFragment(session));
    window.location.assign(`/s/${encodeURIComponent(session.sessionId)}#s=${fragment}`);
  } catch (error) {
    setError(error instanceof Error ? error.message : "Unable to create session.");
    createButton.disabled = false;
  }
});
