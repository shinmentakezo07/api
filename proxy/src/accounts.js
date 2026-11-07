// accounts.js — multi-account store: .env + accounts.json, round-robin, failover order
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { config } from './config.js';
import { log } from './logger.js';

let accounts = [];      // {id, label, token, source:'env'|'ui', enabled, addedAt, sessionId}
let rrIndex = 0;        // round-robin cursor

// --- stable per-account session id so restarts reuse backend session slots ---
function sessionIdFor(token) {
  return `fpgw-${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
}

// --- tiny .env parser --------------------------------------------------------
function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

function tokensFromEnv(env) {
  const tokens = [];
  // FREEPI_ACCOUNTS = comma-separated tokens OR a JSON array
  if (env.FREEPI_ACCOUNTS) {
    const v = env.FREEPI_ACCOUNTS.trim();
    if (v.startsWith('[')) {
      try { for (const t of JSON.parse(v)) if (typeof t === 'string') tokens.push(t); } catch {}
    } else {
      for (const t of v.split(',')) if (t.trim()) tokens.push(t.trim());
    }
  }
  // FREEPI_TOKEN_1 .. FREEPI_TOKEN_20
  for (let i = 1; i <= 20; i++) {
    const t = env[`FREEPI_TOKEN_${i}`];
    if (t && !tokens.includes(t)) tokens.push(t);
  }
  return tokens;
}

// --- load ---------------------------------------------------------------------
export function initAccounts() {
  accounts = [];

  // 1) accounts from .env (read-only in the UI)
  let envTokens = [];
  try {
    if (existsSync(config.envFile)) {
      envTokens = tokensFromEnv(parseEnv(readFileSync(config.envFile, 'utf8')));
    }
  } catch (e) { log.warn('.env parse failed', { error: e.message }); }
  envTokens.forEach((token, i) => {
    accounts.push({ id: `env-${i + 1}`, label: `env-${i + 1}`, token, source: 'env', enabled: true, addedAt: Date.now(), sessionId: sessionIdFor(token) });
  });

  // 2) accounts added via the admin UI (persisted)
  try {
    if (existsSync(config.accountsFile)) {
      const saved = JSON.parse(readFileSync(config.accountsFile, 'utf8'));
      for (const a of saved ?? []) {
        if (!a.token) continue;
        accounts.push({ id: a.id ?? `ui-${randomUUID().slice(0, 8)}`, label: a.label ?? 'ui', token: a.token, source: 'ui', enabled: a.enabled !== false, addedAt: a.addedAt ?? Date.now(), sessionId: sessionIdFor(a.token) });
      }
    }
  } catch (e) { log.warn('accounts.json load failed', { error: e.message }); }

  // 3) fallback: the free-pi CLI's own credentials
  if (accounts.length === 0 && existsSync(config.credentialsFile)) {
    try {
      const token = JSON.parse(readFileSync(config.credentialsFile, 'utf8')).token;
      accounts.push({ id: 'default', label: 'cli-credentials', token, source: 'cli', enabled: true, addedAt: Date.now(), sessionId: sessionIdFor(token) });
    } catch {}
  }

  log.info('accounts loaded', { total: accounts.length, enabled: enabledAccounts().length, sources: accounts.map(a => a.source).join(',') });
}

function enabledAccounts() {
  return accounts.filter((a) => a.enabled);
}

/** Round-robin pick + failover order: chosen account first, then the rest. */
export function pickOrder() {
  const list = enabledAccounts();
  if (list.length === 0) throw new Error('no enabled accounts configured');
  const primary = rrIndex % list.length;
  rrIndex = (rrIndex + 1) % Math.max(list.length, 1);
  return [list[primary], ...list.filter((_, i) => i !== primary)];
}

export function primaryAccount() {
  const list = enabledAccounts();
  return list[0] ?? null;
}

export function listAccounts() {
  return accounts.map(({ token, ...rest }) => ({ ...rest, tokenMask: mask(token) }));
}

export function findAccount(id) {
  return accounts.find((a) => a.id === id) ?? null;
}

export function setEnabled(id, enabled) {
  const a = findAccount(id);
  if (!a) return false;
  a.enabled = !!enabled;
  if (a.source === 'ui') persist();
  return true;
}

export function addAccount(token, label) {
  if (accounts.some((a) => a.token === token)) return { error: 'this token is already registered' };
  const acc = {
    id: `ui-${randomUUID().slice(0, 8)}`,
    label: label || `ui-${accounts.length + 1}`,
    token, source: 'ui', enabled: true, addedAt: Date.now(), sessionId: sessionIdFor(token),
  };
  accounts.push(acc);
  persist();
  return { account: acc };
}

export function removeAccount(id) {
  const a = findAccount(id);
  if (!a || a.source !== 'ui') return false;
  accounts = accounts.filter((x) => x.id !== id);
  persist();
  return true;
}

function persist() {
  const ui = accounts.filter((a) => a.source === 'ui').map(({ id, label, token, enabled, addedAt }) => ({ id, label, token, enabled, addedAt }));
  try {
    writeFileSync(config.accountsFile, JSON.stringify(ui, null, 2), { mode: 0o600 });
  } catch (e) { log.warn('accounts persist failed', { error: e.message }); }
}

export function mask(token) {
  if (!token || token.length < 12) return '***';
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

export function accountCount() {
  return { total: accounts.length, enabled: enabledAccounts().length };
}
