// test/stream.test.js — stop-sequence state machine + block protocol invariants.
import test from 'node:test';
import assert from 'node:assert/strict';
import { streamTranslate } from '../src/translate/stream.js';
import { fakeRes, fakeUpstream, sseBody, delta } from './helpers.js';

const run = async (chunks, opts = {}, resOpts = {}) => {
  const res = fakeRes(resOpts);
  await streamTranslate(fakeUpstream(sseBody(chunks)), 'test-model', res, () => {}, opts);
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
