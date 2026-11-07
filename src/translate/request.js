// translate/request.js — Anthropic Messages -> OpenAI Chat Completions
import { resolveModel } from '../catalog.js';
import { reasoningEffortFromAnthropic } from '../reasoning.js';

/** Client sent content we cannot represent for upstream — becomes a 400. */
export class UnsupportedContentError extends Error {
  constructor(kind) {
    super(`${kind} content is not supported by this gateway's upstream models`);
    this.status = 400;
  }
}

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

/** Anthropic image block -> OpenAI image_url part (upstream accepts the format). */
function imageToOpenAI(block) {
  const src = block.source;
  if (src?.type === 'base64' && src.data) {
    return { type: 'image_url', image_url: { url: `data:${src.media_type ?? 'image/png'};base64,${src.data}` } };
  }
  if (src?.type === 'url' && src.url) {
    return { type: 'image_url', image_url: { url: src.url } };
  }
  return null; // malformed image block -> dropped (logged)
}

export function anthropicToOpenAI(body) {
  const messages = [];
  let droppedImages = 0;

  const sys = textOf(body.system);
  if (sys) messages.push({ role: 'system', content: sys });

  for (const msg of body.messages ?? []) {
    const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content ?? '' }];

    if (msg.role === 'assistant') {
      // thinking blocks sent back by clients (Claude Code replays them) are
      // intentionally dropped — upstream never saw the reasoning and has no
      // field for it; text and tool_use are what the model needs.
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
      // user: split tool_result blocks into OpenAI "tool" messages, keep text/images
      const toolResults = blocks.filter((b) => b.type === 'tool_result');
      for (const tr of toolResults) {
        messages.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: typeof tr.content === 'string' ? tr.content : textOf(tr.content) || '',
        });
      }
      const parts = [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text });
        else if (b.type === 'image') {
          const img = imageToOpenAI(b);
          if (img) parts.push(img); else droppedImages++;
        } else if (b.type === 'document') {
          throw new UnsupportedContentError('document (PDF)');
        }
      }
      const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      if (parts.length && (text || !toolResults.length)) {
        messages.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? text : parts });
      } else if (!toolResults.length) {
        messages.push({ role: 'user', content: text || '' });
      }
    }
  }
  if (droppedImages) logDroppedImages(droppedImages);

  const out = {
    model: resolveModel(body.model),
    messages,
    max_tokens: body.max_tokens ?? 4096,
    stream: !!body.stream,
  };
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  // NOTE: stop_sequences are intentionally NOT forwarded — upstream strips the
  // matched text, which makes detection impossible. The translator enforces
  // them locally (see stream.js / response.js) so clients get the exact
  // Anthropic semantics: stop_reason "stop_sequence" + the matched sequence.

  // ask upstream for usage on streamed responses (otherwise accounting is zero)
  if (out.stream && !body.stream_options) out.stream_options = { include_usage: true };

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

function logDroppedImages(n) {
  // lazy import avoidance: keep it simple, log via console (logger import would cycle)
  console.warn(`[translate] dropped ${n} malformed image block(s)`);
}
