// server.js — HTTP router: auth gate, CORS, request logging, error mapping.
// Per-request account selection (round-robin) with failover across accounts.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { config, configFileUsed, SESSION_ID } from './config.js';
import { log } from './logger.js';
import { upstream, UpstreamError, resetOtherSessions, fingerprintHeaders } from './upstream.js';
import { pickOrder, peekOrder, primaryAccount, beginRequest, inFlightCount, inFlightAll } from './accounts.js';
import { record } from './usage.js';
import { getCatalog, resolveModel, defaultModel } from './catalog.js';
import { anthropicToOpenAI } from './translate/request.js';
import { openAIToAnthropic, errorBody, MalformedToolCallError } from './translate/response.js';
import { streamTranslate } from './translate/stream.js';
import { handleAdmin } from './admin.js';
import { conversationKeyOf } from './session.js';
import { versionInfo } from './version.js';

// /v1/* is a machine API: any origin may call it (the client key is the gate).
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-api-key, anthropic-version, anthropic-beta',
};

// /admin and /admin/api/* are driven by a browser. A wildcard origin there lets
// any page send the x-admin-key header after a successful preflight, so these
// routes get same-origin only: no ACAO header unless the request came from the
// page this server itself serves.
const ADMIN_CORS = {
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-admin-key',
};

/** True when the browser said the page lives on this very host:port. */
function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client (curl, SDK): CORS does not apply
  if (origin === 'null') return false;
  let host;
  try { host = new URL(origin).host.toLowerCase(); } catch { return false; }
  return host === String(req.headers.host ?? '').toLowerCase();
}

/** Headers for one response: admin routes are same-origin only. */
function corsFor(req, pathname) {
  const admin = pathname === '/admin' || pathname.startsWith('/admin/');
  if (!admin) return CORS;
  const base = { ...ADMIN_CORS };
  if (isSameOrigin(req)) base['access-control-allow-origin'] = req.headers.origin ?? 'null';
  base['vary'] = 'origin';
  return base;
}

function json(res, status, body, extra = {}, cors = CORS) {
  res.writeHead(status, { 'content-type': 'application/json', ...cors, ...extra });
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

/**
 * Abort signal that fires when the client disconnects before the response ends.
 * The listener is removed once the request settles, so a long-lived keep-alive
 * socket cannot accumulate one AbortController per failover attempt — each of
 * which would otherwise abort (and log) on every later close.
 */
function clientAbort(res) {
  const ac = new AbortController();
  const onClose = () => { if (!res.writableEnded) ac.abort(new Error('client disconnected')); };
  const cleanup = () => res.off('close', onClose);
  res.on('close', onClose);
  ac.signal.addEventListener('abort', cleanup, { once: true });
  res.once('finish', cleanup);
  return ac.signal;
}

/** Resolve on the next 'drain', or when the socket closes. Always detaches. */
function waitDrain(res) {
  return new Promise((resolve) => {
    const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
    res.once('drain', done);
    res.once('close', done);
  });
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
        // wait for drain, but bail out if the client goes away instead.
        // Listeners are always detached — including when write() throws below,
        // so a keep-alive socket never accumulates stale handlers.
        await waitDrain(res);
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

    // if every account is busy, wait (bounded) for a free slot first.
    // Probe with peekOrder(): it must not advance the round-robin cursor.
    if (peekOrder().length && peekOrder().every(isBusy)) {
      const deadline = Date.now() + (config.busyWaitMs ?? 15_000);
      log.info('all accounts busy, waiting for a free slot', { rid, path, waitUntilCap: config.busyWaitMs ?? 15_000 });
      while (Date.now() < deadline && peekOrder().length && peekOrder().every(isBusy)) await sleep(250);
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

/**
 * Record a completed request, including a non-200 when the body was truncated.
 * Sets ctx.recorded so the router's catch-all doesn't count the same request
 * a second time when a handler records and then throws.
 */
function recordOutcome(ctx, accountId, path, status, started, extra = {}) {
  record(accountId, { path, status, ms: Date.now() - started, ...extra });
  if (ctx) ctx.recorded = true;
}

// ---- state machines -----------------------------------------------------------
// These are implicit: they're enforced by convention across the three files below,
// not by types. Keep them in sync when changing request handling.
//
// A. REQUEST LIFECYCLE (this file). Per request: ctx = { attempts, failovers,
//    account, tried, streamError, recorded }. Exactly ONE usage row is written
//    per client request. recordOutcome() sets ctx.recorded so the router's
//    catch-all skips its own record() on the same request; a handler that
//    records and then rethrows must therefore call recordOutcome, never record().
//
// B. FAILOVER (withFailover). Order comes from pickOrder(), which ADVANCES the
//    round-robin cursor — call it exactly once per attempt loop. Busy/availability
//    probes use peekOrder(), which is pure; using pickOrder() there skews
//    distribution. Account-issue codes may trigger a 2nd round; all other errors
//    propagate immediately. inFlight is incremented by beginRequest() and released
//    in the finally block, so a thrown attempt can never leak a session slot.
//
// C. RESPONSE WRITE (pipeBody + handlers). Headers are irreversible: after
//    writeHead() a failure can no longer be reported as a 5xx. Streaming
//    therefore writes a 200 SSE head and reports later failures as an in-band
//    error event with a 502 usage row; non-streaming buffers the whole body
//    first so a broken copy still yields a real 502. Backpressure waits
//    (waitDrain) always detach their listeners, and clientAbort() listeners are
//    removed on settle so keep-alive sockets don't accumulate aborts.
// -------------------------------------------------------------------------------
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
  const conversationKey = conversationKeyOf(body);

  return withFailover(async (account) => {
    const started = Date.now();
    const up = await upstream('/v1/chat/completions', {
      method: 'POST', body: bodyStr, account, signal, conversationKey,
      onAttempt: (n) => { if (ctx) ctx.attempts = (ctx.attempts ?? 0) + n; },
      onSession: (id) => { if (ctx) ctx.session = id; },
    });

    if (!streaming) {
      // Buffer the whole (small) JSON body before writing any header: once the
      // status line is out, a broken body copy can no longer be reported as an
      // error, and the client would see a truncated 200.
      const headers = Object.fromEntries(up.headers.entries());
      for (const h of ['content-encoding', 'content-length', 'transfer-encoding']) delete headers[h];
      let text = '';
      const reader = up.body.getReader();
      const limit = config.maxBufferedBytes ?? 32 * 1024 * 1024;
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          // the body is held in memory until complete: never let a runaway
          // response exhaust the heap (same discipline as maxBodyBytes)
          if (bytes > limit) throw new Error(`response body exceeds ${limit} bytes`);
          text += Buffer.from(value).toString();
        }
      } catch (err) {
        try { reader.cancel().catch(() => {}); } catch {}
        log.error('response body copy failed', { rid, path: '/v1/chat/completions', account: account.id, bytes, error: err.message });
        if (ctx) ctx.streamError = err.message;
        recordOutcome(ctx, account.id, '/v1/chat/completions', 502, started, { error: `body copy failed after ${bytes}B: ${err.message}` });
        throw new UpstreamError(502, '', `response body copy failed: ${err.message}`);
      }
      // Token counts come from the parsed body, not from a regex over the
      // serialized text: a model that writes "prompt_tokens" inside its own
      // content would otherwise overwrite the real counters.
      let usage = {};
      try { usage = JSON.parse(text)?.usage ?? {}; } catch { log.warn('unparseable upstream body', { rid, bytes }); }
      // the whole body is known now, so advertise its exact length instead of
      // forcing chunked encoding (lets clients fail fast and detect truncation)
      res.writeHead(up.status, { ...headers, 'content-length': String(Buffer.byteLength(text)), ...CORS });
      res.end(text);
      recordOutcome(ctx, account.id, '/v1/chat/completions', up.status, started, {
        inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0,
      });
      return;
    }

    if (!up.ok) throw new UpstreamError(up.status, await up.text().catch(() => ''));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...CORS });
    let inTok = 0, outTok = 0;
    let lineBuf = '';
    let sawUpstreamError = false;
    const pipe = await pipeBody(up, res, (buf) => {
      // inspect complete SSE data lines: usage frames are parsed (not regexed)
      // and an upstream error mid-stream keeps a 200 status — surface it to the
      // client as an OpenAI-style error chunk
      lineBuf += buf.toString();
      let nl;
      while ((nl = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]' || !payload.startsWith('{')) continue;
        let obj;
        try { obj = JSON.parse(payload); } catch { continue; }
        if (obj.usage) {
          if (Number.isFinite(obj.usage.prompt_tokens)) inTok = obj.usage.prompt_tokens;
          if (Number.isFinite(obj.usage.completion_tokens)) outTok = obj.usage.completion_tokens;
        }
        if (obj.error && !obj.choices && !obj.id && !sawUpstreamError) {
          sawUpstreamError = true;
          const msgText = obj.error.message ?? 'upstream stream error';
          if (ctx) ctx.streamError = msgText;
          log.error('upstream error inside SSE stream', { rid, error: msgText });
          res.write(`data: ${JSON.stringify({ error: { message: msgText, type: 'upstream_error', code: obj.error.code ?? obj.error.type ?? null } })}\n\n`);
        }
      }
    });
    if (!pipe.ok) {
      log.error('stream interrupted mid-flight', { rid, path: '/v1/chat/completions', account: account.id, bytes: pipe.bytes, error: pipe.error.message });
      if (ctx) ctx.streamError = pipe.error.message;
    }
    recordOutcome(ctx, account.id, '/v1/chat/completions', pipe.ok ? (sawUpstreamError ? 502 : 200) : 502, started, {
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
  const conversationKey = conversationKeyOf(body);
  await getCatalog(primaryAccount());
  const oai = anthropicToOpenAI(body);

  return withFailover(async (account) => {
    const started = Date.now();
    const up = await upstream('/v1/chat/completions', {
      method: 'POST', body: JSON.stringify(oai), account, headers: { accept: 'application/json' }, signal,
      conversationKey,
      onAttempt: (n) => { if (ctx) ctx.attempts = (ctx.attempts ?? 0) + n; },
      onSession: (id) => { if (ctx) ctx.session = id; },
    });
    if (!up.ok) throw new UpstreamError(up.status, await up.text().catch(() => ''));

    if (oai.stream) {
      return streamTranslate(up, body.model, res, (usage, streamError) => {
        if (streamError && ctx) ctx.streamError = streamError.message;
        recordOutcome(ctx, account.id, '/v1/messages', streamError ? 502 : 200, started, {
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
    recordOutcome(ctx, account.id, '/v1/messages', 200, started, {
      model: oai.model, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens,
    });
    log.info('messages ok', { rid, account: account.id, model: oai.model, in: msg.usage.input_tokens, out: msg.usage.output_tokens, stop: msg.stop_reason });
    return json(res, 200, msg);
  }, { path: '/v1/messages', rid, ctx });
}

// CJK and other wide scripts are roughly one token per character, latin text
// roughly four characters per token.
const WIDE_CHAR = /[\u1100-\u11ff\u2e80-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;

async function handleCountTokens(req, res) {
  let body;
  try { body = JSON.parse((await readBody(req)).toString() || '{}'); }
  catch { return json(res, 400, errorBody(true, 400, 'request body is not valid JSON')); }
  // Tool schemas are forwarded upstream and eat context too, so count them.
  // 4 chars/token is optimistic for code-heavy prompts; the divisor is
  // configurable and defaults to a conservative 3.5.
  const perToken = Number(config.countTokensCharsPerToken) > 0 ? Number(config.countTokensCharsPerToken) : 4;

  // Walk the text the request actually forwards instead of stringifying the
  // whole body: JSON punctuation, quotes and escapes are not tokens, and image
  // base64 is not text. Stringifying over-counted a tools-heavy request badly.
  let chars = 0;
  let wide = 0;
  const addText = (v) => {
    if (typeof v !== 'string' || !v) return;
    const hits = v.match(WIDE_CHAR);
    if (hits) wide += hits.length;
    chars += v.length;
  };
  const walk = (content) => {
    if (typeof content === 'string') return addText(content);
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      switch (block.type) {
        case 'text': addText(block.text); break;
        case 'thinking': addText(block.thinking); break;
        case 'image': chars += 1600; break;             // fixed cost, not base64
        case 'document': chars += 800; break;
        case 'tool_use':
        case 'tool_call':
          addText(block.name ?? block.function?.name);
          if (block.input !== undefined) addText(JSON.stringify(block.input));
          else if (block.function?.arguments) addText(block.function.arguments);
          break;
        case 'tool_result':
          walk(block.content);
          break;
        default: addText(block.text);
      }
    }
  };

  walk(body.system);
  let messages = 0;
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    messages += 1;
    walk(m?.content);
    if (typeof m?.role === 'string') addText(m.role);
    // an OpenAI-style tool call is {id,type,function:{name,arguments}}
    if (Array.isArray(m?.tool_calls)) {
      for (const tc of m.tool_calls) {
        addText(tc?.function?.name);
        addText(tc?.function?.arguments);
      }
    }
  }
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      addText(tool?.name ?? tool?.function?.name);
      addText(tool?.description ?? tool?.function?.description);
      const schema = tool?.input_schema ?? tool?.function?.parameters;
      if (schema) addText(JSON.stringify(schema));
    }
  }
  if (body.tool_choice) addText(JSON.stringify(body.tool_choice));

  const narrow = Math.max(0, chars - wide);
  // per-message framing plus the request's own priming tokens
  return json(res, 200, { input_tokens: Math.ceil(narrow / perToken) + wide + messages * 4 + 3 });
}

async function handleModels(req, res) {
  const models = await getCatalog(primaryAccount());
  // The upstream catalog carries no context length, so clients could only learn
  // the limit by failing a request. Advertise it here (OpenAI-compatible
  // fields: context_length / max_completion_tokens) when configured.
  const ctx = Number(config.contextWindow) > 0 ? Number(config.contextWindow) : null;
  const maxOut = Number(config.maxOutputTokens) > 0 ? Number(config.maxOutputTokens) : null;
  const list = (models.length ? models : [{ id: defaultModel(), stats_id: defaultModel() }]).map((m) => ({
    id: m.stats_id ?? m.id, object: 'model', created: 0, owned_by: 'free-pi',
    ...(ctx ? { context_length: ctx, context_window: ctx } : {}),
    ...(maxOut ? { max_completion_tokens: maxOut } : {}),
  }));
  return json(res, 200, { object: 'list', data: list });
}

async function handleHealth(req, res) {
  return json(res, 200, {
    ok: true, upstream: config.base, session: SESSION_ID, inFlight: inFlightAll(),
    clientVersion: versionInfo(),
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
    const cors = corsFor(req, url.pathname);
    const ctx = { attempts: 0, failovers: 0, account: null, tried: [], streamError: null, recorded: false };

    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

    log.info('request', { rid, method: req.method, path: url.pathname, ua: req.headers['user-agent'] });

    if (!clientAuthorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json', ...cors });
      return res.end(JSON.stringify(errorBody(route?.anthropic ?? false, 401, 'invalid client api key')));
    }
    if (!route) return json(res, 404, errorBody(false, 404, `no route ${req.method} ${url.pathname}`), {}, cors);

    res.on('finish', () => log.info('response', {
      rid, path: url.pathname, status: res.statusCode, ms: Date.now() - started,
      account: ctx.account, session: ctx.session, attempts: ctx.attempts, failovers: ctx.failovers,
      ...(ctx.streamError ? { streamError: ctx.streamError } : {}),
      ...(ctx.tried?.length ? { tried: ctx.tried } : {}),
    }));

    try {
      await route.handler(req, res, rid, ctx);
    } catch (err) {
      const status = err instanceof UpstreamError ? err.status
        : err.name === 'TimeoutError' ? 504
        : Number.isInteger(err.status) ? err.status
        : err.message?.includes('no enabled accounts') ? 503 : 502;
      const detail = err instanceof UpstreamError ? err.body || err.message : err.message;
      // a handler that already recorded this request (e.g. a failed body copy,
      // then rethrow) must not be counted twice
      if (!ctx.recorded) record(ctx.account ?? 'gateway', { path: url.pathname, status, ms: Date.now() - started, error: detail });
      log.error('route failed', { rid, path: url.pathname, status, error: err.message, account: ctx.account, attempts: ctx.attempts, upstreamBody: String(detail).slice(0, 800) });
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json', ...cors });
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
