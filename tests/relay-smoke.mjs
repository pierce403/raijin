// Run against wrangler dev, or an explicitly selected deployment.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
const base = process.env.RAIJIN_TEST_URL || 'http://127.0.0.1:8787';
for (const detached of [false, true]) {
  const id = randomUUID();
  const token = randomUUID();
  const browserToken = randomUUID();
  const messages = [];
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/connect/browser/${id}`);
  ws.on('message', data => messages.push(JSON.parse(data)));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({type:'hello', browserToken, agentTokenHash:createHash('sha256').update(token).digest('base64url'), createdAt:Date.now(), idleTimeoutSeconds:600}));
  async function until(check) {
    const deadline = Date.now()+5000;
    while (!check()) { assert.ok(Date.now()<deadline, 'Timed out waiting for socket'); await new Promise(r=>setTimeout(r,10)); }
  }
  await until(()=>messages.some(m=>m.type==='status'));
  if (detached) { ws.close(); await new Promise(r=>ws.once('close',r)); }
  const request = (action, method='POST', body={}) => fetch(`${base}/agent/${id}/${action}`, {method, headers:{authorization:`Bearer ${token}`, 'content-type':'application/json'}, ...(method==='GET'?{}:{body:JSON.stringify(body)}), signal:AbortSignal.timeout(30000)});
  const poll = request('in','GET');
  for (let i=0;i<3;i++) {
    assert.equal((await request('out','POST',{data:'IyA='})).status,200);
    assert.equal((await request('heartbeat')).status,200);
  }
  if (!detached) await until(()=>messages.filter(m=>m.type==='output').length===3);
  assert.equal((await request('close')).status,200);
  const response = await poll;
  assert.equal(response.status,200);
  assert.equal((await response.json()).status,'agent_closed');
  assert.equal((await request('out','POST',{data:'IyA='})).status,410);
  console.log(`${detached?'Detached':'Attached'} browser: output, heartbeat, concurrent poll, close passed`);
  ws.close();
}

// Execute the actual generated bootstrap with a harmless fixed command.
const { spawn } = await import('node:child_process');
const id = randomUUID();
const token = randomUUID();
const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/connect/browser/${id}`);
let output = '';
const closed = new Promise(resolve => ws.once('close', resolve));
ws.on('message', data => {
  const message = JSON.parse(data);
  if (message.type === 'output') output += Buffer.from(message.data, 'base64').toString();
});
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
const initialized = new Promise(resolve => ws.once('message', resolve));
ws.send(JSON.stringify({type:'hello', browserToken:randomUUID(), agentTokenHash:createHash('sha256').update(token).digest('base64url'), createdAt:Date.now(), idleTimeoutSeconds:600}));
await initialized;
const config = Buffer.from(JSON.stringify({baseUrl:base, sessionId:id, token, mode:'command', command:"printf 'raijin-bootstrap-ok\\n'"})).toString('base64url');
const script = await fetch(`${base}/bootstrap?c=${config}`).then(r=>r.text());
const child = spawn('python3', ['-'], {stdio:['pipe','ignore','pipe']});
let stderr = '';
child.stderr.on('data', data => { stderr += data; });
const timer = setTimeout(()=>child.kill('SIGKILL'), 30000);
child.stdin.end(script);
const code = await new Promise(resolve=>child.once('exit',resolve));
clearTimeout(timer);
assert.equal(code,0,stderr);
await closed;
assert.match(output,/raijin-bootstrap-ok/);
console.log('Generated Python bootstrap: real PTY command and output passed');
