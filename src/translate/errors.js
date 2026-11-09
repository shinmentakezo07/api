// translate/errors.js — turn an upstream error body into something a client can read.
//
// Upstreams answer errors with JSON like
//   { error: { message: "...", type: "invalid_request_error", code: "context_length_exceeded" } }
// The gateway used to pass that body through as a raw string, so clients
// received a JSON document *inside* the message field: the SDK showed the
// serialized JSON, and nothing could read error.code — which is exactly what
// a context-window failure needs, since retry logic keys off it.

/** Parse an upstream error body, or null when it is not JSON. */
function parseErrorBody(body) {
  if (body && typeof body === 'object') return body;
  if (typeof body !== 'string' || !body.trim()) return null;
  try {
    const v = JSON.parse(body);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Pull a human-readable message, the upstream error type, and the provider
 * error code out of whatever the upstream returned. Never throws: an
 * unparseable body falls back to its own text.
 */
export function readUpstreamError(body) {
  const parsed = parseErrorBody(body);
  if (!parsed) return { message: String(body ?? '').trim(), type: null, code: null };
  const err = parsed.error ?? parsed;
  const message =
    (typeof err.message === 'string' && err.message) ||
    (typeof parsed.message === 'string' && parsed.message) ||
    (typeof err.error === 'string' && err.error) ||
    '';
  return {
    message: message.trim(),
    type: typeof err.type === 'string' ? err.type : null,
    code: typeof err.code === 'string' ? err.code : (typeof err.type === 'string' ? err.type : null),
  };
}

/**
 * True when the upstream refused the request because it exceeded the model's
 * context window. Providers spell this differently, so match the code and the
 * wording rather than one exact string.
 */
export function isContextLengthError(body) {
  const { message, code } = readUpstreamError(body);
  if (code && /context_length_exceeded|string_above_max_length|too_many_tokens/i.test(code)) return true;
  return /maximum context length|context window|context length exceeded|too many tokens|reduce the length of the (messages|prompt)/i.test(message);
}

/** Readable text for a client, with the upstream's own message when present. */
export function formatUpstreamError(body) {
  const { message } = readUpstreamError(body);
  const text = message || String(body ?? '').trim();
  return text.slice(0, 500);
}
