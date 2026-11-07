// catalog.js — model catalog from GET /client-version, cached; uses any account
import { upstream } from './upstream.js';
import { config } from './config.js';
import { log } from './logger.js';

let cache = { models: [], fetchedAt: 0 };

export async function getCatalog(account) {
  if (Date.now() - cache.fetchedAt < config.catalogTtlMs) return cache.models;
  if (!account) return cache.models;
  try {
    const res = await upstream('/client-version', { account });
    const data = await res.json();
    cache = { models: Array.isArray(data.models) ? data.models : [], fetchedAt: Date.now() };
    log.debug('catalog refreshed', { count: cache.models.length });
  } catch (e) {
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
