// test/session.test.js — upstream session identity policy.
// free-pi runs one request at a time per x-session-id, so the gateway must not
// hand every client the same id (that serialises them and triggers 429s).
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { conversationKeyOf, sessionIdFor, freshSessionId } from '../src/session.js';

const account = { id: 'ui-1', sessionId: 'fpgw-account-stable' };
const withStrategy = (s, fn) => {
  const prev = config.sessionStrategy;
  config.sessionStrategy = s;
  try { return fn(); } finally { config.sessionStrategy = prev; }
};

test('conversationKeyOf is stable across turns of one conversation', () => {
  const first = { system: 'be terse', messages: [{ role: 'user', content: 'hello' }] };
  const later = {
    system: 'be terse',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'and then?' },
    ],
  };
  assert.equal(conversationKeyOf(first), conversationKeyOf(later));
});

test('conversationKeyOf separates conversations', () => {
  const a = { messages: [{ role: 'user', content: 'fix the build' }] };
  const b = { messages: [{ role: 'user', content: 'write a poem' }] };
  assert.notEqual(conversationKeyOf(a), conversationKeyOf(b));
});

test('conversationKeyOf handles Anthropic block content and empty bodies', () => {
  const blocks = { system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
  assert.ok(conversationKeyOf(blocks).length > 0);
  assert.equal(conversationKeyOf({}), '');
  assert.equal(conversationKeyOf(null), '');
});

test("'request' strategy mints a distinct id per call", () => {
  withStrategy('request', () => {
    const a = sessionIdFor(account, 'k');
    const b = sessionIdFor(account, 'k');
    assert.notEqual(a, b);
    assert.match(a, /^fpgw-r-[0-9a-f]{16}$/);
  });
});

test("'account' strategy keeps the legacy stable id", () => {
  withStrategy('account', () => {
    assert.equal(sessionIdFor(account, 'k'), account.sessionId);
  });
});

test("'conversation' strategy is stable per conversation, distinct across them", () => {
  withStrategy('conversation', () => {
    const a1 = sessionIdFor(account, 'conv-a');
    const a2 = sessionIdFor(account, 'conv-a');
    const b = sessionIdFor(account, 'conv-b');
    const other = sessionIdFor({ id: 'ui-2', sessionId: 'x' }, 'conv-a');
    assert.equal(a1, a2);
    assert.notEqual(a1, b);
    assert.notEqual(a1, other, 'the same conversation on another account must not collide');
    assert.match(a1, /^fpgw-c-[0-9a-f]{16}$/);
  });
});

test("'conversation' strategy falls back to a fresh id without a key", () => {
  withStrategy('conversation', () => {
    assert.notEqual(sessionIdFor(account, ''), sessionIdFor(account, ''));
  });
});

test('freshSessionId never repeats', () => {
  const ids = new Set(Array.from({ length: 500 }, () => freshSessionId()));
  assert.equal(ids.size, 500);
});
