import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { messages } from '../packages/connect/src/transcript.js';

const { apply, emptyLog } = await import('../apps/web/src/session/types.ts');

const root = mkdtempSync(join(tmpdir(), 'helm-hidden-context-'));
test.after(() => rmSync(root, { recursive: true, force: true }));

test('Codex instructions stored as user messages are not read back as the owner\'s words', async () => {
  const path = join(root, 'codex-agents.jsonl');
  const user = (text) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  writeFileSync(path, [
    user('# AGENTS.md instructions for /home/me/project\n\n<INSTRUCTIONS>\nShip it.\n</INSTRUCTIONS>'),
    user('<environment_context>\n<cwd>/home/me/project</cwd>\n</environment_context>'),
    user('Why does the build fail?'),
  ].map((x) => JSON.stringify(x)).join('\n'));
  const history = await messages({ engine: 'codex', path, all: true });
  assert.deepEqual(history.map((m) => m.text), ['Why does the build fail?']);
});

test('a copy of the live chat read back from the CLI\'s file stays off screen', () => {
  // What an older daemon wrote when a Helm-started Codex chat first got its
  // file: the instructions and the message again, below the live reply.
  const log = emptyLog();
  let seq = 0;
  const ev = (e) => apply(log, { ...e, seq: ++seq });
  ev({ type: 'turn.start', turnId: 'local-a', text: 'Verify it plz' });
  ev({ type: 'turn.start', turnId: 'live', text: 'Verify it plz', inputId: 'local-a' });
  ev({ type: 'turn.start', turnId: 'imported-1', text: '# AGENTS.md instructions for /x\n\n<INSTRUCTIONS>…', imported: true });
  ev({ type: 'turn.done', turnId: 'imported-1', status: 'ok', imported: true });
  ev({ type: 'turn.start', turnId: 'imported-2', text: 'Verify it plz', imported: true });
  ev({ type: 'turn.done', turnId: 'imported-2', status: 'ok', imported: true });
  ev({ type: 'item.start', id: 'i1', kind: 'text', turnId: 'live' });
  ev({ type: 'item.delta', id: 'i1', text: 'Checked.' });
  assert.deepEqual(log.turns.map((t) => t.id), ['live']);
  assert.equal(log.turns[0].done, undefined, 'the live reply is still running');
  assert.equal(log.turns[0].items[0].text, 'Checked.');
});

test('an older message imported again after its turn finished still shows', () => {
  const log = emptyLog();
  let seq = 0;
  const ev = (e) => apply(log, { ...e, seq: ++seq });
  ev({ type: 'turn.start', turnId: 'imported-1', text: 'run the tests', imported: true });
  ev({ type: 'turn.done', turnId: 'imported-1', status: 'ok', imported: true });
  ev({ type: 'turn.start', turnId: 'imported-2', text: 'run the tests', imported: true });
  ev({ type: 'turn.done', turnId: 'imported-2', status: 'ok', imported: true });
  assert.equal(log.turns.length, 2);
});
