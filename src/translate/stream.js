// translate/stream.js — OpenAI SSE -> Anthropic SSE, with ping keep-alive
import { randomUUID } from 'node:crypto';
import { log } from '../logger.js';

const estimateTokens = (blocks) =>
  blocks.reduce((n, b) => n + Math.ceil((b.text ?? b.json ?? '').length / 4), 0);

/** Internal signal: a requested stop sequence matched — a normal, complete end. */
class StopSequenceHit extends Error {
  constructor() { super('stop sequence matched'); this.isStopHit = true; }
}

/**
 * Consume an OpenAI chat-completions SSE stream and re-emit it as an
 * Anthropic Messages SSE stream on `res`.
 */
export async function streamTranslate(upstreamRes, requestModel, res, onUsage, opts = {}) {
  const contentType = upstreamRes.headers.get('content-type') ?? '';

  // Upstream answered JSON despite stream:true -> emit as one-shot sequence.
  if (contentType.includes('application/json')) {
    const data = await upstreamRes.json();
    return emitWhole(data, requestModel, res, onUsage, opts);
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  send('message_start', {
    type: 'message_start',
    message: {
      id: `msg_${randomUUID()}`, type: 'message', role: 'assistant',
      model: requestModel ?? 'unknown', content: [],
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  const blocks = []; // every block opened: {type:'text'|'tool_use'|'thinking', index, closed, ...}
  const openBlock = () => blocks.find((b) => !b.closed);
  let stop = 'end_turn';
  let stopSequence = null;
  let inTokens = 0, outTokens = 0, cacheRead = 0;
  let buffer = '';
  let streamError = null;
  let stoppedBySequence = false;

  const ping = setInterval(() => send('ping', { type: 'ping' }), 15_000);
  const finish = () => { clearInterval(ping); try { res.end(); } catch {} };

  try {
    const reader = upstreamRes.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(payload); } catch { continue; }

        if (chunk.usage) {
          inTokens = chunk.usage.prompt_tokens ?? inTokens;
          outTokens = chunk.usage.completion_tokens ?? outTokens;
          cacheRead = chunk.usage.prompt_tokens_details?.cached_tokens ?? cacheRead;
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) stop = mapStop(choice.finish_reason);
        const delta = choice.delta ?? {};

        if (delta.reasoning_content) emitThinking(send, blocks, delta.reasoning_content);
        if (delta.content) {
          emitText(send, blocks, delta.content);
          // local stop-sequence enforcement: truncate at the first match and
          // finish the message with stop_reason "stop_sequence"
          if (opts.stopSequences?.length) {
            const full = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
            for (const seq of opts.stopSequences) {
              if (!seq) continue;
              const idx = full.indexOf(seq);
              if (idx !== -1) {
                // truncate the block that contains the match
                let off = 0;
                for (const b of blocks) {
                  if (b.type !== 'text') continue;
                  const start = off, end = off + (b.text ?? '').length;
                  if (idx >= start && idx <= end) b.text = (b.text ?? '').slice(0, idx - start);
                  off = end;
                }
                stop = 'stop_sequence';
                stopSequence = seq;
                log.info('stop sequence matched, truncating stream', { seq });
                try { reader.cancel().catch(() => {}); } catch {}
                throw new StopSequenceHit(); // unwind to finally (not an error)
              }
            }
          }
        }
        for (const tc of delta.tool_calls ?? []) emitToolDelta(send, blocks, tc);
      }
    }
  } catch (err) {
    if (err instanceof StopSequenceHit) {
      stoppedBySequence = true; // normal completion, handled in finally
    } else {
      streamError = err;
      log.error('stream translation failed mid-flight', { error: err.message });
    }
  } finally {
    clearInterval(ping);
    // validate accumulated tool-call JSON before declaring success — never let
    // a client execute a tool with truncated/garbled arguments
    if (!streamError) {
      for (const b of blocks) {
        if (b.type !== 'tool_use') continue;
        let parsed;
        try { parsed = JSON.parse(b.json || '{}'); } catch { parsed = null; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          streamError = new Error(`malformed arguments in streamed tool call "${b.name || 'unknown'}"`);
          log.error('malformed streamed tool arguments', { tool: b.name, json: b.json.slice(0, 200) });
          break;
        }
      }
    }
    if (streamError) {
      // the response is incomplete — terminate with an error event, never a
      // normal message_delta/message_stop that would make truncation look done
      send('error', { type: 'error', error: { type: 'api_error', message: `stream interrupted: ${streamError.message}` } });
    } else {
      for (const b of blocks) if (!b.closed) send('content_block_stop', { type: 'content_block_stop', index: b.index });
      if (stoppedBySequence) { stop = 'stop_sequence'; }
      const outFinal = outTokens || estimateTokens(blocks);
      send('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stop, stop_sequence: stopSequence },
        usage: {
          output_tokens: outFinal,
          input_tokens: inTokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: cacheRead,
        },
      });
      send('message_stop', { type: 'message_stop' });
    }
    onUsage?.({ inputTokens: inTokens, outputTokens: outTokens || estimateTokens(blocks) }, streamError);
    finish();
  }
}

function closeActive(send, blocks) {
  const b = blocks.find((x) => !x.closed);
  if (b) {
    b.closed = true;
    send('content_block_stop', { type: 'content_block_stop', index: b.index });
  }
}

function emitThinking(send, blocks, text) {
  if (!text) return;
  let b = openBlockLocal(blocks);
  if (!b || b.type !== 'thinking') {
    closeActive(send, blocks);
    b = { type: 'thinking', index: blocks.length, text: '' };
    blocks.push(b);
    send('content_block_start', { type: 'content_block_start', index: b.index, content_block: { type: 'thinking', thinking: '' } });
  }
  b.text = (b.text ?? '') + text;
  send('content_block_delta', { type: 'content_block_delta', index: b.index, delta: { type: 'thinking_delta', thinking: text } });
}

const openBlockLocal = (blocks) => blocks.find((x) => !x.closed);

function emitText(send, blocks, text) {
  if (!text) return;
  let b = openBlockLocal(blocks);
  if (!b || b.type !== 'text') {
    closeActive(send, blocks);
    b = { type: 'text', index: blocks.length, text: '' };
    blocks.push(b);
    send('content_block_start', { type: 'content_block_start', index: b.index, content_block: { type: 'text', text: '' } });
  }
  b.text = (b.text ?? '') + text;
  send('content_block_delta', { type: 'content_block_delta', index: b.index, delta: { type: 'text_delta', text } });
}

function emitToolDelta(send, blocks, tc) {
  const active = openBlockLocal(blocks);
  // stream into the open tool block when it matches; otherwise open a new one
  let b = (active?.type === 'tool_use' && active.oaiIndex === tc.index)
    ? active
    : blocks.find((x) => x.type === 'tool_use' && x.oaiIndex === tc.index && !x.closed);
  if (!b) {
    if (blocks.some((x) => x.type === 'tool_use' && x.oaiIndex === tc.index)) {
      // upstream went back to an already-closed tool call — out of order; drop
      // the delta rather than emitting events out of protocol order
      log.warn('dropped out-of-order tool delta', { oaiIndex: tc.index });
      return;
    }
    closeActive(send, blocks);
    b = { type: 'tool_use', oaiIndex: tc.index, index: blocks.length, id: tc.id, name: tc.function?.name ?? '', json: '' };
    blocks.push(b);
    send('content_block_start', {
      type: 'content_block_start', index: b.index,
      content_block: { type: 'tool_use', id: b.id ?? `toolu_${randomUUID().slice(0, 8)}`, name: b.name, input: {} },
    });
  }
  if (tc.function?.name && !b.name) b.name = tc.function.name;
  if (tc.function?.arguments) {
    b.json += tc.function.arguments;
    send('content_block_delta', {
      type: 'content_block_delta', index: b.index,
      delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
    });
  }
}

function mapStop(fr) {
  return fr === 'tool_calls' ? 'tool_use' : fr === 'length' ? 'max_tokens' : 'end_turn';
}

/** Emit a complete OpenAI response as an Anthropic SSE sequence. */
async function emitWhole(oai, requestModel, res, onUsage, opts = {}) {
  const { openAIToAnthropic, MalformedToolCallError } = await import('./response.js');
  let msg;
  try {
    msg = openAIToAnthropic(oai, requestModel, opts);
  } catch (err) {
    if (err instanceof MalformedToolCallError) {
      log.error('malformed tool arguments in one-shot response', { error: err.message });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('message_start', { type: 'message_start', message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: requestModel ?? 'unknown', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
      send('error', { type: 'error', error: { type: 'api_error', message: err.message } });
      res.end();
      onUsage?.({ inputTokens: 0, outputTokens: 0 }, err);
      return;
    }
    throw err;
  }
  onUsage?.({ inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', { type: 'message_start', message: { ...msg, content: [] } });
  msg.content.forEach((block, index) => {
    if (block.type === 'thinking') {
      send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } });
      if (block.thinking) send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } });
    } else if (block.type === 'tool_use') {
      send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    } else {
      send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      if (block.text) send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    }
    send('content_block_stop', { type: 'content_block_stop', index });
  });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: { output_tokens: msg.usage.output_tokens } });
  send('message_stop', { type: 'message_stop' });
  res.end();
}
