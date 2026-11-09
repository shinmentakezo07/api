// test/stream.test.js — stop-sequence state machine + block protocol invariants.
import test from 'node:test';
import assert from 'node:assert/strict';
import { streamTranslate } from '../src/translate/stream.js';
import { openAIToAnthropic } from '../src/translate/response.js';
import { fakeRes, fakeUpstream, sseBody, rawBody, byteChunks, frame, delta } from './helpers.js';

const run = async (chunks, opts = {}, resOpts = {}) => {
  const res = fakeRes(resOpts);
  await streamTranslate(fakeUpstream(sseBody(chunks)), 'test-model', res, () => {}, opts);
  return res;
};

/** Drive the translator with a literal SSE body (exact framing control). */
const runRaw = async (text, opts = {}) => {
  const res = fakeRes();
  await streamTranslate(fakeUpstream(rawBody(text)), 'test-model', res, () => {}, opts);
  return res;
};

test('no stop sequences: text passes through untouched', async () => {
  const res = await run([delta('abc'), delta('def')]);
  assert.equal(res.text, 'abcdef');
  assert.equal(res.messageDelta.delta.stop_reason, 'end_turn');
});

test('stop sequence inside one chunk truncates before it', async () => {
  const res = await run([delta('hello STOP world')], { stopSequences: ['STOP'] });
  assert.equal(res.text, 'hello ');
  assert.equal(res.messageDelta.delta.stop_reason, 'stop_sequence');
  assert.equal(res.messageDelta.delta.stop_sequence, 'STOP');
});

test('stop sequence straddling chunk boundaries is never leaked', async () => {
  const res = await run([delta('Hel'), delta('lo STO'), delta('P more')], { stopSequences: ['STOP'] });
  assert.equal(res.text, 'Hello ');
  assert.ok(!res.text.includes('STOP'));
  assert.equal(res.messageDelta.delta.stop_sequence, 'STOP');
});

test('stop sequence split across a single character boundary is caught', async () => {
  const res = await run(['S', 'T', 'O', 'P', 'tail'].map((c) => delta(c)), { stopSequences: ['STOP'] });
  assert.equal(res.text, '');
  assert.equal(res.messageDelta.delta.stop_reason, 'stop_sequence');
});

test('a stop sequence matching at index 0 still yields one empty text block', async () => {
  const res = await run([delta('STOP')], { stopSequences: ['STOP'] });
  assert.equal(res.events.filter((e) => e === 'content_block_start').length, 1);
  assert.equal(res.events.filter((e) => e === 'content_block_stop').length, 1);
  assert.equal(res.messageDelta.delta.stop_reason, 'stop_sequence');
});

test('held-back tail is released when it is not a stop sequence', async () => {
  const res = await run([delta('abc'), delta('STOPPED')], { stopSequences: ['XYZ'] });
  assert.equal(res.text, 'abcSTOPPED');
  assert.equal(res.messageDelta.delta.stop_reason, 'end_turn');
});

test('the earliest of several stop sequences wins', async () => {
  const res = await run([delta('aaa BBB then AAA')], { stopSequences: ['AAA', 'BBB'] });
  assert.equal(res.text, 'aaa ');
  assert.equal(res.messageDelta.delta.stop_sequence, 'BBB');
});

test('every stream ends with message_stop on the success path', async () => {
  const res = await run([delta('x')], { stopSequences: ['Z'] });
  assert.equal(res.events.at(-1), 'message_stop');
  assert.equal(res.events.filter((e) => e === 'message_stop').length, 1);
});

// --- block protocol invariants ------------------------------------------------

test('blocks opened equal blocks stopped (tool calls)', async () => {
  const res = await run([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: '{"a"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }, finish_reason: 'tool_calls' }] },
  ], { stopSequences: ['STOP'] });
  assert.equal(res.events.filter((e) => e === 'content_block_start').length, res.events.filter((e) => e === 'content_block_stop').length);
  assert.equal(res.messageDelta.delta.stop_reason, 'tool_use');
});

test('malformed tool arguments surface as an error, never a fake success', async () => {
  const broken = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{"a":' } }] } }] };
  const res = await run([broken]);
  assert.equal(res.events.filter((e) => e === 'error').length, 1);
  assert.equal(res.events.includes('message_stop'), false, 'must not emit message_stop after an error');
});

test('reasoning then text produces thinking and text blocks in order', async () => {
  const res = await run([
    { choices: [{ delta: { reasoning_content: 'thinking...' } }] },
    { choices: [{ delta: { content: 'answer' } }] },
  ]);
  assert.match(res.out, /"type":"thinking"/);
  assert.match(res.out, /"type":"text"/);
  assert.ok(res.out.indexOf('"type":"thinking"') < res.out.indexOf('"type":"text"'));
});
// ---- SSE framing: the final delta must never be dropped ------------------

test('a final data line with no trailing newline is still emitted', async () => {
  // Some upstreams/proxies omit the newline on the last flush. Dropping that
  // chunk loses content while still reporting a clean message_stop.
  const res = await runRaw(frame(delta('hello')) + 'data: ' + JSON.stringify(delta('world')));
  assert.equal(res.text, 'helloworld');
  assert.equal(res.messageDelta.delta.stop_reason, 'end_turn');
});

test('an entire body with no newline at all is not discarded', async () => {
  const res = await runRaw('data: ' + JSON.stringify(delta('LOST')));
  assert.equal(res.text, 'LOST');
  assert.ok(res.events.includes('message_stop'));
});

test('an unterminated final line still respects stop sequences', async () => {
  const res = await runRaw(frame(delta('abc')) + 'data: ' + JSON.stringify(delta('STOPzzz')), {
    stopSequences: ['STOP'],
  });
  assert.equal(res.text, 'abc');
  assert.equal(res.messageDelta.delta.stop_reason, 'stop_sequence');
  assert.equal(res.messageDelta.delta.stop_sequence, 'STOP');
});

test('a stop sequence in an unterminated final line leaves a well-formed stream', async () => {
  const res = await runRaw('data: ' + JSON.stringify(delta('STOP')), { stopSequences: ['STOP'] });
  assert.equal(res.text, '');
  assert.equal(res.messageDelta.delta.stop_reason, 'stop_sequence');
  // success path still terminates properly after a post-EOF hit
  assert.ok(res.events.includes('message_stop'));
  assert.ok(!res.events.includes('error'));
  const starts = res.events.filter((e) => e === 'content_block_start').length;
  const stops = res.events.filter((e) => e === 'content_block_stop').length;
  assert.equal(starts, stops);
});

test('a trailing partial JSON line is ignored, not fatal', async () => {
  const res = await runRaw(frame(delta('ok')) + 'data: {"choices":[{"delta":{"con');
  assert.equal(res.text, 'ok');
  assert.ok(res.events.includes('message_stop'));
});

test('CRLF framing is handled', async () => {
  const res = await runRaw(
    'data: ' + JSON.stringify(delta('a')) + '\r\n\r\n' +
    'data: ' + JSON.stringify(delta('b')) + '\r\n\r\n',
  );
  assert.equal(res.text, 'ab');
});

test('a multi-byte character split across chunks is decoded, not mangled', async () => {
  const enc = new TextEncoder();
  const bytes = enc.encode(frame(delta('héllo ✓')));
  const mid = Math.floor(bytes.length / 2);
  const res = fakeRes();
  await streamTranslate(
    fakeUpstream(byteChunks([bytes.slice(0, mid), bytes.slice(mid)])),
    'test-model', res, () => {}, {},
  );
  assert.equal(res.text, 'héllo ✓');
});

// ---- delta ordering -------------------------------------------------------

test('reasoning emitted after text opens a separate thinking block', async () => {
  const res = await run([
    delta('answer '),
    { choices: [{ delta: { reasoning_content: 'reconsider' } }] },
    delta('more'),
  ]);
  const types = [...res.out.matchAll(/"type":"(text_delta|thinking_delta)"/g)].map((m) => m[1]);
  assert.deepEqual(types, ['text_delta', 'thinking_delta', 'text_delta']);
  assert.equal(res.text, 'answer more');
});

test('empty and whitespace-only deltas are handled correctly', async () => {
  const res = await run([delta(''), delta(''), delta('x')]);
  assert.equal(res.text, 'x');
  assert.equal(res.events.filter((e) => e === 'content_block_start').length, 1);

  const ws = await run([delta(' ')]);
  assert.equal(ws.text, ' ');
});

test('usage-only and finish_reason-only chunks are both honoured', async () => {
  const res = await run([
    delta('hi'),
    { choices: [{ delta: {}, finish_reason: 'length' }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ]);
  assert.equal(res.messageDelta.delta.stop_reason, 'max_tokens');
  assert.equal(res.messageDelta.usage.output_tokens, 5);
  assert.equal(res.messageDelta.usage.input_tokens, 10);
});
// ---- stop reason mapping: one table, shared by both paths ---------------

test('stop reasons map consistently on the streaming path', async () => {
  const cases = {
    stop: 'end_turn',
    length: 'max_tokens',
    tool_calls: 'tool_use',
    function_call: 'tool_use',
    content_filter: 'refusal',
    stop_sequence: 'stop_sequence',
    unknown_reason: 'end_turn',
  };
  for (const [fr, want] of Object.entries(cases)) {
    const res = await run([{ choices: [{ delta: { content: 'x' }, finish_reason: fr }] }]);
    assert.equal(res.messageDelta.delta.stop_reason, want, `finish_reason "${fr}"`);
  }
});

test('stop_sequence survives the streaming path (mapper parity)', async () => {
  // the streaming mapper used to omit this, unlike the non-streaming one
  const res = await run([{ choices: [{ delta: { content: 'x' }, finish_reason: 'stop_sequence' }] }]);
  assert.equal(res.messageDelta.delta.stop_reason, 'stop_sequence');
});

// ---- non-streaming path agrees with the streaming path -----------------

test('non-streaming and streaming agree on every finish_reason', async () => {
  const reasons = ['stop', 'length', 'tool_calls', 'function_call', 'content_filter', 'stop_sequence', 'other'];
  for (const fr of reasons) {
    const oai = { choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: fr }] };
    const nonStream = openAIToAnthropic(oai, 'm', {}).stop_reason;
    const stream = (await run([{ choices: [{ delta: { content: 'x' }, finish_reason: fr }] }])).messageDelta.delta.stop_reason;
    assert.equal(nonStream, stream, `finish_reason "${fr}" disagrees between paths`);
  }
});

test('a filtered response is distinguishable from a clean stop', async () => {
  const filtered = await run([{ choices: [{ delta: { content: 'x' }, finish_reason: 'content_filter' }] }]);
  const clean = await run([{ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }]);
  assert.equal(filtered.messageDelta.delta.stop_reason, 'refusal');
  assert.notEqual(filtered.messageDelta.delta.stop_reason, clean.messageDelta.delta.stop_reason);
});

test('a filtered response still terminates cleanly, not as an error', async () => {
  const res = await run([{ choices: [{ delta: { content: 'x' }, finish_reason: 'content_filter' }] }]);
  assert.ok(res.events.includes('message_stop'));
  assert.ok(!res.events.includes('error'));
  const starts = res.events.filter((e) => e === 'content_block_start').length;
  const stops = res.events.filter((e) => e === 'content_block_stop').length;
  assert.equal(starts, stops);
});
