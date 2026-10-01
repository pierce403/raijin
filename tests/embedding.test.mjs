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

test("terminal pages permit xterm styles without permitting inline scripts", async () => {
  const env = { ASSETS: { fetch: async () => new Response("<!doctype html>") } };
  for (const path of ["/s/test", "/s/test?embedded=1", "/l/test", "/", "/og-preview"]) {
    const response = await worker.fetch(new Request(`https://example.invalid${path}`), env);
    const directives = new Map(response.headers.get("content-security-policy")
      .split("; ").map(directive => {
        const [name, ...sources] = directive.split(" ");
        return [name, sources.join(" ")];
      }));
    assert.equal(directives.get("style-src"),
      path.startsWith("/s/") ? "'self' 'unsafe-inline'" : "'self'", path);
    assert.equal(directives.get("script-src"), "'self'", path);
    assert.equal(directives.get("object-src"), "'none'", path);
  }
});
