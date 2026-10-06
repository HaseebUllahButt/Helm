import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { messages } from '../packages/connect/src/transcript.js';

const dir = mkdtempSync(join(tmpdir(), 'helm-claude-blocks-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const line = (type, id, content) => JSON.stringify({ type, uuid: `${type}-${Math.random()}`, timestamp: new Date().toISOString(),
  message: { id, role: type, content } });

test('every block of one Claude reply is kept: what it said and each call it made', async () => {
  const path = join(dir, 'blocks.jsonl');
  writeFileSync(path, [
    line('user', undefined, 'make the video'),
    // Current Claude Code: one line per block, all sharing the reply's id.
    line('assistant', 'msg_1', [{ type: 'thinking', thinking: '…' }]),
    line('assistant', 'msg_1', [{ type: 'text', text: 'Writing the script now.' }]),
    line('assistant', 'msg_1', [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }]),
    line('assistant', 'msg_1', [{ type: 'tool_use', name: 'Read', input: { file_path: '/a' } }]),
    line('user', undefined, [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }]),
    // Older versions: growing snapshots of the same reply.
    line('assistant', 'msg_2', [{ type: 'text', text: 'Part 4' }]),
    line('assistant', 'msg_2', [{ type: 'text', text: 'Part 4 works.' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]),
  ].join('\n') + '\n');
  const m = await messages({ engine: 'claude', path, sessionId: 'x', all: true });
  assert.deepEqual(m.map((x) => [x.role, x.text, x.tools.map((t) => t.name)]), [
    ['user', 'make the video', []],
    ['assistant', 'Writing the script now.', ['Bash', 'Read']],
    ['assistant', 'Part 4 works.', ['Bash']],
  ]);
});
