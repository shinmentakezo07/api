#!/usr/bin/env node
// freepi-gateway.mjs — local gateway in front of api.freepi.ai that exposes:
//
//   POST /v1/chat/completions        OpenAI-compatible (passthrough, streaming OK)
//   POST /v1/messages                Anthropic Messages API (for Claude Code) — translated
//   POST /v1/messages/count_tokens   rough token estimate
//   GET  /v1/models                  OpenAI model list (from /client-version catalog)
//
// All requests are sent upstream with the same fingerprint as free-pi-cli:
//   Authorization: Bearer <jwt from ~/.free-pi/agent/credentials.json>
//   x-session-id: <uuid>   x-client-version: 0.6.14
//
// Run:  node freepi-gateway.mjs [--port 8787]
// Claude Code:
//   ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_API_KEY=anything claude

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const argOf = (n) => {
  const i = args.indexOf(n);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
};

// optional config file: --config <path> or shi.json next to this script
const configFile = argOf('--config') ?? join(import.meta.dirname, 'shi.json');
let cfg = {};
if (existsSync(configFile)) {
  try { cfg = JSON.parse(readFileSync(configFile, 'utf8')); console.log(`config: ${configFile}`); }
  catch (e) { console.error(`bad config ${configFile}: ${e.message}`); }
}

const PORT = Number(argOf('--port') ?? cfg.port ?? process.env.PORT ?? 8787);
const BASE = (argOf('--base') ?? cfg.base ?? process.env.FREEPI_BASE_URL ?? 'https://api.freepi.ai').replace(/\/+$/, '');
const CLI_VERSION = cfg.cliVersion ?? '0.6.14';
const DEFAULT_MODEL = cfg.defaultModel ?? 'deepseek/deepseek-v4-flash';
const CRED_FILE = cfg.credentialsFile ?? join(homedir(), '.free-pi', 'agent', 'credentials.json');
const SESSION_ID = randomUUID();

let jwt = loadToken(), lastLoad = 0;
function loadToken() {
  if (!existsSync(CRED_FILE)) { console.error(`No credentials at ${CRED_FILE}`); process.exit(1); }
  return JSON.parse(readFileSync(CRED_FILE, 'utf8')).token;
}
function getToken() {
  if (Date.now() - lastLoad > 60_000) { try { jwt = loadToken(); } catch {} lastLoad = Date.now(); }
  return jwt;
}

function fingerprintHeaders(extra = {}) {
  return {
    authorization: `Bearer ${getToken()}`,
    'x-session-id': SESSION_ID,
    'x-client-version': CLI_VERSION,
    'content-type': 'application/json',
    ...extra,
  };
}

// ---------- model catalog ---------------------------------------------------
let catalog = { models: [], fetched: 0 };
async function getCatalog() {
  if (Date.now() - catalog.fetched < 300_000) return catalog.models;
  try {
    const res = await fetch(`${BASE}/client-version`, { headers: fingerprintHeaders() });
    const data = await res.json();
    catalog = { models: data.models ?? [], fetched: Date.now() };
  } catch { catalog.fetched = Date.now(); }
  return catalog.models;
}
function resolveModel(requested) {
  const models = catalog.models;
  if (requested && models.some(m => m.id === requested || m.stats_id === requested)) return requested;
  return DEFAULT_MODEL;
}

// ---------- Anthropic -> OpenAI request translation -------------------------
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b.type === 'text').map(b => b.text).join('\n');
}
function anthropicToOpenAI(body) {
  const messages = [];
  const sys = textOf(body.system);
  if (sys) messages.push({ role: 'system', content: sys });

  for (const msg of body.messages ?? []) {
    const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content ?? '' }];
    if (msg.role === 'assistant') {
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
      const toolCalls = blocks.filter(b => b.type === 'tool_use').map((b, i) => ({
        id: b.id, type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
      const m = { role: 'assistant', content: text || null };
      if (toolCalls.length) m.tool_calls = toolCalls;
      messages.push(m);
    } else { // user
      const toolResults = blocks.filter(b => b.type === 'tool_result');
      for (const tr of toolResults) {
        messages.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: typeof tr.content === 'string' ? tr.content : textOf(tr.content) || '',
        });
      }
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
      if (text) messages.push({ role: 'user', content: text });
      else if (!toolResults.length) messages.push({ role: 'user', content: '' });
    }
  }

  const out = { model: resolveModel(body.model), messages, max_tokens: body.max_tokens ?? 4096, stream: !!body.stream };
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stop_sequences?.length) out.stop = body.stop_sequences;
  if (body.tools?.length) {
    out.tools = body.tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description ?? '', parameters: t.input_schema ?? { type: 'object' } },
    }));
    if (body.tool_choice) out.tool_choice = body.tool_choice === 'auto' ? 'auto' : body.tool_choice === 'any' ? 'required' : body.tool_choice;
  }
  return out;
}

// ---------- OpenAI -> Anthropic response translation -------------------------
const stopReason = (fr) => fr === 'tool_calls' ? 'tool_use' : fr === 'length' ? 'max_tokens' : 'end_turn';

function openAIToAnthropic(oai, reqModel) {
  const msg = oai.choices?.[0]?.message ?? {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls ?? []) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {}
    content.push({ type: 'tool_use', id: tc.id ?? `toolu_${randomUUID().slice(0, 8)}`, name: tc.function?.name, input });
  }
  return {
    id: `msg_${oai.id ?? randomUUID()}`,
    type: 'message', role: 'assistant',
    model: reqModel,
    content,
    stop_reason: stopReason(oai.choices?.[0]?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: oai.usage?.prompt_tokens ?? 0,
      output_tokens: oai.usage?.completion_tokens ?? 0,
    },
  };
}

// ---------- streaming translation (OpenAI SSE -> Anthropic SSE) -------------
async function streamTranslate(upstreamRes, reqModel, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  send('message_start', {
    type: 'message_start',
    message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: reqModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
  });

  const blocks = [];           // {type:'text'|'tool_use', index, id?, name?, text?, json?}
  let stop = 'end_turn', outTokens = 0, inTokens = 0;
  let buffer = '';

  const reader = upstreamRes.body.getReader();
  const dec = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let chunk; try { chunk = JSON.parse(payload); } catch { continue; }
      if (chunk.usage) { inTokens = chunk.usage.prompt_tokens ?? inTokens; outTokens = chunk.usage.completion_tokens ?? outTokens; }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (chunk.choices[0].finish_reason) stop = stopReason(chunk.choices[0].finish_reason);

      if (delta.content) {
        let b = blocks.find(b => b.type === 'text');
        if (!b) { b = { type: 'text', index: blocks.length, text: '' }; blocks.push(b);
          send('content_block_start', { type: 'content_block_start', index: b.index, content_block: { type: 'text', text: '' } }); }
        b.text += delta.content;
        send('content_block_delta', { type: 'content_block_delta', index: b.index, delta: { type: 'text_delta', text: delta.content } });
      }
      for (const tc of delta.tool_calls ?? []) {
        let b = blocks.find(x => x.type === 'tool_use' && x.oaiIndex === tc.index);
        if (!b) { b = { type: 'tool_use', oaiIndex: tc.index, index: blocks.length, id: tc.id, name: tc.function?.name ?? '', json: '' }; blocks.push(b);
          send('content_block_start', { type: 'content_block_start', index: b.index, content_block: { type: 'tool_use', id: b.id ?? `toolu_${randomUUID().slice(0, 8)}`, name: b.name, input: {} } }); }
        if (tc.function?.name && !b.name) { b.name = tc.function.name; }
        if (tc.function?.arguments) {
          b.json += tc.function.arguments;
          send('content_block_delta', { type: 'content_block_delta', index: b.index, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } });
        }
      }
    }
  }
  for (const b of blocks) send('content_block_stop', { type: 'content_block_stop', index: b.index });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: outTokens || estimateTokens(blocks) } });
  send('message_stop', { type: 'message_stop' });
  res.end();
}
const estimateTokens = (blocks) => blocks.reduce((n, b) => n + Math.ceil((b.text ?? b.json ?? '').length / 4), 0);

// ---------- HTTP server ------------------------------------------------------
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  try {
    // --- OpenAI passthrough ---
    if (path === '/v1/chat/completions') {
      const body = await readBody(req);
      const up = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST', headers: fingerprintHeaders({ accept: req.headers.accept ?? 'application/json' }),
        body: body.length ? body : undefined,
      });
      if ((req.headers.accept ?? '').includes('text/event-stream') || body.toString().includes('"stream":true')) {
        return streamPassthrough(up, res);
      }
      const headers = Object.fromEntries(up.headers.entries());
      delete headers['content-encoding']; delete headers['content-length']; delete headers['transfer-encoding'];
      res.writeHead(up.status, headers);
      if (up.body) { const r = up.body.getReader(); while (true) { const { done, value } = await r.read(); if (done) break; if (!res.write(value)) await new Promise(r2 => res.once('drain', r2)); } }
      return res.end();
    }

    // --- Anthropic Messages (Claude Code) ---
    if (path === '/v1/messages') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const oai = anthropicToOpenAI(body);
      await getCatalog(); // ensure model resolution has data
      oai.model = resolveModel(body.model);
      const up = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: fingerprintHeaders(), body: JSON.stringify(oai) });
      if (!up.ok) {
        const errText = await up.text();
        res.writeHead(up.status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `upstream ${up.status}: ${errText.slice(0, 300)}` } }));
      }
      if (oai.stream) return streamTranslate(up, body.model, res);
      const data = await up.json();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(openAIToAnthropic(data, body.model)));
    }

    if (path === '/v1/messages/count_tokens') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const chars = JSON.stringify(body.messages ?? '').length + textOf(body.system).length;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: Math.ceil(chars / 4) }));
    }

    // --- OpenAI models list from the real catalog ---
    if (path === '/v1/models') {
      const models = await getCatalog();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        object: 'list',
        data: (models.length ? models : [{ id: DEFAULT_MODEL, name: DEFAULT_MODEL }]).map(m => ({
          id: m.stats_id ?? m.id, object: 'model', owned_by: 'free-pi',
        })),
      }));
    }

    if (path === '/' || path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, upstream: BASE, session: SESSION_ID, endpoints: ['/v1/chat/completions', '/v1/messages', '/v1/models'] }));
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `no route ${path}` } }));
  } catch (err) {
    console.error(`${req.method} ${path} ERROR`, err.message);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: err.message } }));
  }
});

async function streamPassthrough(up, res) {
  res.writeHead(up.status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const r = up.body.getReader();
  while (true) { const { done, value } = await r.read(); if (done) break; if (!res.write(value)) await new Promise(x => res.once('drain', x)); }
  res.end();
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`free-pi gateway`);
  console.log(`  config   : ${configFile}${existsSync(configFile) ? '' : ' (not found, defaults)'}`);
  console.log(`  upstream : ${BASE}`);
  console.log(`  listening: http://127.0.0.1:${PORT}`);
  console.log(`  session  : ${SESSION_ID}`);
  console.log(`  claude   : ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT} ANTHROPIC_API_KEY=x claude`);
});
