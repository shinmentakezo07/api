// translate/response.js — OpenAI Chat Completions response -> Anthropic Messages
import { randomUUID } from 'node:crypto';

export const stopReason = (finishReason) =>
  finishReason === 'tool_calls' ? 'tool_use'
  : finishReason === 'length' ? 'max_tokens'
  : finishReason === 'stop_sequence' ? 'stop_sequence'
  : 'end_turn';

export function openAIToAnthropic(oai, requestModel) {
  const choice = oai.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content = [];

  // upstream reasoning (when the client asked for it) -> Anthropic thinking block
  if (msg.reasoning_content) content.push({ type: 'thinking', thinking: msg.reasoning_content });

  if (msg.content) content.push({ type: 'text', text: msg.content });

  for (const tc of msg.tool_calls ?? []) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = {}; }
    content.push({
      type: 'tool_use',
      id: tc.id ?? `toolu_${randomUUID().slice(0, 8)}`,
      name: tc.function?.name ?? 'unknown',
      input,
    });
  }

  return {
    id: `msg_${oai.id ?? randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: requestModel ?? oai.model ?? 'unknown',
    content,
    stop_reason: stopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: oai.usage?.prompt_tokens ?? 0,
      output_tokens: oai.usage?.completion_tokens ?? 0,
    },
  };
}

/** Map an upstream error into the right error shape for the client. */
export function errorBody(isAnthropicRoute, status, detail) {
  if (isAnthropicRoute) {
    const type = status === 429 ? 'rate_limit_error' : status === 401 ? 'authentication_error' : 'api_error';
    return { type: 'error', error: { type, message: String(detail).slice(0, 500) } };
  }
  return { error: { message: String(detail).slice(0, 500), type: 'upstream_error', code: status } };
}
