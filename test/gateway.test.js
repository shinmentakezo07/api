// test/gateway.test.js — end-to-end: real gateway process + mock upstream.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Mock upstream; behaviour selected by the bearer token. */
function startUpstream() {
  const hits = {};
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      hits[token] = (hits[token] ?? 0) + 1;
      // 'tok-bad' always fails with a retryable account issue
      if (token === 'tok-bad') {
        res.writeHead(409, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ code: 'concurrent_session', message: 'session busy' }));
      }
      const j = JSON.parse(body || '{}');
      if (!j.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          id: 'x', object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const piece of ['Hel', 'lo STO', 'P more']) {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + '\n\n');
      }
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, hits, port: server.address().port }));
  });
}

function startGateway({ port, upstreamPort, dataDir, tokens }) {
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    FREEPI_BASE_URL: 'http://127.0.0.1:' + upstreamPort,
    DATA_DIR: dataDir,
    FREEPI_ADMIN_KEY: 'test-key',
  };
  tokens.forEach((t, i) => { env['FREEPI_TOKEN_' + (i + 1)] = t; });
  const child = spawn(process.execPath, ['index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  return { child, get output() { return output; } };
}

const waitForPort = async (port, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 500 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

const post = (port, path, body) => new Promise((resolve, reject) => {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  const req = http.request(
    { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
    (res) => { let out = ''; res.on('data', (c) => (out += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out })); },
  );
  req.on('error', reject);
  req.end(data);
});

/** One gateway for the whole file, restarted per test group via before/after. */
const DATA = '/tmp/gw-test-' + process.pid;
let gw, upstream, PORT = 8820 + Math.floor(Math.random() * 200);

test.before(async () => {
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(join(DATA, 'logs'), { recursive: true });
});

test.after(() => {
  gw?.child.kill('SIGTERM');
  upstream?.server.close();
  rmSync(DATA, { recursive: true, force: true });
});

const boot = async (tokens) => {
  upstream = await startUpstream();
  PORT += 1;
  gw = startGateway({ port: PORT, upstreamPort: upstream.port, dataDir: DATA, tokens });
  const ready = await waitForPort(PORT);
  assert.ok(ready, 'gateway did not start:\n' + gw.output);
  return { port: PORT, hits: upstream.hits };
};

const shutdown = async () => {
  gw?.child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  upstream?.server.close();
};

test('non-streaming responses carry an exact content-length', async () => {
  const { port } = await boot(['tok-a']);
  try {
    const r = await post(port, '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false });
    assert.equal(r.status, 200);
    assert.equal(Number(r.headers['content-length']), Buffer.byteLength(r.body));
    assert.equal(r.headers['transfer-encoding'], undefined, 'must not be chunked');
    assert.ok(JSON.parse(r.body).choices.length === 1);
  } finally { await shutdown(); }
});

test('invalid JSON is a 400, not a 502', async () => {
  const { port } = await boot(['tok-a']);
  try {
    const r = await post(port, '/v1/messages/count_tokens', '{not json');
    assert.equal(r.status, 400);
  } finally { await shutdown(); }
});

test('stop_sequences are enforced end-to-end without leaking upstream text', async () => {
  const { port } = await boot(['tok-a']);
  try {
    const r = await post(port, '/v1/messages', {
      model: 'm', max_tokens: 100, stream: true, stop_sequences: ['STOP'],
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(r.status, 200);
    const text = [...r.body.matchAll(/"type":"text_delta","text":"([^"]*)"/g)].map((m) => m[1]).join('');
    assert.equal(text, 'Hello ');
    const md = JSON.parse(r.body.split('event: message_delta')[1].split('data: ')[1].split('\n')[0]);
    assert.equal(md.delta.stop_reason, 'stop_sequence');
    assert.equal(md.delta.stop_sequence, 'STOP');
  } finally { await shutdown(); }
});

test('failover serves from the next account and counts the request once', async () => {
  const { port, hits } = await boot(['tok-bad', 'tok-good']);
  try {
    const r = await post(port, '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).choices[0].message.content, 'hello');
    assert.ok(Object.keys(hits).length >= 1, 'upstream was reached');
    await new Promise((res) => setTimeout(res, 300));
    const usageFile = join(DATA, 'logs', 'usage.json');
    assert.ok(existsSync(usageFile), 'usage persisted');
    const usage = JSON.parse(readFileSync(usageFile, 'utf8'));
    const rows = usage.recent.slice(-1);
    assert.equal(rows.length, 1, 'exactly one usage row per client request');
    assert.equal(rows[0].status, 200);
  } finally { await shutdown(); }
});
