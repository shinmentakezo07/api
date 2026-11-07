// server.js — HTTP router: auth gate, CORS, request logging, error mapping.
// Per-request account selection (round-robin) with failover across accounts.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { config, configFileUsed, SESSION_ID } from './config.js';
import { log } from './logger.js';
import { upstream, UpstreamError, resetOtherSessions, fingerprintHeaders } from './upstream.js';
import { pickOrder, primaryAccount, beginRequest, inFlightCount, inFlightAll } from './accounts.js';
import { record } from './usage.js';
import { getCatalog, resolveModel, defaultModel } from './catalog.js';
import { anthropicToOpenAI } from './translate/request.js';
import { openAIToAnthropic, errorBody, MalformedToolCallError } from './translate/response.js';
import { streamTranslate } from './translate/stream.js';
import { handleAdmin } from './admin.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-api-key, x-admin-key, anthropic-version, anthropic-beta',
};

function json(res, status, body, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...CORS, ...extra });
  res.end(JSON.stringify(body));
}

function clientAuthorized(req) {
  if (!config.clientKeys?.length) return true;
  const key = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || '';
  return config.clientKeys.includes(key);
}

async function readBody(req, limit = config.maxBodyBytes ?? 10 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) {
      const err = new Error(`request body exceeds ${limit} bytes`);
      err.status = 413;
      throw err;
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/** Light validation of an OpenAI chat body — returns an error string or null. */
function validateChatBody(body) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) return 'messages must be a non-empty array';
  for (const m of body.messages) {
    if (!m || typeof m !== 'object' || !['system', 'user', 'assistant', 'tool', 'developer'].includes(m.role)) {
      return `invalid message role: ${JSON.stringify(m?.role)}`;
    }
    if (m.content !== null && typeof m.content !== 'string' && !Array.isArray(m.content)) {
      return `message content must be a string, array, or null (role ${m.role})`;
    }
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) return 'tools must be an array';
    for (const t of body.tools) {
      if (t?.type !== 'function' || typeof t.function?.name !== 'string' || !t.function.name) {
        return 'each tool must be {type:"function", function:{name, ...}}';
      }
    }
  }
  if (body.max_tokens !== undefined && !Number.isFinite(body.max_tokens)) return 'max_tokens must be a number';
  return null;
}

/** Abort signal that fires when the client disconnects before the response ends. */
function clientAbort(res) {
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(new Error('client disconnected')); });
  return ac.signal;
}

/**
 * Copy an upstream body to the client. Returns { ok, bytes, error }.
 * A failure here means the client sees a truncated response, so callers must
 * report status 5xx / streamError instead of a healthy 200.
 */
async function pipeBody(up, res, tap) {
  const reader = up.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (tap) tap(value);
      if (!res.write(value)) {
        // wait for drain, but bail out if the client goes away instead
        await new Promise((resolve) => {
          const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
          res.once('drain', done);
          res.once('close', done);
        });
        if (res.destroyed || res.writableEnded) throw new Error('client disconnected');
      }
    }
    res.end();
    return { ok: true, bytes, error: null };
  } catch (err) {
    // upstream aborted / timed out / client went away mid-stream
    try { reader.cancel().catch(() => {}); } catch {}
    try { if (!res.writableEnded) res.end(); } catch {}
    return { ok: false, bytes, error: err };
  }
}

/**
 * Run `fn(account)` trying accounts in round-robin order with failover.
 * Account-issue errors (concurrent_session, concurrent, ads_required after
 * recovery, auth) move to the next account; busy accounts (at the in-flight
 * cap) are skipped without spending an upstream attempt. If every account is
 * busy, wait briefly for a free slot instead of hammering upstream. At most
 * two rounds, and never more than config.maxTotalAttempts upstream attempts.
 */
const ACCOUNT_ISSUE_CODES = new Set(['concurrent_session', 'concurrent', 'auth', 'ads_required']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withFailover(fn, { path, rid, ctx }) {
  const isBusy = (a) => inFlightCount(a.id) >= config.maxInFlightPerAccount;
  const maxTotal = config.maxTotalAttempts ?? 10;
  let lastErr;

  for (let round = 0; round < 2; round++) {
    if (round > 0) {
      if (!(lastErr instanceof UpstreamError) || !ACCOUNT_ISSUE_CODES.has(lastErr.code)) throw lastErr;
      if ((ctx?.attempts ?? 0) >= maxTotal) throw lastErr;
      log.info('all accounts hit account issues, one more round after backoff', { rid, path, wait: 1500 });
      await sleep(1500);
    }

    // if every account is busy, wait (bounded) for a free slot first
    if (pickOrder().every(isBusy)) {
      const deadline = Date.now() + (config.busyWaitMs ?? 15_000);
      log.info('all accounts busy, waiting for a free slot', { rid, path, waitUntilCap: config.busyWaitMs ?? 15_000 });
      while (Date.now() < deadline && pickOrder().every(isBusy)) await sleep(250);
    }

    for (const account of pickOrder()) {
      if (isBusy(account)) {
        if (ctx) ctx.tried.push({ account: account.id, error: 'busy-skipped' });
        continue;
      }
      const release = beginRequest(account);
      if (ctx) ctx.account = account.id;
      try {
        return await fn(account);
      } catch (err) {
        lastErr = err;
        if (ctx) ctx.tried.push({ account: account.id, error: err.code ?? err.message });
        const accountIssue = err instanceof UpstreamError && ACCOUNT_ISSUE_CODES.has(err.code);
        if (!accountIssue || (ctx?.attempts ?? 0) >= maxTotal) throw err;
        if (ctx) ctx.failovers = (ctx.failovers ?? 0) + 1;
        log.warn('failing over to next account', { rid, path, from: account.id, reason: err.code ?? err.message });
        // the account is mid-request elsewhere: brief pause before the next one
        if (err.code === 'concurrent' || err.code === 'concurrent_session') await sleep(300);
      } finally {
        release();
      }
    }
  }
  throw lastErr;
}

/** Record a completed request, including a non-200 when the body was truncated. */
function recordOutcome(accountId, path, status, started, extra = {}) {
  record(accountId, { path, status, ms: Date.now() - started, ...extra });
}

// ---- route handlers ---------------------------------------------------------
async function handleChatCompletions(req, res, rid, ctx) {
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw.toString('utf8') || '{}'); }
  catch { return json(res, 400, errorBody(false, 400, 'request body is not valid JSON')); }
  const verr = validateChatBody(body);
  if (verr) return json(res, 400, errorBody(false, 400, verr));

  const streaming = body.stream === true || body.stream === 'true';
  if (body.stream === 'true') body.stream = true;           // coerce sloppy clients
  else if (body.stream === 'false') body.stream = false;
  // ask upstream for usage on streamed responses unless the caller already did
  let bodyStr = raw;
  if (streaming && !body.stream_options) {
    body.stream_options = { include_usage: true };
    bodyStr = JSON.stringify(body);
  }
  const signal = clientAbort(res);

  return withFailover(async (account) => {
    const started = Date.now();
    const up = await upstream('/v1/chat/completions', {
      method: 'POST', body: bodyStr, account, signal, onAttempt: (n) => { if (ctx) ctx.attempts = (ctx.attempts ?? 0) + n; },
    });

    if (!streaming) {
      const headers = Object.fromEntries(up.headers.entries());
      for (const h of ['content-encoding', 'content-length', 'transfer-encoding']) delete headers[h];
      res.writeHead(up.status, { ...headers, ...CORS });
      let text = '';
      const pipe = await pipeBody(up, res, (buf) => { text += buf.toString(); });
      const m = text.match(/"prompt_tokens":\s*(\d+)/);
      const m2 = text.match(/"completion_tokens":\s*(\d+)/);
      if (!pipe.ok) {
        log.error('response body copy failed', { rid, path: '/v1/chat/completions', account: account.id, bytes: pipe.bytes, error: pipe.error.message });
        if (ctx) ctx.streamError = pipe.error.message;
      }
      recordOutcome(account.id, '/v1/chat/completions', pipe.ok ? up.status : 502, started, {
        inputTokens: m ? +m[1] : 0, outputTokens: m2 ? +m2[1] : 0,
        ...(pipe.ok ? {} : { error: `body copy failed after ${pipe.bytes}B: ${pipe.error.message}` }),
      });
      return;
    }

    if (!up.ok) throw new UpstreamError(up.status, await up.text().catch(() => ''));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...CORS });
    let inTok = 0, outTok = 0;
    let tail = '';
    let lineBuf = '';
    let sawUpstreamError = false;
    const pipe = await pipeBody(up, res, (buf) => {
      tail = (tail + buf.toString()).slice(-4000);
      const a = tail.match(/"prompt_tokens":\s*(\d+)/);
      const b = tail.match(/"completion_tokens":\s*(\d+)/);
      if (a) inTok = +a[1];
      if (b) outTok = +b[1];
      // inspect complete SSE data lines: an upstream error mid-stream keeps a
      // 200 status — surface it to the client as an OpenAI-style error chunk
      lineBuf += buf.toString();
      let nl;
      while ((nl = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]' || !payload.startsWith('{')) continue;
        try {
          const obj = JSON.parse(payload);
          if (obj.error && !obj.choices && !obj.id && !sawUpstreamError) {
            sawUpstreamError = true;
            const msgText = obj.error.message ?? 'upstream stream error';
            if (ctx) ctx.streamError = msgText;
            log.error('upstream error inside SSE stream', { rid, error: msgText });
            res.write(`data: ${JSON.stringify({ error: { message: msgText, type: 'upstream_error', code: obj.error.code ?? obj.error.type ?? null } })}\n\n`);
          }
        } catch {}
      }
    });
    if (!pipe.ok) {
      log.error('stream interrupted mid-flight', { rid, path: '/v1/chat/completions', account: account.id, bytes: pipe.bytes, error: pipe.error.message });
      if (ctx) ctx.streamError = pipe.error.message;
    }
    recordOutcome(account.id, '/v1/chat/completions', pipe.ok ? (sawUpstreamError ? 502 : 200) : 502, started, {
      inputTokens: inTok, outputTokens: outTok,
      ...(pipe.ok ? (sawUpstreamError ? { error: 'upstream sent error mid-stream' } : {}) : { error: `streaming interrupted after ${pipe.bytes}B: ${pipe.error.message}` }),
    });
  }, { path: '/v1/chat/completions', rid, ctx });
}

async function handleMessages(req, res, rid, ctx) {
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw.toString('utf8') || '{}'); }
  catch { return json(res, 400, errorBody(true, 400, 'request body is not valid JSON')); }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return json(res, 400, errorBody(true, 400, 'messages must be a non-empty array'));
  }
  const signal = clientAbort(res);
  await getCatalog(primaryAccount());
  const oai = anthropicToOpenAI(body);

  return withFailover(async (account) => {
    const started = Date.now();
    const up = await upstream('/v1/chat/completions', {
      method: 'POST', body: JSON.stringify(oai), account, headers: { accept: 'application/json' }, signal,
      onAttempt: (n) => { if (ctx) ctx.attempts = (ctx.attempts ?? 0) + n; },
    });
    if (!up.ok) throw new UpstreamError(up.status, await up.text().catch(() => ''));

    if (oai.stream) {
      return streamTranslate(up, body.model, res, (usage, streamError) => {
        if (streamError && ctx) ctx.streamError = streamError.message;
        recordOutcome(account.id, '/v1/messages', streamError ? 502 : 200, started, {
          model: oai.model, ...usage,
          ...(streamError ? { error: `streaming interrupted: ${streamError.message}` } : {}),
        });
      }, { stopSequences: body.stop_sequences, signal });
    }
    const data = await up.json();
    let msg;
    try { msg = openAIToAnthropic(data, body.model, { stopSequences: body.stop_sequences }); }
    catch (err) {
      if (err instanceof MalformedToolCallError) {
        log.error('malformed tool arguments from upstream', { rid, error: err.message });
        return json(res, 502, errorBody(true, 502, err.message));
      }
      throw err;
    }
    recordOutcome(account.id, '/v1/messages', 200, started, {
      model: oai.model, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens,
    });
    log.info('messages ok', { rid, account: account.id, model: oai.model, in: msg.usage.input_tokens, out: msg.usage.output_tokens, stop: msg.stop_reason });
    return json(res, 200, msg);
  }, { path: '/v1/messages', rid, ctx });
}

async function handleCountTokens(req, res) {
  const body = JSON.parse((await readBody(req)).toString() || '{}');
  const chars = JSON.stringify(body.messages ?? []).length + JSON.stringify(body.system ?? '').length;
  return json(res, 200, { input_tokens: Math.ceil(chars / 4) });
}

async function handleModels(req, res) {
  const models = await getCatalog(primaryAccount());
  const list = (models.length ? models : [{ id: defaultModel(), stats_id: defaultModel() }]).map((m) => ({
    id: m.stats_id ?? m.id, object: 'model', created: 0, owned_by: 'free-pi',
  }));
  return json(res, 200, { object: 'list', data: list });
}

async function handleHealth(req, res) {
  return json(res, 200, {
    ok: true, upstream: config.base, session: SESSION_ID, inFlight: inFlightAll(),
    endpoints: ['/v1/chat/completions', '/v1/messages', '/v1/messages/count_tokens', '/v1/models', '/admin', '/health'],
  });
}

// ---- router -------------------------------------------------------------------
const ROUTES = [
  { method: 'POST', path: '/v1/chat/completions', handler: handleChatCompletions, anthropic: false },
  { method: 'POST', path: '/v1/messages', handler: handleMessages, anthropic: true },
  { method: 'POST', path: '/v1/messages/count_tokens', handler: handleCountTokens, anthropic: true },
  { method: 'GET', path: '/v1/models', handler: handleModels, anthropic: false },
  { method: 'GET', path: '/admin', handler: (req, res, rid, url) => handleAdmin(req, res, url), anthropic: false },
  { method: 'GET', path: '/admin/api/overview', handler: (req, res, rid, url) => handleAdmin(req, res, url), anthropic: false },
  { method: 'POST', path: '/admin/api/accounts', handler: (req, res, rid, url) => handleAdmin(req, res, url), anthropic: false },
  { method: 'POST', path: '/admin/api/accounts/login/start', handler: (req, res, rid, url) => handleAdmin(req, res, url), anthropic: false },
  { method: 'POST', path: '/admin/api/accounts/login/poll', handler: (req, res, rid, url) => handleAdmin(req, res, url), anthropic: false },
  { method: 'POST', path: '/admin/api/accounts/:id/toggle', handler: (req, res, rid, url) => handleAdmin(req, res, url), anthropic: false },
  { method: 'DELETE', path: '/admin/api/accounts/:id', handler: (req, res, rid, url) => handleAdmin(req, res, url), anthropic: false },
  { method: 'GET', path: '/admin/api/accounts/export', handler: (req, res, rid, url) => handleAdmin(req, res, url), anthropic: false },
  { method: 'POST', path: '/admin/api/accounts/import', handler: (req, res, rid, url) => handleAdmin(req, res, url), anthropic: false },
  { method: 'GET', path: '/health', handler: handleHealth, anthropic: false },
];

function matchRoute(method, pathname) {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    if (!r.path.includes(':')) { if (r.path === pathname) return r; continue; }
    const pattern = new RegExp(`^${r.path.replace(/:[^/]+/g, '[^/]+')}$`);
    if (pattern.test(pathname)) return r;
  }
  return null;
}

export function createServer() {
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const rid = randomUUID().slice(0, 8);
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const route = matchRoute(req.method, url.pathname);
    const ctx = { attempts: 0, failovers: 0, account: null, tried: [], streamError: null };

    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

    log.info('request', { rid, method: req.method, path: url.pathname, ua: req.headers['user-agent'] });

    if (!clientAuthorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json', ...CORS });
      return res.end(JSON.stringify(errorBody(route?.anthropic ?? false, 401, 'invalid client api key')));
    }
    if (!route) return json(res, 404, errorBody(false, 404, `no route ${req.method} ${url.pathname}`));

    res.on('finish', () => log.info('response', {
      rid, path: url.pathname, status: res.statusCode, ms: Date.now() - started,
      account: ctx.account, attempts: ctx.attempts, failovers: ctx.failovers,
      ...(ctx.streamError ? { streamError: ctx.streamError } : {}),
      ...(ctx.tried?.length ? { tried: ctx.tried } : {}),
    }));

    try {
      await route.handler(req, res, rid, ctx);
    } catch (err) {
      const status = err instanceof UpstreamError ? err.status
        : Number.isInteger(err.status) ? err.status
        : err.message?.includes('no enabled accounts') ? 503 : 502;
      const detail = err instanceof UpstreamError ? err.body || err.message : err.message;
      record(ctx.account ?? 'gateway', { path: url.pathname, status, ms: Date.now() - started, error: detail });
      log.error('route failed', { rid, path: url.pathname, status, error: err.message, account: ctx.account, attempts: ctx.attempts, upstreamBody: String(detail).slice(0, 800) });
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json', ...CORS });
      if (!res.writableEnded) res.end(JSON.stringify(errorBody(route.anthropic, status, detail)));
    }
  });

  return {
    server,
    listen() {
      return new Promise((resolve) => {
        server.listen(config.port, config.host, () => {
          log.info('gateway listening', { host: config.host, port: config.port, upstream: config.base, session: SESSION_ID, config: configFileUsed });
          resolve(server);
        });
      });
    },
    close() { return new Promise((r) => server.close(r)); },
  };
}
