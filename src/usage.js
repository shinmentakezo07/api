// usage.js — per-account usage counters + recent request ring buffer, persisted
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';

const RECENT_MAX = 200;
let stats = new Map();   // accountId -> {requests, ok, errors, inputTokens, outputTokens, lastUsedAt, lastError}
let recent = [];         // newest last
let dirty = false;
let timer = null;

function blank() {
  return { requests: 0, ok: 0, errors: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: null, lastError: null };
}

export function initUsage() {
  try {
    if (existsSync(config.usageFile)) {
      const data = JSON.parse(readFileSync(config.usageFile, 'utf8'));
      stats = new Map(Object.entries(data.stats ?? {}));
      recent = Array.isArray(data.recent) ? data.recent.slice(-RECENT_MAX) : [];
    }
  } catch (e) { log.warn('usage load failed', { error: e.message }); }
  try { mkdirSync(dirname(config.usageFile), { recursive: true }); } catch {}
  timer = setInterval(flush, 5000);
  timer.unref?.();
}

export function record(accountId, { path, model, status, inputTokens = 0, outputTokens = 0, ms, error = null }) {
  const s = stats.get(accountId) ?? blank();
  s.requests++;
  if (status < 400) s.ok++; else s.errors++;
  s.inputTokens += inputTokens;
  s.outputTokens += outputTokens;
  s.lastUsedAt = Date.now();
  if (error) s.lastError = { at: Date.now(), message: String(error).slice(0, 200) };
  stats.set(accountId, s);
  recent.push({ ts: Date.now(), accountId, path, model: model ?? null, status, inputTokens, outputTokens, ms: ms ?? null, error: error ? String(error).slice(0, 200) : null });
  if (recent.length > RECENT_MAX) recent.shift();
  dirty = true;
}

export function accountStats(id) {
  return stats.get(id) ?? blank();
}

export function totals() {
  const t = blank();
  for (const s of stats.values()) {
    t.requests += s.requests; t.ok += s.ok; t.errors += s.errors;
    t.inputTokens += s.inputTokens; t.outputTokens += s.outputTokens;
  }
  return t;
}

export function recentRequests(limit = 50) {
  return recent.slice(-limit).reverse();
}

export function flush() {
  if (!dirty) return;
  try {
    writeFileSync(config.usageFile, JSON.stringify({ stats: Object.fromEntries(stats), recent }, null, 0));
    dirty = false;
  } catch (e) { log.warn('usage flush failed', { error: e.message }); }
}

export function stopUsage() {
  if (timer) clearInterval(timer);
  flush();
}
