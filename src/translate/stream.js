// translate/stream.js — OpenAI SSE -> Anthropic SSE, with ping keep-alive
import { randomUUID } from 'node:crypto';
import { log } from '../logger.js';

const estimateTokens = (blocks) =>
  blocks.reduce((n, b) => n + Math.ceil((b.text ?? b.json ?? '').length / 4), 0);

/**
 * Consume an OpenAI chat-completions SSE stream and re-emit it as an
 * Anthropic Messages SSE stream on `res`.
 */
export async function streamTranslate(upstreamRes, requestModel, res, onUsage) {
  const contentType = upstreamRes.headers.get('content-type') ?? '';

  // Upstream answered JSON despite stream:true -> emit as one-shot sequence.
  if (contentType.includes('application/json')) {
    const data = await upstreamRes.json();
    return emitWhole(data, requestModel, res, onUsage);
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

  const blocks = []; // {type:'text'|'tool_use', index, oaiIndex?, id?, name?, text?, json?}
  let stop = 'end_turn';
  let inTokens = 0, outTokens = 0;
  let buffer = '';
  let streamError = null;

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
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) stop = mapStop(choice.finish_reason);
        const delta = choice.delta ?? {};

        if (delta.reasoning_content) emitThinking(send, blocks, delta.reasoning_content);
        if (delta.content) emitText(send, blocks, delta.content);
        for (const tc of delta.tool_calls ?? []) emitToolDelta(send, blocks, tc);
      }
    }
  } catch (err) {
    streamError = err;
    log.error('stream translation failed mid-flight', { error: err.message });
  } finally {
    clearInterval(ping);
    if (streamError) {
      // the response is incomplete — terminate with an error event, never a
      // normal message_delta/message_stop that would make truncation look done
      send('error', { type: 'error', error: { type: 'api_error', message: `stream interrupted: ${streamError.message}` } });
    } else {
      for (const b of blocks) if (!b.closed) send('content_block_stop', { type: 'content_block_stop', index: b.index });
      const outFinal = outTokens || estimateTokens(blocks);
      send('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stop, stop_sequence: null },
        usage: { output_tokens: outFinal, input_tokens: inTokens },
      });
      send('message_stop', { type: 'message_stop' });
    }
    onUsage?.({ inputTokens: inTokens, outputTokens: outTokens }, streamError);
    finish();
  }
}

function closeLast(send, blocks) {
  const last = blocks[blocks.length - 1];
  if (last && !last.closed) {
    last.closed = true;
    send('content_block_stop', { type: 'content_block_stop', index: last.index });
  }
}

function emitThinking(send, blocks, text) {
  if (!text) return;
  let b = blocks[blocks.length - 1];
  if (!b || b.type !== 'thinking' || b.closed) {
    closeLast(send, blocks);
    b = { type: 'thinking', index: blocks.length, text: '' };
    blocks.push(b);
    send('content_block_start', { type: 'content_block_start', index: b.index, content_block: { type: 'thinking', thinking: '' } });
  }
  b.text += text;
  send('content_block_delta', { type: 'content_block_delta', index: b.index, delta: { type: 'thinking_delta', thinking: text } });
}

function emitText(send, blocks, text) {
  if (!text) return;
  let b = blocks[blocks.length - 1];
  if (!b || b.type !== 'text' || b.closed) {
    closeLast(send, blocks);
    b = { type: 'text', index: blocks.length, text: '' };
    blocks.push(b);
    send('content_block_start', { type: 'content_block_start', index: b.index, content_block: { type: 'text', text: '' } });
  }
  b.text += text;
  send('content_block_delta', { type: 'content_block_delta', index: b.index, delta: { type: 'text_delta', text } });
}

function emitToolDelta(send, blocks, tc) {
  let b = blocks.find((x) => x.type === 'tool_use' && x.oaiIndex === tc.index);
  if (!b) {
    closeLast(send, blocks);
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
async function emitWhole(oai, requestModel, res, onUsage) {
  const { openAIToAnthropic } = await import('./response.js');
  const msg = openAIToAnthropic(oai, requestModel);
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
