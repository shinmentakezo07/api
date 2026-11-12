// test/gateway.test.js — end-to-end: real gateway process + mock upstream.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Semver compare, so the mock can refuse a stale x-client-version like upstream. */
const cmp = (a, b) => {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  return 0;
};

/** Mock upstream; behaviour selected by the bearer token. */
function startUpstream({ latest = '0.6.19' } = {}) {
  const hits = {};
  const sessions = [];   // { token, sessionId } in arrival order
  const versions = [];   // { token, version } — x-client-version per attempt
  const server = http.createServer((req, res) => {
    // the gateway resolves x-client-version from here at startup and on a timer
    if (req.url === '/client-version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ min: '0.6.19', latest, models: [] }));
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      hits[token] = (hits[token] ?? 0) + 1;
      sessions.push({ token, sessionId: req.headers['x-session-id'] });
      versions.push({ token, version: req.headers['x-client-version'] });
      // 'tok-bad' always fails with a retryable account issue
      if (token === 'tok-bad') {
        res.writeHead(409, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ code: 'concurrent_session', message: 'session busy' }));
      }
      // 'tok-hang' never answers, so the gateway's timeout path is exercised
      if (token === 'tok-hang') return;
      // 'tok-old' refuses a stale x-client-version exactly like the real 426
      if (token === 'tok-old' && cmp(req.headers['x-client-version'], '9.9.9') < 0) {
        const message = 'your free-pi-cli is below the required minimum (9.9.9); update with: npx free-pi-cli@latest';
        res.writeHead(426, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ code: 'upgrade_required', message, error: { message, code: 'upgrade_required', type: 'free_pi_error' } }));
      }
      // 'tok-concurrent' mimics free-pi's one-request-at-a-time-per-session 429
      if (token === 'tok-concurrent' && hits[token] === 1) {
        res.writeHead(429, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ code: 'concurrent', message: 'one request at a time' }));
      }
      const j = JSON.parse(body || '{}');
      const send = () => {
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
      };
      // 'tok-slow' keeps the request in flight so concurrency is observable
      setTimeout(send, token === 'tok-slow' ? 250 : 0);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, hits, sessions, versions, port: server.address().port }));
  });
}

function startGateway({ port, upstreamPort, dataDir, tokens, config = {} }) {
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    FREEPI_BASE_URL: 'http://127.0.0.1:' + upstreamPort,
    DATA_DIR: dataDir,
    FREEPI_ADMIN_KEY: 'test-key',
  };
  tokens.forEach((t, i) => { env['FREEPI_TOKEN_' + (i + 1)] = t; });
  // Point the gateway at a scratch config: the repo's shi.json names the real
  // accounts.json, which would otherwise leak real accounts into the tests.
  writeFileSync(join(dataDir, 'shi.json'), JSON.stringify(config));
  const child = spawn(process.execPath, ['index.js', '--config', join(dataDir, 'shi.json')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
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

const getJson = (port, path) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
    let out = '';
    res.on('data', (c) => (out += c));
    res.on('end', () => resolve(JSON.parse(out)));
  });
  req.on('error', reject);
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

/** True when nothing is listening on the port (a stale gateway from an older
 *  run would answer /health and make the new one fail with EADDRINUSE). */
const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.once('listening', () => s.close(() => resolve(true)));
  s.listen(port, '127.0.0.1');
});

const boot = async (tokens, config = {}, upstreamOpts = {}) => {
  upstream = await startUpstream(upstreamOpts);
  PORT += 1;
  while (!(await portFree(PORT))) PORT += 1;
  // one data dir per boot: a late usage flush from a previous test must not
  // land in the next test's usage.json
  const dataDir = join(DATA, 'run-' + PORT);
  mkdirSync(join(dataDir, 'logs'), { recursive: true });
  gw = startGateway({ port: PORT, upstreamPort: upstream.port, dataDir, tokens, config });
  const ready = await waitForPort(PORT);
  assert.ok(ready, 'gateway did not start:\n' + gw.output);
  return { port: PORT, hits: upstream.hits, versions: upstream.versions, dataDir };
};

const shutdown = async () => {
  gw?.child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  upstream?.server.closeAllConnections?.(); // hung sockets from 'tok-hang'
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

test('concurrent clients get distinct upstream session ids', async () => {
  const { port } = await boot(['tok-slow']);
  try {
    const body = { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false };
    const [a, b] = await Promise.all([
      post(port, '/v1/chat/completions', body),
      post(port, '/v1/chat/completions', body),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const ids = upstream.sessions.map((s) => s.sessionId);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1], 'two clients must not share one upstream session');
  } finally { await shutdown(); }
});

test("a 429 'concurrent' rotates the session id and retries instead of failing over", async () => {
  const { port, hits } = await boot(['tok-concurrent']);
  try {
    const r = await post(port, '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).choices[0].message.content, 'hello');
    const ids = upstream.sessions.map((s) => s.sessionId);
    assert.equal(ids.length, 2, 'exactly one retry after the 429');
    assert.notEqual(ids[0], ids[1], 'the retry must use a fresh session id');
    assert.equal(hits['tok-concurrent'], 2);
  } finally { await shutdown(); }
});

test('a 426 upgrade_required bumps x-client-version and retries transparently', async () => {
  const { port, versions } = await boot(['tok-old']);
  try {
    const r = await post(port, '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false });
    assert.equal(r.status, 200, 'the client never sees the 426');
    assert.equal(JSON.parse(r.body).choices[0].message.content, 'hello');
    const seen = versions.filter((v) => v.token === 'tok-old').map((v) => v.version);
    assert.equal(seen.length, 2, 'exactly one retry after the 426');
    assert.ok(cmp(seen[0], '9.9.9') < 0, 'the first attempt used a stale version');
    assert.equal(seen[1], '9.9.9', 'the retry reported the minimum upstream named');
    const health = await getJson(port, '/health');
    assert.equal(health.clientVersion.version, '9.9.9');
  } finally { await shutdown(); }
});

test('a restart re-reads /client-version and uses the new latest', async () => {
  const body = { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false };

  const first = await boot(['tok-a'], {}, { latest: '0.6.20' });
  try {
    const r = await post(first.port, '/v1/chat/completions', body);
    assert.equal(r.status, 200, r.body);
    const seen = first.versions.filter((v) => v.token === 'tok-a').map((v) => v.version);
    assert.equal(seen.at(-1), '0.6.20', 'the first start used the latest it fetched');
  } finally { await shutdown(); }

  // upstream publishes a newer release while the gateway is down
  const second = await boot(['tok-a'], {}, { latest: '0.6.21' });
  try {
    const r = await post(second.port, '/v1/chat/completions', body);
    assert.equal(r.status, 200, r.body);
    const seen = second.versions.filter((v) => v.token === 'tok-a').map((v) => v.version);
    assert.equal(seen.at(-1), '0.6.21', 'a restart fetches again instead of reusing a cached value');
  } finally { await shutdown(); }
});

test('an upstream timeout is a 504 with a readable message, not a vague 502', async () => {
  const { port } = await boot(['tok-hang'], { requestTimeoutMs: 300 });
  try {
    const r = await post(port, '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false });
    assert.equal(r.status, 504, r.body);
    assert.match(r.body, /timed out/i);
  } finally { await shutdown(); }
});

test('failover serves from the next account and counts the request once', async () => {
  const { port, hits, dataDir } = await boot(['tok-bad', 'tok-good']);
  try {
    const r = await post(port, '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false });
    assert.equal(r.status, 200, r.body);
    assert.equal(JSON.parse(r.body).choices[0].message.content, 'hello');
    assert.ok(Object.keys(hits).length >= 1, 'upstream was reached');
    // usage.json is flushed on a 5s timer, so wait for it instead of assuming
    const usageFile = join(dataDir, 'logs', 'usage.json');
    const deadline = Date.now() + 8000;
    while (!existsSync(usageFile) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 100));
    assert.ok(existsSync(usageFile), 'usage persisted');
    const usage = JSON.parse(readFileSync(usageFile, 'utf8'));
    const rows = usage.recent.slice(-1);
    assert.equal(rows.length, 1, 'exactly one usage row per client request');
    assert.equal(rows[0].status, 200);
  } finally { await shutdown(); }
});
