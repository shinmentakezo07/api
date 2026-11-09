// upstream.js — HTTP client for api.freepi.ai with the free-pi-cli fingerprint.
// Per-account headers, retry on 429/5xx, 401 credential refresh,
// auto /session/reset on concurrent_session.
import { config, CLIENT_VERSION } from './config.js';
import { log } from './logger.js';
import { sessionIdFor, freshSessionId } from './session.js';
import { readFileSync } from 'node:fs';

/** Error codes free-pi raises (from the CLI's mapErrorCode); used for text fallback. */
const KNOWN_CODES = [
  'concurrent_session', 'concurrent', 'ads_required', 'context_too_long',
  'context_ceiling', 'context_too_long_for_fallback', 'daily_cap', 'hourly_ceiling',
  'rolling_cap', 'global_cap', 'queue_wait', 'upgrade_required', 'consent_required',
  'guest_allowance', 'guest_unavailable', 'guest_login_required', 'region_unavailable',
  'model_requires_credits', 'premium_allowance', 'model_at_capacity',
  'reward_required', 'account_review', 'invalid_token',
];

export class UpstreamError extends Error {
  constructor(status, body, message, attempts, preParsed) {
    // Parse the structured error envelope exactly once. free-pi reports limit
    // metadata in the BODY (`limit`, `retry_after_seconds`, `clears_at`,
    // `remaining_credits_today`, `lane`) — not in a Retry-After header.
    const env = preParsed ?? parseEnvelope(body);
    super(message ?? env?.message ?? `upstream ${status}`);
    this.status = status;
    this.body = body;
    this.attempts = attempts ?? 1;
    this.envelope = env;
    // bodies that aren't clean JSON still carry the code as text — keep the
    // fallback for every known code, not just concurrent_session
    this.code = env?.code
      ?? KNOWN_CODES.find((c) => body?.includes(c));
    if (status === 401 || body?.includes('invalid_token')) this.code = 'auth';
    this.retryAfterMs = retryHint(env);
  }
}

/** Parse a free-pi error body into its envelope, or null when it isn't JSON. */
export function parseEnvelope(body) {
  let env;
  try { env = JSON.parse(body); } catch { return null; }
  if (!env || typeof env !== 'object' || Array.isArray(env)) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return {
    code: typeof (env.code ?? env.error?.code) === 'string' ? (env.code ?? env.error.code) : undefined,
    message: typeof (env.message ?? env.error?.message) === 'string' ? (env.message ?? env.error.message) : undefined,
    limit: typeof env.limit === 'string' ? env.limit : undefined,
    retry_after_seconds: num(env.retry_after_seconds),
    clears_at: typeof env.clears_at === 'string' ? env.clears_at : undefined,
    remaining_credits_today: num(env.remaining_credits_today),
    lane: env.lane === 'slow' ? 'slow' : undefined,
    hourly_ceiling: num(env.hourly_ceiling),
  };
}

/** Envelope `retry_after_seconds` in ms, or null. */
function retryHint(env) {
  const v = env?.retry_after_seconds;
  return typeof v === 'number' && v > 0 ? v * 1000 : null;
}

export function fingerprintHeaders(account, extra = {}, path = '', sessionId = account.sessionId) {
  const headers = {
    authorization: `Bearer ${account.token}`,
    'x-session-id': sessionId,
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

/** Backoff with ±50% jitter, capped. */
const jitter = (ms) => Math.min(Math.round(ms * (0.5 + Math.random())), 30_000);

/** Sleep that wakes early (rejecting with AbortError) when `signal` fires. */
function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
  });
}

/** Client signal (if any) + the per-request hard timeout. */
const mergedSignal = (signal) => signal
  ? AbortSignal.any([signal, AbortSignal.timeout(config.requestTimeoutMs)])
  : AbortSignal.timeout(config.requestTimeoutMs);

// User-Agent the CLI's agent engine sends on chat completions (captured from a
// real `npx free-pi-cli@latest` session): pi/<engine> (<platform>; node/<ver>; <arch>)
const PI_ENGINE_VERSION = config.piEngineVersion ?? '1.5.0';
const PI_USER_AGENT = `pi/${PI_ENGINE_VERSION} (${process.platform}; node/${process.version}; ${process.arch})`;

// Reasoning controls are normalized in reasoning.js: client intent (Anthropic
// thinking, enable_thinking, chat_template_kwargs, OpenAI reasoning) is mapped
// to `reasoning_effort`, which upstream accepts and answers with reasoning_content.
import { normalizeOpenAIReasoning, stripAllReasoning } from './reasoning.js';

function parseBody(rawBody) {
  try {
    const raw = Buffer.isBuffer(rawBody) ? rawBody.toString() : rawBody;
    return { raw, parsed: JSON.parse(raw) };
  } catch {
    return { raw: rawBody, parsed: null };
  }
}

async function once(path, { account, sessionId, method = 'GET', body, headers = {}, signal } = {}) {
  const url = `${config.base}${path}`;
  return fetch(url, {
    method,
    headers: fingerprintHeaders(account, headers, path, sessionId),
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
  let adCycles = 0;
  let timeouts = 0;
  let rotates = 0;
  const maxTimeoutRetries = config.retry.timeoutRetries ?? 1;
  const maxRotates = config.concurrentRotateRetries ?? 2;
  // free-pi runs ONE request at a time per x-session-id (429 'concurrent'), so
  // every attempt gets its own id instead of one shared per account.
  let sessionId = opts.sessionId ?? sessionIdFor(account, opts.conversationKey ?? '');
  opts.onSession?.(sessionId);

  // Normalize reasoning controls on chat bodies: client intent -> reasoning_effort.
  if (opts.body && path.includes('/chat/completions')) {
    const { raw, parsed } = parseBody(opts.body);
    if (parsed) {
      const { dropped, effort } = normalizeOpenAIReasoning(parsed);
      if (dropped.length || effort) {
        if (dropped.length) log.info('normalized reasoning controls', { fields: dropped, effort });
        opts = { ...opts, body: JSON.stringify(parsed) };
        reasoningStripped = dropped.length > 0;
      }
    } else if (raw !== opts.body) {
      opts = { ...opts, body: raw };
    }
  }

  for (let attempt = 1; ; attempt++) {
    // client cancellation is never retried
    if (opts.signal?.aborted) {
      throw new UpstreamError(499, '', 'client aborted', attempt);
    }
    opts.onAttempt?.(1); // every attempt counts, including retries
    let res;
    try {
      res = await once(path, { ...opts, sessionId, signal: mergedSignal(opts.signal) });
    } catch (err) {
      if (opts.signal?.aborted) throw err; // client gone — do not retry
      const isTimeout = err.name === 'TimeoutError';
      const timeoutBudgetLeft = !isTimeout || timeouts < maxTimeoutRetries;
      if (attempt < retries && timeoutBudgetLeft) {
        if (isTimeout) timeouts++;
        const wait = jitter(config.retry.backoffMs * 2 ** (attempt - 1));
        log.warn('upstream network error, retrying', { path, account: account.id, attempt, wait, timeout: isTimeout, error: err.message });
        await sleep(wait, opts.signal);
        continue;
      }
      // a timeout is a distinct outcome for the client: 504, not a vague 502
      if (isTimeout) {
        throw new UpstreamError(504, '', `upstream timed out after ${config.requestTimeoutMs}ms (${path})`, attempt);
      }
      throw err;
    }

    if (res.ok) return res;

    const errText = await res.text().catch(() => '');
    const envelope = parseEnvelope(errText);   // single parse, reused below

    const concurrentCode = envelope?.code
      ?? (errText.includes('concurrent_session') ? 'concurrent_session'
        : errText.includes('concurrent') ? 'concurrent' : undefined);

    // 429 'concurrent' means THIS session id already has a request in flight
    // ("one request at a time"). Mint a fresh id and retry immediately: no
    // backoff, no failover, and no /session/reset (which would kill the other
    // client's stream, since reset closes every other session of the token).
    if (res.status === 429 && concurrentCode === 'concurrent' && rotates < maxRotates) {
      rotates++;
      const previous = sessionId;
      sessionId = freshSessionId();
      opts.onSession?.(sessionId);
      log.warn('upstream session busy, rotating session id', {
        path, account: account.id, previous, next: sessionId, rotate: rotates,
      });
      attempt--;
      continue;
    }

    if (concurrentCode === 'concurrent_session' && resets < config.resetOnConcurrent.maxResets) {
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

    // Backend pauses accounts that aren't consuming ads -> run the CLI's ad
    // cycle (fetch ad, fire impression) and retry, same spirit as session reset.
    if (errText.includes('ads_required') && adCycles < 2) {
      adCycles++;
      const { recoverFromAdsRequired } = await import('./ads.js');
      const posted = await recoverFromAdsRequired(account);
      log.info('ads_required recovery', { path, account: account.id, posted });
      attempt--;
      continue;
    }

    if (res.status === 401 && !reloadedCreds && account.source === 'cli') {
      reloadedCreds = true;
      log.warn('upstream 401, reloading cli credentials');
      try { const { forceReload } = await import('./credentials.js'); forceReload(); account.token = getTokenSafe(); } catch {}
      continue;
    }

    // Upstream still rejected reasoning controls -> strip them entirely and retry once.
    if (res.status === 400 && /reasoning|thinking/i.test(errText) && !reasoningStripped && opts.body) {
      const { parsed } = parseBody(opts.body);
      if (parsed) {
        const dropped = stripAllReasoning(parsed);
        if (dropped.length) {
          log.warn('upstream 400 reasoning controls, retrying without them', { path, account: account.id, dropped });
          opts = { ...opts, body: JSON.stringify(parsed) };
          reasoningStripped = true;
          continue;
        }
      }
    }

    // honor Retry-After header, else the body's retry_after_seconds (what the
    // free-pi CLI itself uses), else exponential backoff
    if (res.status === 429 && attempt < retries) {
      const hinted = retryHint(envelope);
      const ra = Number(res.headers.get('retry-after'));
      const fromHeader = Number.isFinite(ra) && ra > 0 ? ra * 1000 : null;
      const wait = Math.min(fromHeader ?? hinted ?? jitter(config.retry.backoffMs * 2 ** (attempt - 1)), 30_000);
      log.warn('upstream 429, backing off', {
        path, account: account.id, attempt, wait,
        retryAfter: fromHeader != null ? fromHeader / 1000 : undefined,
        bodyHint: hinted != null ? hinted / 1000 : undefined,
      });
      await sleep(wait, opts.signal);
      continue;
    }

    if (RETRYABLE.has(res.status) && attempt < retries) {
      const wait = jitter(config.retry.backoffMs * 2 ** (attempt - 1));
      log.warn('upstream retryable status, retrying', { path, account: account.id, status: res.status, attempt, wait });
      await sleep(wait, opts.signal);
      continue;
    }
    throw new UpstreamError(res.status, errText, undefined, attempt, envelope);
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
