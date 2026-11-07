// upstream.js — HTTP client for api.freepi.ai with the free-pi-cli fingerprint.
// Per-account headers, retry on 429/5xx, 401 credential refresh,
// auto /session/reset on concurrent_session.
import { config, CLIENT_VERSION } from './config.js';
import { log } from './logger.js';
import { readFileSync } from 'node:fs';

export class UpstreamError extends Error {
  constructor(status, body, message, attempts) {
    super(message ?? `upstream ${status}`);
    this.status = status;
    this.body = body;
    this.attempts = attempts ?? 1;
    this.code = body?.includes('concurrent_session') ? 'concurrent_session'
      : body?.includes('invalid_token') || status === 401 ? 'auth'
      : undefined;
  }
}

export function fingerprintHeaders(account, extra = {}, path = '') {
  const headers = {
    authorization: `Bearer ${account.token}`,
    'x-session-id': account.sessionId,
    'x-client-version': CLIENT_VERSION,
    'content-type': 'application/json',
    ...extra,
  };
  // Match the fingerprint of a real free-pi-cli chat completion (captured live):
  // the agent engine's OpenAI SDK adds a pi user-agent, stainless SDK headers,
  // and the tool-errors header; plain CLI fetches (e.g. /client-version) add
  // the cost-experiment header instead.
  if (path.includes('/chat/completions')) {
    headers['user-agent'] = PI_USER_AGENT;
    headers['accept'] = 'application/json';
    headers['x-freepi-tool-errors'] = 'v1:';
    headers['x-stainless-lang'] = 'js';
    headers['x-stainless-package-version'] = '7.19.0';
    headers['x-stainless-retry-count'] = '0';
    headers['x-stainless-timeout'] = '300';
    headers['x-stainless-os'] = 'Linux';
    headers['x-stainless-runtime'] = 'node';
    headers['x-stainless-runtime-version'] = process.version;
    headers['x-stainless-arch'] = process.arch;
  }
  if (path.includes('/client-version')) {
    headers['x-freepi-cost-exp'] = '1';
  }
  return headers;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

// User-Agent the CLI's agent engine sends on chat completions (captured from a
// real `npx free-pi-cli@latest` session): pi/<engine> (<platform>; node/<ver>; <arch>)
const PI_ENGINE_VERSION = config.piEngineVersion ?? '1.5.0';
const PI_USER_AGENT = `pi/${PI_ENGINE_VERSION} (${process.platform}; node/${process.version}; ${process.arch})`;

// Fields some clients send that upstream models may not support (reasoning controls).
const REASONING_FIELDS = [
  'reasoning_effort', 'reasoning', 'thinking', 'thinking_budget',
  'enable_thinking', 'include_reasoning', 'reasoning_content',
  'chat_template_kwargs',
];

/** Strip reasoning-control fields from an OpenAI chat body (JSON string/Buffer in, out). */
function stripReasoningControls(rawBody) {
  try {
    const raw = Buffer.isBuffer(rawBody) ? rawBody.toString() : rawBody;
    const body = JSON.parse(raw);
    const stripped = [];
    for (const k of REASONING_FIELDS) {
      if (k in body) { delete body[k]; stripped.push(k); }
    }
    if (!stripped.length) return { body: rawBody, stripped };
    log.info('stripped unsupported reasoning controls', { fields: stripped });
    return { body: JSON.stringify(body), stripped };
  } catch {
    return { body: rawBody, stripped: [] };
  }
}

async function once(path, { account, method = 'GET', body, headers = {}, signal } = {}) {
  const url = `${config.base}${path}`;
  return fetch(url, {
    method,
    headers: fingerprintHeaders(account, headers, path),
    body: body === undefined || method === 'GET' ? undefined : body,
    signal: signal ?? AbortSignal.timeout(config.requestTimeoutMs),
    redirect: 'manual',
  });
}

/**
 * Fetch upstream as `account`. Retry policy (nothing has been streamed yet):
 *  - concurrent_session -> POST /session/reset for this account, retry at once
 *  - 401 -> reload credentials file (for the cli-source account), retry
 *  - 429/5xx -> backoff retry
 */
export async function upstream(path, opts = {}) {
  const { retries = config.retry.maxAttempts, account } = opts;
  if (!account?.token) throw new Error('upstream() requires an account');
  let reloadedCreds = false;
  let resets = 0;
  let reasoningStripped = false;

  // Proactively drop reasoning controls on chat bodies (some upstream models reject them).
  if (opts.body && path.includes('/chat/completions')) {
    const { body, stripped } = stripReasoningControls(opts.body);
    if (stripped.length) { opts = { ...opts, body }; reasoningStripped = true; }
  }

  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await once(path, opts);
    } catch (err) {
      if (attempt < retries && err.name !== 'AbortError') {
        const wait = config.retry.backoffMs * 2 ** (attempt - 1);
        log.warn('upstream network error, retrying', { path, account: account.id, attempt, wait, error: err.message });
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw err;
    }

    if (res.ok) { opts.onAttempt?.(attempt); return res; }

    const errText = await res.text().catch(() => '');

    if (errText.includes('concurrent_session') && resets < config.resetOnConcurrent.maxResets) {
      resets++;
      log.warn('concurrent_session limit hit, resetting sessions for account', { path, account: account.id, reset: resets });
      const released = await resetOtherSessions(account.token);
      log.info('session reset done', { account: account.id, released });
      if (config.resetOnConcurrent.settleMs > 0) {
        await new Promise((r) => setTimeout(r, config.resetOnConcurrent.settleMs));
      }
      attempt--;
      continue;
    }

    if (res.status === 401 && !reloadedCreds && account.source === 'cli') {
      reloadedCreds = true;
      log.warn('upstream 401, reloading cli credentials');
      try { const { forceReload } = await import('./credentials.js'); forceReload(); account.token = getTokenSafe(); } catch {}
      continue;
    }

    // Upstream rejected reasoning controls we didn't catch up front -> strip and retry once.
    if (res.status === 400 && /reasoning|thinking/i.test(errText) && !reasoningStripped && opts.body) {
      const { body } = stripReasoningControls(opts.body);
      if (body !== (Buffer.isBuffer(opts.body) ? opts.body.toString() : opts.body)) {
        log.warn('upstream 400 reasoning controls, retrying without them', { path, account: account.id });
        opts = { ...opts, body };
        reasoningStripped = true;
        continue;
      }
    }

    if (RETRYABLE.has(res.status) && attempt < retries) {
      const wait = config.retry.backoffMs * 2 ** (attempt - 1);
      log.warn('upstream retryable status, retrying', { path, account: account.id, status: res.status, attempt, wait });
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new UpstreamError(res.status, errText, undefined, attempt);
  }
}

function getTokenSafe() {
  try {
    return JSON.parse(readFileSync(config.credentialsFile, 'utf8')).token;
  } catch { return null; }
}

/** POST /session/reset — the endpoint behind the CLI's /close-other-session. */
export async function resetOtherSessions(token) {
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(`${config.base}/session/reset`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        log.warn('session/reset non-ok', { status: res.status });
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      const data = await res.json().catch(() => ({}));
      return data.released ?? false;
    } catch (e) {
      log.warn('session/reset failed', { error: e.message });
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}
