import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

test("only terminal pages allow same-origin framing", async () => {
  const env = { ASSETS: { fetch: async () => new Response("<!doctype html>") } };
  for (const [path, ancestor] of [
    ["/s/test?embedded=1", "self"],
    ["/s/test", "self"],
    ["/l/test", "none"],
    ["/", "none"],
  ]) {
    const response = await worker.fetch(new Request(`https://example.invalid${path}`), env);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-security-policy").includes(`frame-ancestors '${ancestor}'`), path);
  }
});
