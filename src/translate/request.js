// translate/request.js — Anthropic Messages -> OpenAI Chat Completions
import { resolveModel } from '../catalog.js';
import { reasoningEffortFromAnthropic } from '../reasoning.js';

export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
}

function toolChoiceToOpenAI(tc) {
  if (!tc) return undefined;
  if (typeof tc === 'string') return tc === 'auto' ? 'auto' : tc === 'any' ? 'required' : undefined;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'tool') return { type: 'function', function: { name: tc.name } };
  return undefined;
}

export function anthropicToOpenAI(body) {
  const messages = [];

  const sys = textOf(body.system);
  if (sys) messages.push({ role: 'system', content: sys });

  for (const msg of body.messages ?? []) {
    const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content ?? '' }];

    if (msg.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const toolCalls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      const m = { role: 'assistant', content: text || null };
      if (toolCalls.length) m.tool_calls = toolCalls;
      messages.push(m);
    } else {
      // user: split tool_result blocks into OpenAI "tool" messages, keep text
      const toolResults = blocks.filter((b) => b.type === 'tool_result');
      for (const tr of toolResults) {
        messages.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: typeof tr.content === 'string' ? tr.content : textOf(tr.content) || '',
        });
      }
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const images = blocks.filter((b) => b.type === 'image');
      if (images.length) {
        logImageDropped(images.length);
      }
      if (text || !toolResults.length) messages.push({ role: 'user', content: text || '' });
    }
  }

  const out = {
    model: resolveModel(body.model),
    messages,
    max_tokens: body.max_tokens ?? 4096,
    stream: !!body.stream,
  };
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stop_sequences?.length) out.stop = body.stop_sequences;

  // client reasoning intent (Anthropic thinking) -> upstream reasoning_effort
  const effort = reasoningEffortFromAnthropic(body.thinking);
  if (effort) out.reasoning_effort = effort;

  if (body.tools?.length) {
    out.tools = body.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: t.input_schema ?? { type: 'object', properties: {} },
      },
    }));
    const tc = toolChoiceToOpenAI(body.tool_choice);
    if (tc) out.tool_choice = tc;
  }
  return out;
}

function logImageDropped(n) {
  // lazy import avoidance: keep it simple, images are not supported upstream here
  console.warn(`[translate] dropped ${n} image block(s): upstream path is text-only`);
}
