import test from 'node:test';
import assert from 'node:assert/strict';
import { balance, pickRoomiest, roomLeft, outUntil, isOut } from '../packages/protocol/balance.js';

const now = 1_000_000_000_000;
const soon = now / 1000 + 3600;
const past = now / 1000 - 60;
const acct = (key, engine, ...used) => ({ key, engine, windows: used.map((u, i) => ({ label: i ? '7d' : '5h', used: u, resetsAt: soon })) });

test('room left is the tightest running window; a reset window is full again', () => {
  assert.equal(roomLeft([{ used: 30, resetsAt: soon }, { used: 80, resetsAt: soon }], now), 20);
  assert.equal(roomLeft([{ used: 100, resetsAt: past }], now), 100);
  assert.equal(roomLeft([], now), null);
  assert.equal(isOut([{ used: 99, resetsAt: soon }], now), true);
  assert.equal(outUntil([{ used: 100, resetsAt: soon }, { used: 100, resetsAt: soon + 5 }], now), soon + 5);
});

test('work stays on the wanted account until it is out of limit', () => {
  const pool = [acct('a', 'codex', 90), acct('b', 'codex', 10)];
  assert.deepEqual(balance(pool, 'a', now), { key: 'a', switched: false });
});

test('an account that is out moves work to the same tool with the most room', () => {
  const pool = [acct('a', 'codex', 100), acct('b', 'codex', 60), acct('c', 'codex', 20), acct('d', 'claude', 0)];
  assert.deepEqual(balance(pool, 'a', now), { key: 'c', switched: true, from: 'a', until: soon, room: 80 });
});

test('no move when every other account of that tool is out or nearly out', () => {
  const pool = [acct('a', 'codex', 100), acct('b', 'codex', 95), acct('d', 'claude', 0)];
  assert.deepEqual(balance(pool, 'a', now), { key: 'a', switched: false, until: soon });
});

test('an account with no readings is a last choice, after any known room', () => {
  assert.equal(balance([acct('a', 'codex', 100), { key: 'b', engine: 'codex', windows: [] }], 'a', now).key, 'b');
  assert.equal(pickRoomiest([{ key: 'b', engine: 'codex', windows: [] }, acct('c', 'codex', 50)], now).key, 'c');
  assert.equal(pickRoomiest([acct('a', 'codex', 100), acct('b', 'codex', 95)], now).key, 'b');
});
