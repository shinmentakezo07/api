// translate/stop.js — single source of truth for OpenAI -> Anthropic stop reasons.
//
// Both the streaming and non-streaming translators must agree; keeping two
// copies let them drift apart (the streaming one silently lacked
// 'stop_sequence'). Anthropic has no stop reason for a filtered response, so
// content_filter maps to refusal: the closest available meaning, and distinct
// from end_turn so a filtered answer is not indistinguishable from a clean one.
export function mapStopReason(finishReason) {
  switch (finishReason) {
    case 'tool_calls':
    case 'function_call':      // legacy OpenAI shape for the same thing
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

/**
 * True when the upstream ended the response for a reason the client should be
 * able to detect, rather than a natural stop. Callers use this to surface a
 * warning instead of silently presenting a filtered response as complete.
 */
export const isFiltered = (finishReason) => finishReason === 'content_filter';
