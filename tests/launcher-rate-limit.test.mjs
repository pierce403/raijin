import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { LauncherDurableObject } from "../src/launcher-do.js";

test("registration rate limit reports when the oldest slot expires and permits idempotent retries", async () => {
  const launcher = new LauncherDurableObject();
  const token = randomBytes(32).toString("base64url");
  launcher.agentTokenHash = createHash("sha256").update(token).digest("base64url");
  launcher.socket = { readyState: 1, send() {} };
  const createdAt = Date.now();
  for (let index = 0; index < 100; index += 1) {
    const runId = randomBytes(24).toString("base64url");
    launcher.runs.set(runId, { runId, agentToken: token, createdAt });
  }
  const register = runId => launcher.fetch(new Request("https://launcher/runs", {
    method: "POST", headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ runId, agentToken: token }),
  }));
  const newRunId = randomBytes(24).toString("base64url");
  const limited = await register(newRunId);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) >= 599);
  assert.ok(Number(limited.headers.get("retry-after")) <= 600);
  assert.equal(launcher.runs.size, 100);
  const first = launcher.runs.values().next().value;
  assert.equal((await register(first.runId)).status, 200);
  first.createdAt = Date.now() - 600_001;
  assert.equal((await register(newRunId)).status, 200);
  assert.equal(launcher.runs.size, 100);
});
