// session.js — upstream session identity.
//
// free-pi enforces ONE in-flight request per `x-session-id` (429 `concurrent`,
// "one request at a time") while allowing many session ids to run in parallel.
// A single id per account therefore serialises every client behind every other
// client, and under concurrency the gateway spent its retries on 429s and
// failed over — which is what looked like "the proxy reuses an old session".
//
// The upstream is stateless: the conversation lives in the messages the client
// replays, not in the session. So a session id only has to be (a) unique per
// concurrent request and (b) cheap to mint.
import { createHash, randomUUID } from 'node:crypto';
import { config } from './config.js';

const digest = (s, n = 16) => createHash('sha256').update(s).digest('hex').slice(0, n);

/** Flatten Anthropic/OpenAI content into text for hashing. */
function textOfContent(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((b) => (typeof b === 'string' ? b : (b?.text ?? b?.content ?? ''))).join('\n');
  }
  return c == null ? '' : JSON.stringify(c);
}

/**
 * Stable key for one client conversation: the system prompt plus the first
 * turn. Clients replay the whole history each request, so the head of the
 * conversation stays identical across turns while two conversations differ.
 * Returns '' when there is nothing to key on.
 */
export function conversationKeyOf(body) {
  if (!body || typeof body !== 'object') return '';
  const sys = textOfContent(body.system);
  const first = Array.isArray(body.messages) ? body.messages[0] : undefined;
  const head = first ? `${first.role ?? ''}:${textOfContent(first.content)}` : '';
  const raw = `${sys}\u0000${head}`;
  return raw.length > 8 ? digest(raw, 12) : '';
}

/** A never-before-used session id. */
export function freshSessionId() {
  return `fpgw-r-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/**
 * Session id for one upstream attempt.
 *  - 'account'      one stable id per account (legacy; serialises clients)
 *  - 'request'      a fresh id per request (default; always fresh)
 *  - 'conversation' stable per conversation, so turns of one chat share a slot
 */
export function sessionIdFor(account, conversationKey = '') {
  const strategy = config.sessionStrategy ?? 'request';
  if (strategy === 'account') return account.sessionId;
  if (strategy === 'conversation' && conversationKey) {
    return `fpgw-c-${digest(`${account.id}\u0000${conversationKey}`, 16)}`;
  }
  return freshSessionId();
}
