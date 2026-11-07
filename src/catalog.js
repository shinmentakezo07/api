// catalog.js — model catalog from GET /client-version, cached; uses any account
import { config, CLIENT_VERSION } from './config.js';
import { log } from './logger.js';

let cache = { models: [], fetchedAt: 0 };

/**
 * The CLI fetches /client-version without auth (see update-check in
 * free-pi-cli), so the gateway does too: no account slot is consumed by
 * /v1/models, and the catalog refreshes even with zero accounts configured.
 */
async function fetchCatalog() {
  const res = await fetch(`${config.base}/client-version`, {
    headers: { 'x-client-version': CLIENT_VERSION, accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`client-version ${res.status}`);
  return res.json();
}

export async function getCatalog(account) {
  if (Date.now() - cache.fetchedAt < config.catalogTtlMs) return cache.models;
  try {
    const data = await fetchCatalog();
    cache = { models: Array.isArray(data.models) ? data.models : [], fetchedAt: Date.now() };
    log.debug('catalog refreshed', { count: cache.models.length });
  } catch (e) {
    // fall back to an authenticated fetch only if the anonymous one is refused
    if (account) {
      try {
        const { upstream } = await import('./upstream.js');
        const res = await upstream('/client-version', { account });
        const data = await res.json();
        cache = { models: Array.isArray(data.models) ? data.models : [], fetchedAt: Date.now() };
        log.debug('catalog refreshed (authenticated fallback)', { count: cache.models.length });
        return cache.models;
      } catch {}
    }
    cache.fetchedAt = Date.now();
    log.warn('catalog refresh failed', { error: e.message });
  }
  return cache.models;
}

export function resolveModel(requested) {
  const models = cache.models;
  if (!requested) return config.defaultModel;
  if (models.length === 0) {
    return /^(deepseek\/|z-ai\/|particle)/.test(requested) ? requested : config.defaultModel;
  }
  const hit = models.some((m) => m.id === requested || m.stats_id === requested);
  return hit ? requested : config.defaultModel;
}

export function defaultModel() {
  return config.defaultModel;
}
