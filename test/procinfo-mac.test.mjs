import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The macOS half of process inspection, run here against stand-ins that
 * print exactly what macOS ps and lsof print for these questions.
 */
const bin = mkdtempSync(join(tmpdir(), 'helm-mac-tools-'));
writeFileSync(join(bin, 'ps'), `#!/bin/sh
case "$*" in
  "-axww -o pid=,command=") printf '  101 /usr/local/bin/claude --model opus\\n  202 /bin/zsh -l\\n' ;;
  "-ww -o command= -p 101") echo "/usr/local/bin/claude --model opus" ;;
  "-o lstart= -p 101") echo "Tue Oct  6 14:09:42 2026" ;;
  "-o ppid= -p 101") echo "  202" ;;
  "-o tty= -p 101") echo "ttys003" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
writeFileSync(join(bin, 'lsof'), `#!/bin/sh
case "$*" in
  *"-p 101 -d cwd -Fn"*) printf 'p101\\nfcwd\\nn/Users/me/project\\n' ;;
  *"-F pan -p 101"*) printf 'p101\\nf3\\naw\\nn/Users/me/.claude/projects/x/abc.jsonl\\nf4\\nar\\nn/Users/me/notes.jsonl\\n' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.HELM_TEST_PLATFORM = 'darwin';
const p = await import('../packages/connect/src/procinfo.js');
test.after(() => rmSync(bin, { recursive: true, force: true }));

test('on macOS a running CLI is found by its command, folder, start time, parent and terminal', () => {
  assert.deepEqual(p.processList(), [
    { pid: 101, argv: ['/usr/local/bin/claude', '--model', 'opus'] },
    { pid: 202, argv: ['/bin/zsh', '-l'] }]);
  assert.deepEqual(p.processArgv(101), ['/usr/local/bin/claude', '--model', 'opus']);
  assert.equal(p.processCwd(101), '/Users/me/project');
  // The same text Claude Code records as procStart on a Mac.
  assert.equal(p.processStart(101), 'Tue Oct  6 14:09:42 2026');
  assert.equal(p.parentOf(101), 202);
  assert.equal(p.processTty(101), '/dev/ttys003');
});

test('on macOS the conversation file a CLI is writing is told apart from one it only reads', () => {
  assert.deepEqual(p.openFiles([101], (path) => path.endsWith('.jsonl')), [
    { pid: 101, path: '/Users/me/.claude/projects/x/abc.jsonl', write: true },
    { pid: 101, path: '/Users/me/notes.jsonl', write: false }]);
  assert.equal(p.processCwd(999), null, 'a process that is gone is simply unknown');
});
