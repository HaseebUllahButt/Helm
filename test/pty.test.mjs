import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A terminal con owns, against a real shell: bytes go in and come back, the
// program is told how big the viewer is, output only travels while somebody
// is watching, and a reconnecting viewer is replayed rather than left blank.
process.env.CON_DIR = mkdtempSync(join(tmpdir(), 'con-pty-'));
process.env.CON_NO_SERVICE = '1';

const { Terminals, loadPty } = await import('../packages/connect/src/pty.js');

const has = !!(await loadPty());
const opts = { skip: has ? false : 'no pty addon built for this Node' };

/**
 * A registry that is always torn down, even when the test fails - a shell
 * left running holds the event loop open and the run never ends.
 */
function terminals(t) {
  const terms = new Terminals();
  const seen = [];
  terms.on('data', (d) => seen.push(d.text));
  t.after(() => terms.closeAll());
  return { terms, seen, text: () => seen.join('') };
}

/** Wait for a predicate, or give up. */
async function until(fn, ms = 5000) {
  const stop = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > stop) throw new Error('timed out waiting for the terminal');
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('a terminal echoes what is typed and replays it to a later viewer', opts, async (t) => {
  const { terms, text } = terminals(t);

  await terms.open('t1', { cwd: process.env.CON_DIR });
  terms.view('t1', { cols: 100, rows: 30 });

  terms.write('t1', 'echo con-was-here\r');
  await until(() => text().includes('con-was-here'));

  // A viewer that arrives later gets the scrollback, not an empty screen.
  assert.match(terms.view('t1'), /con-was-here/);
});

test('the program is told the size the viewer is drawing at', opts, async (t) => {
  const { terms, text } = terminals(t);

  await terms.open('t2', { cwd: process.env.CON_DIR });
  terms.view('t2', { cols: 100, rows: 30 });
  terms.resize('t2', 132, 44);

  // `tput cols` asks the terminal itself, so this is the pty's own idea of
  // its width rather than an environment variable we set.
  terms.write('t2', 'tput cols\r');
  await until(() => /(^|\D)132(\D|$)/.test(text().split('tput cols').pop() ?? ''));
});

test('output does not travel to a viewer that has gone away', opts, async (t) => {
  const { terms, seen, text } = terminals(t);

  await terms.open('t3', { cwd: process.env.CON_DIR });
  terms.view('t3');
  terms.write('t3', 'echo watching\r');
  await until(() => text().includes('watching'));

  terms.unview('t3');
  seen.length = 0;
  terms.write('t3', 'echo unwatched\r');
  // The shell still runs it - the scrollback keeps it, which is what a later
  // viewer is replayed - but nothing is pushed to a phone that has gone.
  await until(() => terms.scrollback('t3').includes('unwatched'));
  assert.equal(text().includes('unwatched'), false);
});

test('closing a terminal ends its shell and forgets it', opts, async (t) => {
  const { terms } = terminals(t);
  await terms.open('t4', { cwd: process.env.CON_DIR });
  assert.equal(terms.has('t4'), true);
  terms.close('t4');
  assert.equal(terms.has('t4'), false);
  assert.throws(() => terms.write('t4', 'x'), /ended/);
});

test.after(() => rmSync(process.env.CON_DIR, { recursive: true, force: true }));
