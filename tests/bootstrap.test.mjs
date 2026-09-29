import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import worker from '../src/index.js';

test('generated Python bootstrap tolerates transient transport failures', async () => {
  const config = Buffer.from(JSON.stringify({baseUrl:'https://example.invalid',sessionId:'test',token:'test',mode:'interactive'})).toString('base64url');
  const response = await worker.fetch(new Request(`https://example.invalid/bootstrap?c=${config}`), {});
  assert.equal(response.status, 200);
  const result = spawnSync('python3', ['tests/bootstrap_test.py'], {input:await response.text(), encoding:'utf8', timeout:15000});
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
