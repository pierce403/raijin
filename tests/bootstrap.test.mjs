import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import worker from '../src/index.js';

const baseConfig = {baseUrl:'https://example.invalid',sessionId:'test',token:'test',mode:'interactive'};
async function bootstrap(overrides = {}) {
  const config = Buffer.from(JSON.stringify({...baseConfig, ...overrides})).toString('base64url');
  const response = await worker.fetch(new Request(`https://example.invalid/bootstrap?c=${config}`), {});
  assert.equal(response.status, 200);
  return response.text();
}

test('generated Python bootstrap transport and sequence regressions', {timeout: 15000}, async t => {
  const script = await bootstrap();
  const child = spawn('python3', ['tests/bootstrap_test.py'], {stdio: ['pipe', 'pipe', 'pipe']});
  t.after(() => child.kill());
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code));
  });
  child.stdin.on('error', () => {});
  child.stdin.end(script);
  assert.equal(await result, 0, output);
  const count = output.match(/Ran (\d+) tests/u)?.[1];
  assert.ok(count, 'Python must report the number of completed cases');
  t.diagnostic(`${count} Python regression cases passed`);
});

test('bootstrap preserves unlimited max lifetime as null', async () => {
  for (const [input, expected] of [[null, null], [undefined, null], [0, null], [-1, null], [600, 600]]) {
    const source = await bootstrap({maxLifetimeSeconds: input});
    const config = JSON.parse(JSON.parse(source.match(/^CONFIG = json.loads\((.*)\)$/mu)[1]));
    assert.equal(config.maxLifetimeSeconds, expected);
  }
});

test('oversized agent bodies are rejected before forwarding to a Durable Object', async () => {
  for (const [action, limit] of [['out', 16384], ['heartbeat', 4096], ['close', 4096]]) {
    const request = new Request(`https://example.invalid/agent/test/${action}`, {method:'POST', body:'x'.repeat(limit + 1)});
    const response = await worker.fetch(request, {});
    assert.equal(response.status, 413);
  }
});
