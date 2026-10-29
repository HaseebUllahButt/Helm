import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createReplayBuffer } from '../packages/connect/src/replay-buffer.js';

// A terminal helm owns, against a real shell: bytes go in and come back, the
// program is told how big the viewer is, output only travels while somebody
// is watching, and a reconnecting viewer is replayed rather than left blank.
process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-pty-'));
process.env.HELM_NO_SERVICE = '1';

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

  await terms.open('t1', { cwd: process.env.HELM_DIR });
  terms.view('t1', { cols: 100, rows: 30 });

  terms.write('t1', 'echo helm-was-here\r');
  await until(() => text().includes('helm-was-here'));

  // A viewer that arrives later gets the scrollback, not an empty screen.
  assert.match(terms.view('t1'), /helm-was-here/);
});

test('the program is told the size the viewer is drawing at', opts, async (t) => {
  const { terms, text } = terminals(t);

  await terms.open('t2', { cwd: process.env.HELM_DIR });
  terms.view('t2', { cols: 100, rows: 30 });
  terms.resize('t2', 132, 44);

  // `tput cols` asks the terminal itself, so this is the pty's own idea of
  // its width rather than an environment variable we set.
  terms.write('t2', 'tput cols\r');
  await until(() => /(^|\D)132(\D|$)/.test(text().split('tput cols').pop() ?? ''));
});

test('output does not travel to a viewer that has gone away', opts, async (t) => {
  const { terms, seen, text } = terminals(t);

  await terms.open('t3', { cwd: process.env.HELM_DIR });
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
  await terms.open('t4', { cwd: process.env.HELM_DIR });
  assert.equal(terms.has('t4'), true);
  terms.close('t4');
  assert.equal(terms.has('t4'), false);
  assert.throws(() => terms.write('t4', 'x'), /ended/);
});

test('a connected native client keeps output after a lease gap while a disconnected viewer receives none', opts, async t => {
  const {terms,text,seen}=terminals(t);
  await terms.open('persistent',{cwd:process.env.HELM_DIR});
  terms.view('persistent',{viewer:'laptop',persistent:true});
  terms.view('persistent',{viewer:'phone'});
  const now = Date.now;
  Date.now=()=>now()+120000;
  try {
    terms.renew('persistent','laptop');
    terms.write('persistent','echo after-lease-gap\r');
    await until(()=>text().includes('after-lease-gap'));
    terms.unview('persistent','laptop');
    seen.length=0;
    terms.write('persistent','echo no-live-viewer\r');
    await until(()=>terms.scrollback('persistent').includes('no-live-viewer'));
    assert.equal(text().includes('no-live-viewer'),false);
  } finally { Date.now=now; }
});

test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));


// Drive the real host logic even when this Node has no native PTY addon.
function fakeTerminal(t) {
  let output;
  const child = { pid: 1, onData(fn) { output = fn; }, onExit() {}, resize() {}, kill() {} };
  const source = readFileSync(new URL('../packages/connect/src/pty.js', import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '').replace(/export /g, '').replace('let ptyModule;', 'let ptyModule = suppliedPty;');
  const Host = new Function('suppliedPty', 'EventEmitter', 'createReplayBuffer', 'homedir', source + '; return Terminals;')(
    { spawn: () => child }, EventEmitter, createReplayBuffer, () => '/unused');
  const terms = new Host();
  t.after(() => terms.closeAll());
  return { terms, output: text => output(text) };
}

test('terminal snapshots and streamed multibyte text share UTF-16 positions', async t => {
  const { terms, output } = fakeTerminal(t);
  await terms.open('positions');
  terms.snapshot('positions');
  const pieces = [];
  terms.on('data', piece => pieces.push(piece));
  output('🙂é中');
  assert.equal(pieces[0].position, 4);
  assert.equal(pieces[0].position, pieces[0].text.length);
  // A pending stream chunk can be present in the snapshot before its push.
  output('tail');
  const snapshot = terms.snapshot('positions');
  assert.deepEqual(snapshot, { text: '🙂é中tail', position: 8 });
  terms.close('positions'); // flush is unnecessary: snapshot already contains it
});

test('a renewed expired terminal needs a snapshot to recover its missing output', async t => {
  const { terms, output } = fakeTerminal(t);
  await terms.open('expired');
  terms.view('expired');
  const pieces = [];
  terms.on('data', piece => pieces.push(piece));
  output('visible');
  const now = Date.now;
  t.mock.method(Date, 'now', () => now() + 61000);
  output('missed-🙂é中');
  assert.equal(pieces.length, 1);
  terms.renew('expired');
  assert.equal(pieces.length, 1);
  assert.deepEqual(terms.snapshot('expired'), { text: 'visiblemissed-🙂é中', position: 18 });
});
