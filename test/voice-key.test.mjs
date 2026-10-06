import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-voice-'));
const { setGroqKey, groqKey } = await import('../packages/connect/src/voice.js');
const file = join(process.env.HELM_DIR, 'groq-api-key');

test('a key Groq refuses is not kept', async () => {
  await assert.rejects(setGroqKey('gsk_' + 'x'.repeat(40), { fetchImpl: async () => ({ ok: false, status: 401 }) }), /did not accept/);
  await assert.rejects(setGroqKey('short'), /does not look like/);
  assert.equal(existsSync(file), false);
});

test('a key Groq accepts is kept, private, and used first', async () => {
  const key = 'gsk_' + 'y'.repeat(40);
  const r = await setGroqKey(` ${key}\n`, { fetchImpl: async (_url, init) => {
    assert.equal(init.headers.authorization, `Bearer ${key}`);
    return { ok: true, status: 200 };
  } });
  assert.equal(r.voice, true);
  assert.equal(readFileSync(file, 'utf8').trim(), key);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(groqKey(), key);
});
