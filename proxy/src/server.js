// server.js — HTTP router: auth gate, CORS, request logging, error mapping.
// Per-request account selection (round-robin) with failover across accounts.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { config, configFileUsed, SESSION_ID } from './config.js';
import { log } from './logger.js';
import { upstream, UpstreamError, resetOtherSessions, fingerprintHeaders } from './upstream.js';
import { pickOrder, primaryAccount } from './accounts.js';
import { record } from './usage.js';
import { getCatalog, resolveModel, defaultModel } from './catalog.js';
import { anthropicToOpenAI } from './translate/request.js';
import { openAIToAnthropic, errorBody } from './translate/response.js';
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

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

async function pipeBody(up, res, tap) {
  const reader = up.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (tap) tap(value);
    if (!res.write(value)) await new Promise((r) => res.once('drain', r));
  }
  res.end();
}

/**
 * Run `fn(account)` trying accounts in round-robin order with failover:
 * concurrent_session that survives the auto-reset, or auth errors, move to
 * the next account. Non-account errors propagate immediately.
 */
async function withFailover(fn, { path, rid }) {
  const order = pickOrder();
  let lastErr;
  for (let i = 0; i < order.length; i++) {
    const account = order[i];
    try {
      return await fn(account);
    } catch (err) {
      lastErr = err;
      const retryableAccountIssue =
        err instanceof UpstreamError && (err.code === 'concurrent_session' || err.code === 'auth');
      if (!retryableAccountIssue || i === order.length - 1) throw err;
      log.warn('failing over to next account', { rid, path, from: account.id, reason: err.code ?? err.message });
    }
  }
  throw lastErr;
}

// ---- route handlers ---------------------------------------------------------
async function handleChatCompletions(req, res, rid) {
  const raw = await readBody(req);
  const streaming = (req.headers.accept ?? '').includes('text/event-stream') || raw.toString().includes('"stream":true');

  return withFailover(async (account) => {
    const started = Date.now();
    const up = await upstream('/v1/chat/completions', { method: 'POST', body: raw, account });

    if (!streaming) {
      const headers = Object.fromEntries(up.headers.entries());
      for (const h of ['content-encoding', 'content-length', 'transfer-encoding']) delete headers[h];
      res.writeHead(up.status, { ...headers, ...CORS });
      let text = '';
      await pipeBody(up, res, (buf) => { text += buf.toString(); });
      const m = text.match(/"prompt_tokens":\s*(\d+)/);
      const m2 = text.match(/"completion_tokens":\s*(\d+)/);
      record(account.id, {
        path: '/v1/chat/completions', status: up.status, ms: Date.now() - started,
        inputTokens: m ? +m[1] : 0, outputTokens: m2 ? +m2[1] : 0,
      });
      return;
    }

    if (!up.ok) throw new UpstreamError(up.status, await up.text().catch(() => ''));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...CORS });
    let inTok = 0, outTok = 0;
    let tail = '';
    await pipeBody(up, res, (buf) => {
      tail = (tail + buf.toString()).slice(-4000);
      const a = tail.match(/"prompt_tokens":\s*(\d+)/);
      const b = tail.match(/"completion_tokens":\s*(\d+)/);
      if (a) inTok = +a[1];
      if (b) outTok = +b[1];
    });
    record(account.id, { path: '/v1/chat/completions', status: 200, ms: Date.now() - started, inputTokens: inTok, outputTokens: outTok });
  }, { path: '/v1/chat/completions', rid });
}

async function handleMessages(req, res, rid) {
  const body = JSON.parse((await readBody(req)).toString() || '{}');
  await getCatalog(primaryAccount());
  const oai = anthropicToOpenAI(body);

  return withFailover(async (account) => {
    const started = Date.now();
    const up = await upstream('/v1/chat/completions', {
      method: 'POST', body: JSON.stringify(oai), account, headers: { accept: 'application/json' },
    });
    if (!up.ok) throw new UpstreamError(up.status, await up.text().catch(() => ''));

    if (oai.stream) {
      return streamTranslate(up, body.model, res, (usage) =>
        record(account.id, { path: '/v1/messages', status: 200, model: oai.model, ms: Date.now() - started, ...usage }));
    }
    const data = await up.json();
    const msg = openAIToAnthropic(data, body.model);
    record(account.id, {
      path: '/v1/messages', status: 200, model: oai.model, ms: Date.now() - started,
      inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens,
    });
    log.info('messages ok', { rid, account: account.id, model: oai.model, in: msg.usage.input_tokens, out: msg.usage.output_tokens, stop: msg.stop_reason });
    return json(res, 200, msg);
  }, { path: '/v1/messages', rid });
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
    ok: true, upstream: config.base, session: SESSION_ID,
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
  { method: 'POST', path: '/admin/api/accounts/:id/toggle', handler: (req, res, rid, url) => handleAdmin(req, res, url), anthropic: false },
  { method: 'DELETE', path: '/admin/api/accounts/:id', handler: (req, res, rid, url) => handleAdmin(req, res, url), anthropic: false },
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

    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

    log.info('request', { rid, method: req.method, path: url.pathname });

    if (!clientAuthorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json', ...CORS });
      return res.end(JSON.stringify(errorBody(route?.anthropic ?? false, 401, 'invalid client api key')));
    }
    if (!route) return json(res, 404, errorBody(false, 404, `no route ${req.method} ${url.pathname}`));

    res.on('finish', () => log.info('response', { rid, path: url.pathname, status: res.statusCode, ms: Date.now() - started }));

    try {
      await route.handler(req, res, rid, url);
    } catch (err) {
      const status = err instanceof UpstreamError ? err.status : err.message?.includes('no enabled accounts') ? 503 : 502;
      const detail = err instanceof UpstreamError ? err.body || err.message : err.message;
      record('gateway', { path: url.pathname, status, ms: Date.now() - started, error: detail });
      log.error('route failed', { rid, path: url.pathname, status, error: err.message });
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
