// version.js — the client version the gateway reports upstream (x-client-version).
//
// Upstream gates on it. A stale value is refused outright, before the request
// is even looked at:
//
//   426 {"code":"upgrade_required",
//        "message":"your free-pi-cli is below the required minimum (0.6.19);
//                   update with: npx free-pi-cli@latest",
//        "error":{"code":"upgrade_required","type":"free_pi_error"}}
//
// so a hard-coded version expires the day upstream moves the minimum. The
// unauthenticated GET /client-version — the same call the CLI's own update
// check makes — publishes the details:
//
//   { "min": "0.6.19", "latest": "0.6.19",
//     "min_desktop_version": "0.0.0", "latest_desktop_version": "0.3.4", ... }
//
// The gateway reads them, sends the newest release it knows about, re-checks on
// a timer, and adopts a newer minimum the moment a 426 names one (upstream.js
// then retries, so the client never sees the 426).
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';

/** Last resort when neither config, a local install, nor upstream can be read. */
const FALLBACK_VERSION = '0.6.19';

/** '1.2.3', 'v1.2.3', '1.2.3-beta.1' -> [1,2,3]; anything else -> null. */
export function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isVersion(value) {
  return parseVersion(value) !== null;
}

/** -1 | 0 | 1; unparseable operands compare equal (never throw on upstream junk). */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/**
 * Pull the required version out of a 426 body (or the plain text of one):
 *   "your free-pi-cli is below the required minimum (0.6.19); update with: ..."
 * Also understands a catalog payload's "min": "0.6.19" field.
 */
export function requiredVersionFrom(body) {
  if (!body) return null;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const m = text.match(/minimum\s*\((\d+\.\d+\.\d+)\)/i) ?? text.match(/"min"\s*:\s*"(\d+\.\d+\.\d+)"/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
const state = {
  version: null,   // what goes in x-client-version
  source: null,    // 'config' | 'installed' | 'fallback' | 'client-version' | 'upgrade-required'
  min: null,       // upstream's required minimum, as last reported
  latest: null,    // upstream's current release, as last reported
  detail: null,    // the rest of the /client-version version detail
  checkedAt: 0,    // last successful (or attempted) refresh
  error: null,     // last refresh failure, for /health
};

/**
 * Best local guess at the CLI version, used only until /client-version answers:
 * the CLI's own update check leaves the newest version it saw in
 * ~/.free-pi/agent/last-seen-version, and a local install has a package.json.
 */
function installedVersion() {
  try {
    const v = readFileSync(join(homedir(), '.free-pi', 'agent', 'last-seen-version'), 'utf8').trim();
    if (isVersion(v)) return v;
  } catch {}
  for (const file of candidatePackageFiles()) {
    try {
      const v = JSON.parse(readFileSync(file, 'utf8')).version;
      if (isVersion(v)) return v;
    } catch {}
  }
  return null;
}

function candidatePackageFiles() {
  const npx = join(homedir(), '.npm', '_npx');
  const out = [
    join(homedir(), '.npm-global', 'lib', 'node_modules', 'free-pi-cli', 'package.json'),
    join(homedir(), '.local', 'lib', 'node_modules', 'free-pi-cli', 'package.json'),
    '/usr/local/lib/node_modules/free-pi-cli/package.json',
    '/usr/lib/node_modules/free-pi-cli/package.json',
  ];
  try {
    for (const dir of readdirSync(npx)) out.push(join(npx, dir, 'node_modules', 'free-pi-cli', 'package.json'));
  } catch {}
  return out;
}

/** Resolve the initial version without touching the network. */
export function initVersion() {
  if (state.version) return state.version;
  const pinned = config.cliVersion;
  if (isVersion(pinned)) {
    state.version = pinned;
    state.source = 'config';
  } else {
    const local = installedVersion();
    state.version = local ?? FALLBACK_VERSION;
    state.source = local ? 'installed' : 'fallback';
  }
  return state.version;
}

/** The value to send as x-client-version (sync: safe on every request). */
export function clientVersion() {
  return state.version ?? initVersion();
}

export function versionInfo() {
  return {
    version: clientVersion(),
    source: state.source,
    min: state.min,
    latest: state.latest,
    detail: state.detail,
    checkedAt: state.checkedAt || null,
    error: state.error,
  };
}

/**
 * Adopt the version detail from a /client-version payload (or from the 426
 * message). The effective version is the newest of the current one, `min` and
 * `latest`: it can move up but never down, so a later refresh cannot undo a
 * bump a 426 already forced.
 */
export function applyVersionInfo(data, source = 'client-version') {
  const min = isVersion(data?.min) ? data.min : null;
  const latest = isVersion(data?.latest) ? data.latest : null;
  state.checkedAt = Date.now();
  state.error = null;
  if (min) state.min = min;
  if (latest) state.latest = latest;
  if (data && typeof data === 'object') {
    state.detail = {
      min: data.min ?? null,
      latest: data.latest ?? null,
      minDesktop: data.min_desktop_version ?? null,
      latestDesktop: data.latest_desktop_version ?? null,
    };
  }
  // Use `latest` — the release the CLI itself would install. `min` is only a
  // floor (and is used when upstream omits `latest`), so the value can only
  // move up and a refresh never undoes a bump a 426 already forced.
  let next = state.version ?? clientVersion();
  for (const v of [latest, min]) if (v && compareVersions(v, next) > 0) next = v;
  if (next !== state.version) {
    log.info('client version updated from upstream', { from: state.version, to: next, source });
    state.version = next;
    state.source = source;
  } else if (source !== 'config' && (state.source === 'installed' || state.source === 'fallback')) {
    // same version, now confirmed by upstream: a local guess is no longer the story
    state.source = source;
  }
  if (min && compareVersions(next, min) < 0) {
    log.warn('client version below the upstream minimum', { version: next, min });
  }
  return state.version;
}

/** Adopt a minimum named by a 426 upgrade_required. Returns true when it moved. */
export function noteRequiredVersion(version) {
  if (!isVersion(version)) return false;
  if (compareVersions(version, clientVersion()) <= 0) return false;
  log.warn('upstream requires a newer client version', { from: state.version, to: version });
  state.version = version;
  state.source = 'upgrade-required';
  return true;
}

/**
 * Read /client-version (unauthenticated, like the CLI's update check).
 * `attempts` > 1 retries a failed fetch with a short backoff — used at startup,
 * so a restart always ends up on the current version instead of a local guess.
 */
export async function refreshVersion({
  timeoutMs = config.versionFetchTimeoutMs ?? 4_000,
  attempts = 1,
  backoffMs = 400,
} = {}) {
  for (let i = 1; ; i++) {
    const ok = await refreshVersionOnce(timeoutMs);
    if (ok || i >= attempts) return clientVersion();
    await new Promise((r) => setTimeout(r, backoffMs * i));
  }
}

/** One /client-version fetch. Returns true when the payload was applied. */
async function refreshVersionOnce(timeoutMs) {
  try {
    const res = await fetch(`${config.base}/client-version`, {
      headers: {
        'x-client-version': clientVersion(),
        'x-freepi-cost-exp': '1',
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      state.checkedAt = Date.now();
      state.error = `client-version ${res.status}`;
      log.debug('client version refresh failed', { status: res.status });
      return false;
    }
    const data = await res.json();
    applyVersionInfo(data, 'client-version');
    log.debug('client version refreshed', { version: state.version, min: state.min, latest: state.latest });
    return true;
  } catch (e) {
    state.checkedAt = Date.now();
    state.error = e.message;
    log.debug('client version refresh failed', { error: e.message });
    return false;
  }
}

let inflight = null;

/** Refresh in the background when the last check is older than versionCheckMs. */
export function ensureFreshVersion() {
  const ttl = Number(config.versionCheckMs) > 0 ? Number(config.versionCheckMs) : 10 * 60 * 1000;
  if (Date.now() - state.checkedAt < ttl) return inflight ?? Promise.resolve(clientVersion());
  if (!inflight) {
    inflight = refreshVersion().finally(() => { inflight = null; });
  }
  return inflight;
}
