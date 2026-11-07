// reasoning.js — normalize client reasoning intent into what upstream accepts.
//
// Upstream (deepseek/glm families, probed live) accepts `reasoning_effort:
// low|medium|high` and returns `reasoning_content` in the response. Other
// client formats — Anthropic `thinking:{type,budget_tokens}`, `enable_thinking`,
// `chat_template_kwargs`, OpenAI-Responses-style `reasoning` — are translated
// here instead of being dropped.

const VALID_EFFORTS = new Set(['minimal', 'low', 'medium', 'high']);

/** Clamp client effort levels upstream doesn't know to the nearest supported one. */
const EFFORT_CLAMP = { minimal: 'low', xhigh: 'high', max: 'high', none: null, off: null };

/** Map an Anthropic thinking budget (tokens) to an effort level. */
export function budgetToEffort(budget) {
  const n = Number(budget);
  if (!Number.isFinite(n) || n <= 0) return null;      // disabled / nonsense
  if (n < 4096) return 'low';
  if (n < 16384) return 'medium';
  return 'high';
}

/** Anthropic `thinking` request field -> upstream reasoning_effort (or null = off). */
export function reasoningEffortFromAnthropic(thinking) {
  if (!thinking || typeof thinking !== 'object') return null;
  if (thinking.type === 'disabled') return null;
  if (thinking.type === 'enabled') {
    return budgetToEffort(thinking.budget_tokens) ?? 'medium';
  }
  return null;
}

// every reasoning-control field clients might send on an OpenAI-style body
const REASONING_FIELDS = [
  'reasoning_effort', 'reasoning', 'thinking', 'thinking_budget',
  'enable_thinking', 'include_reasoning', 'reasoning_content',
  'chat_template_kwargs', 'reasoning_summary', 'reasoning_token_budget',
];

/** Case/whitespace-tolerant effort read: ' HIGH ' -> 'high'; anything else passes through. */
function normalizeEffort(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return v || null;
}

/**
 * Normalize an OpenAI chat body (parsed object, mutated in place):
 * collapse every reasoning-control field into at most `reasoning_effort`.
 * Returns { dropped: string[], effort: string|null }.
 */
export function normalizeOpenAIReasoning(body) {
  const grabbed = {};
  const dropped = [];
  for (const k of REASONING_FIELDS) {
    if (k in body) { grabbed[k] = body[k]; dropped.push(k); delete body[k]; }
  }

  let effort = normalizeEffort(grabbed.reasoning_effort);

  // explicit off signals beat any requested effort: a client that says "no
  // thinking" must never be billed for reasoning tokens just because a default
  // effort (or its own effort field) is also present.
  const t = grabbed.thinking;
  const explicitlyOff =
    (t && typeof t === 'object' && t.type === 'disabled') ||
    t === 'disabled' || t === false ||
    grabbed.enable_thinking === false ||
    grabbed.chat_template_kwargs?.enable_thinking === false;

  if (!explicitlyOff && !effort) {
    if (t && typeof t === 'object' && t.type === 'enabled') {
      effort = budgetToEffort(t.budget_tokens) ?? 'medium';
    } else if (t === 'enabled' || t === true) {
      effort = 'medium';
    }
    if (grabbed.enable_thinking === true) effort = effort ?? 'medium';
    if (grabbed.chat_template_kwargs?.enable_thinking === true) effort = effort ?? 'medium';
    if (typeof grabbed.reasoning === 'string') effort = effort ?? normalizeEffort(grabbed.reasoning);
    else if (grabbed.reasoning?.effort) effort = effort ?? normalizeEffort(grabbed.reasoning.effort);
  }
  if (explicitlyOff) effort = null;

  if (effort) effort = EFFORT_CLAMP[effort] ?? effort;
  if (effort && VALID_EFFORTS.has(effort)) body.reasoning_effort = effort;
  else effort = null;
  return { dropped, effort };
}

/** Fallback: strip every reasoning field (used when upstream 400s anyway). */
export function stripAllReasoning(body) {
  const dropped = [];
  for (const k of REASONING_FIELDS) {
    if (k in body) { dropped.push(k); delete body[k]; }
  }
  return dropped;
}
