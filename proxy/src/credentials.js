// credentials.js — loads and refreshes the free-pi JWT
import { readFileSync, statSync, existsSync } from 'node:fs';
import { config } from './config.js';
import { log } from './logger.js';

let jwt = null;
let loadedAt = 0;

function load() {
  if (!existsSync(config.credentialsFile)) {
    throw new Error(`no credentials at ${config.credentialsFile} — run free-pi-cli once to sign in`);
  }
  const parsed = JSON.parse(readFileSync(config.credentialsFile, 'utf8'));
  if (!parsed.token || typeof parsed.token !== 'string') throw new Error('credentials.json has no token');
  jwt = parsed.token;
  loadedAt = Date.now();
  log.debug('credentials loaded', { file: config.credentialsFile, len: jwt.length });
  return jwt;
}

export function initCredentials() {
  load();
}

export function getToken() {
  const stale = Date.now() - loadedAt > config.credRefreshMs;
  if (jwt === null || stale) {
    try { load(); } catch (e) {
      if (jwt === null) throw e;          // first load must succeed
      log.warn('credential refresh failed, keeping previous token', { error: e.message });
    }
  }
  return jwt;
}

export function forceReload() { load(); }

export function credentialMtime() {
  try { return statSync(config.credentialsFile).mtimeMs; } catch { return 0; }
}
