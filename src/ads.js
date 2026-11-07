// ads.js — keep accounts "ad-compliant" like the real free-pi-cli does.
//
// The backend pauses accounts that aren't consuming ads (403 ads_required:
// "free-pi is free because ads pay for it"). The CLI satisfies this by:
//   1. GET /ads/next?slot=banner            (authed fetch, x-session-id)
//   2. if ad.source === "gravity" and imp_url is a trygravity https URL:
//        GET imp_url (impression pixel, 3s timeout, fire-and-forget)
//   3. POST /ads/impression { ad_id, click_token, imp_fired? }
//      (deduped per click_token; banner every 10 min = BANNER_REFRESH_MS,
//       inline every 5 turns — the gateway just runs the banner cycle)
//
// The x-gravity-context header is only sent when the CLI's gravity pixel SDK
// is running; FREEPI_NO_GRAVITY_PIXEL=1 is a supported CLI mode that omits
// it, so the backend accepts ad fetches without it.
import { config } from './config.js';
import { log } from './logger.js';

const IMP_TIMEOUT_MS = 3000;   // same as the CLI's IMP_TIMEOUT_MS
const BANNER_REFRESH_MS = 10 * 60 * 1000;

const state = new Map();   // accountId -> { lastClickToken, running, timer }
let started = false;

function authedHeaders(account, path) {
  const h = {
    authorization: `Bearer ${account.token}`,
    'content-type': 'application/json',
  };
  // CLI adds x-session-id on /ads/next* and /ads/impression
  if (account.sessionId && (path.startsWith('/ads/next') || path === '/ads/impression')) {
    h['x-session-id'] = account.sessionId;
  }
  return h;
}

function isGravityImpUrl(raw) {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && /(^|\.)trygravity\./.test(u.hostname);
  } catch { return false; }
}

/** One banner ad cycle for one account. Returns true if an impression was posted. */
export async function adCycle(account) {
  if (!account?.token) return false;
  const st = state.get(account.id) ?? {};
  if (st.running) return false;
  st.running = true;
  state.set(account.id, st);
  try {
    const res = await fetch(`${config.base}/ads/next?slot=banner`, {
      headers: authedHeaders(account, '/ads/next'),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 204 || !res.ok) {
      if (!res.ok) log.debug?.('ads/next non-ok', { account: account.id, status: res.status });
      return false;
    }
    const ad = await res.json().catch(() => null);
    if (!ad?.ad_id || !ad?.click_token) return false;

    let impFired = false;
    if (ad.source === 'gravity' && isGravityImpUrl(ad.imp_url)) {
      try {
        Promise.resolve(fetch(ad.imp_url, { method: 'GET', signal: AbortSignal.timeout(IMP_TIMEOUT_MS) }))
          .catch(() => {});
        impFired = true;
      } catch {}
    }

    if (st.lastClickToken !== ad.click_token) {
      st.lastClickToken = ad.click_token;
      const imp = await fetch(`${config.base}/ads/impression`, {
        method: 'POST',
        headers: authedHeaders(account, '/ads/impression'),
        body: JSON.stringify({ ad_id: ad.ad_id, click_token: ad.click_token, ...(impFired ? { imp_fired: true } : {}) }),
        signal: AbortSignal.timeout(10_000),
      });
      log.info('ad impression posted', { account: account.id, ad_id: ad.ad_id, source: ad.source, imp_fired: impFired, status: imp.status });
      return imp.ok;
    }
    return true; // already reported this ad
  } catch (e) {
    log.warn('ad cycle failed', { account: account.id, error: e.message });
    return false;
  } finally {
    st.running = false;
    state.set(account.id, st);
  }
}

/**
 * Reactive recovery: the backend answered ads_required — run a cycle now and
 * let the caller retry the request. Returns true if an impression was posted.
 */
export async function recoverFromAdsRequired(account) {
  log.warn('ads_required from upstream, running ad cycle for account', { account: account.id });
  return adCycle(account);
}

/** Heartbeat: one banner cycle per enabled account, staggered, every 10 min. */
export function startAdHeartbeat(getAccounts) {
  if (started) return;
  started = true;
  const runAll = (why) => {
    const accounts = (getAccounts() ?? []).filter((a) => a.enabled && a.token);
    accounts.forEach((a, i) => {
      setTimeout(() => adCycle(a), i * 1500); // stagger to avoid bursts
    });
    if (why) log.debug?.('ad heartbeat', { why, accounts: accounts.length });
  };
  setTimeout(() => runAll('startup'), 5000);
  setInterval(() => runAll('interval'), BANNER_REFRESH_MS).unref?.();
}
