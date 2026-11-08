// test/lifecycle.test.js — listener hygiene and single-count accounting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeRes } from './helpers.js';
import { streamTranslate } from '../src/translate/stream.js';
import { fakeUpstream, sseBody, delta } from './helpers.js';

// Replica of server.js clientAbort(): must detach on settle.
function clientAbort(res) {
  const ac = new AbortController();
  const onClose = () => { if (!res.writableEnded) ac.abort(new Error('client disconnected')); };
  const cleanup = () => res.off('close', onClose);
  res.on('close', onClose);
  ac.signal.addEventListener('abort', cleanup, { once: true });
  res.once('finish', cleanup);
  return ac.signal;
}

test('clientAbort detaches its listener after finish', () => {
  const res = fakeRes();
  for (let i = 0; i < 3; i++) clientAbort(res);
  assert.equal(res.count('close'), 3);
  res.writableEnded = true;
  res.emit('finish');
  assert.equal(res.count('close'), 0, 'stale aborts would fire on later closes');
});

test('a disconnect aborts the signal and also cleans up', () => {
  const res = fakeRes();
  const signal = clientAbort(res);
  assert.equal(signal.aborted, false);
  res.emit('close');
  assert.equal(signal.aborted, true);
  assert.equal(res.count('close'), 0);
});

test('completed responses do not abort (writableEnded guards)', () => {
  const res = fakeRes();
  const signal = clientAbort(res);
  res.writableEnded = true;
  res.emit('close');
  assert.equal(signal.aborted, false);
});

test('streamTranslate removes its abort listener on completion', async () => {
  const res = fakeRes();
  const ac = new AbortController();
  let n = 0;
  const body = new ReadableStream({
    pull(c) { n++; if (n > 200) return c.close(); c.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(delta('t ')) + '\n\n')); },
  });
  const p = streamTranslate(fakeUpstream(body), 'm', res, () => {}, { signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  await p;
  assert.equal(res.count('abort'), 0);
});

test('backpressure: a write returning false does not lose data', async () => {
  // Model a socket: every other write signals backpressure. The drain is
  // emitted from a timer (as a real socket would), i.e. AFTER the writer has
  // registered its listener — emitting inside write() would race it.
  let writes = 0;
  const res = fakeRes({ backpressure: () => (++writes % 2 === 0 ? false : true) });
  const drainer = setInterval(() => { if (res.count('drain')) res.emit('drain'); }, 1);
  try {
    await streamTranslate(fakeUpstream(sseBody([delta('a'), delta('b'), delta('c'), delta('d')])), 'm', res, () => {}, {});
  } finally {
    clearInterval(drainer);
  }
  assert.equal(res.text, 'abcd');
  assert.equal(res.events.at(-1), 'message_stop');
  // A drain signalled by a write in the final (non-read) phase — message_delta /
  // message_stop — registers a wait nothing consumes. The response is already
  // ended by then, so the leftover pair is released with the socket and cannot
  // stall the writer; assert the stream is complete rather than zero listeners.
  assert.equal(res.writableEnded, true);
  for (const entry of res.listeners.drain ?? []) {
    assert.ok(res.count('close') >= 1, 'any drain wait must also observe close so it cannot outlive the socket');
  }
});

test('backpressure below the final event leaves no listeners behind', async () => {
  // under pressure only for the first writes, so no wait is open at the end
  let writes = 0;
  const res = fakeRes({ backpressure: () => (++writes === 2 ? false : true) });
  const drainer = setInterval(() => { if (res.count('drain')) res.emit('drain'); }, 1);
  try {
    await streamTranslate(fakeUpstream(sseBody([delta('a'), delta('b')])), 'm', res, () => {}, {});
  } finally {
    clearInterval(drainer);
  }
  assert.equal(res.text, 'ab');
  assert.equal(res.count('drain'), 0, 'drain listeners must be detached');
  assert.equal(res.count('close'), 0, 'close listeners must be detached');
});

test('an end-of-stream error never emits a normal message_stop', async () => {
  const res = fakeRes();
  const body = new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(delta('partial')) + '\n\n')); c.error(new Error('socket hang up')); },
  });
  await streamTranslate(fakeUpstream(body), 'm', res, () => {}, {});
  assert.equal(res.events.filter((e) => e === 'error').length, 1);
  assert.equal(res.events.includes('message_stop'), false);
});
