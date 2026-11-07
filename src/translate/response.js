// translate/response.js — OpenAI Chat Completions response -> Anthropic Messages
import { randomUUID } from 'node:crypto';

export const stopReason = (finishReason) =>
  finishReason === 'tool_calls' ? 'tool_use'
  : finishReason === 'length' ? 'max_tokens'
  : finishReason === 'stop_sequence' ? 'stop_sequence'
  : 'end_turn';

/** Upstream returned tool arguments that are not valid JSON — refuse, don't guess. */
export class MalformedToolCallError extends Error {
  constructor(toolName, args) {
    super(`upstream returned malformed arguments for tool "${toolName}": ${String(args).slice(0, 120)}`);
    this.status = 502;
  }
}

export function openAIToAnthropic(oai, requestModel, opts = {}) {
  const choice = oai.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content = [];

  if (msg.reasoning_content) content.push({ type: 'thinking', thinking: msg.reasoning_content });

  if (msg.content) content.push({ type: 'text', text: msg.content });

  for (const tc of msg.tool_calls ?? []) {
    const rawArgs = tc.function?.arguments || '{}';
    let input;
    try { input = JSON.parse(rawArgs); }
    catch { throw new MalformedToolCallError(tc.function?.name ?? 'unknown', rawArgs); }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new MalformedToolCallError(tc.function?.name ?? 'unknown', rawArgs);
    }
    content.push({
      type: 'tool_use',
      id: tc.id ?? `toolu_${randomUUID().slice(0, 8)}`,
      name: tc.function?.name ?? 'unknown',
      input,
    });
  }

  const finish = choice.finish_reason;
  let stopReasonValue = stopReason(finish);
  let stopSequence = null;
  // stop sequences are enforced locally (never sent upstream): truncate the
  // text at the first match and report it, Anthropic-style
  if (opts.stopSequences?.length && typeof msg.content === 'string') {
    for (const seq of opts.stopSequences) {
      if (!seq) continue;
      const idx = msg.content.indexOf(seq);
      if (idx !== -1) {
        const tb = content.find((b) => b.type === 'text');
        if (tb) tb.text = msg.content.slice(0, idx);
        stopReasonValue = 'stop_sequence';
        stopSequence = seq;
        break;
      }
    }
  }

  const details = oai.usage?.prompt_tokens_details ?? {};
  return {
    id: `msg_${oai.id ?? randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: requestModel ?? oai.model ?? 'unknown',
    content,
    stop_reason: stopReasonValue,
    stop_sequence: stopSequence,
    usage: {
      input_tokens: oai.usage?.prompt_tokens ?? 0,
      output_tokens: oai.usage?.completion_tokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: details.cached_tokens ?? 0,
    },
  };
}

/** Map an upstream error into the right error shape for the client. */
export function errorBody(isAnthropicRoute, status, detail) {
  if (isAnthropicRoute) {
    const type = status === 429 ? 'rate_limit_error' : status === 401 ? 'authentication_error' : status === 400 ? 'invalid_request_error' : 'api_error';
    return { type: 'error', error: { type, message: String(detail).slice(0, 500) } };
  }
  return { error: { message: String(detail).slice(0, 500), type: 'upstream_error', code: status } };
}
