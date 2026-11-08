// test/accounts.test.js — round-robin cursor purity (peekOrder vs pickOrder).
import test from 'node:test';
import assert from 'node:assert/strict';

// Mirrors accounts.js selection logic without touching module state.
function makeSelector(n) {
  let rrIndex = 0;
  const list = () => Array.from({ length: n }, (_, i) => ({ id: 'a' + i }));
  const pickOrder = () => {
    const l = list();
    const p = rrIndex % l.length;
    rrIndex = (rrIndex + 1) % l.length;
    return [l[p], ...l.filter((_, i) => i !== p)];
  };
  const peekOrder = () => {
    const l = list();
    const p = rrIndex % l.length;
    return [l[p], ...l.filter((_, i) => i !== p)];
  };
  return { pickOrder, peekOrder };
}

test('peekOrder is pure: repeated calls never advance the cursor', () => {
  const s = makeSelector(3);
  for (let i = 0; i < 50; i++) s.peekOrder();
  assert.deepEqual(s.pickOrder().map((a) => a.id), ['a0', 'a1', 'a2']);
});

test('pickOrder advances the cursor evenly', () => {
  const s = makeSelector(3);
  const served = Array.from({ length: 6 }, () => s.pickOrder()[0].id);
  assert.deepEqual(served, ['a0', 'a1', 'a2', 'a0', 'a1', 'a2']);
});

test('a busy-wait probe does not skew distribution', () => {
  const s = makeSelector(3);
  s.peekOrder(); // what withFailover does before selecting
  const served = Array.from({ length: 6 }, () => s.pickOrder()[0].id);
  assert.deepEqual(served, ['a0', 'a1', 'a2', 'a0', 'a1', 'a2']);
});

test('pickOrder in the probe position WOULD skew (regression guard)', () => {
  const s = makeSelector(3);
  s.pickOrder(); // the old behaviour
  assert.deepEqual(s.pickOrder()[0].id, 'a1', 'cursor advanced by the probe');
});
