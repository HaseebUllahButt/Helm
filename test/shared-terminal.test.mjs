import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Terminals, loadPty } from '../packages/connect/src/pty.js';
import { claudeLiveStatus, descendsFrom } from '../packages/connect/src/external-process.js';

const pty = await loadPty();

/** Each line typed prints the size the program is drawing at. */
async function sizer(context) {
  const terminals = new Terminals();
  context.after(() => terminals.closeAll());
  let out = '';
  terminals.on('data', ({ text }) => { out += text; });
  await terminals.open('t', { cmd: '/bin/sh', args: ['-c', 'while read l; do stty size; done'], cols: 100, rows: 30 });
  const sizeAfter = async (viewer) => {
    out = '';
    terminals.write('t', '\n', viewer);
    for (let i = 0; i < 100 && !/\d+ \d+/.test(out); i++) await new Promise((r) => setTimeout(r, 20));
    return out.match(/(\d+) (\d+)/)?.slice(1).map(Number).reverse();
  };
  return { terminals, sizeAfter };
}

test('a phone looking at a shared CLI does not shrink the laptop; typing takes the size', { skip: !pty && 'no pty' }, async (context) => {
  const { terminals, sizeAfter } = await sizer(context);
  terminals.view('t', { cols: 100, rows: 30, viewer: 'laptop', persistent: true });
  terminals.view('t', { cols: 40, rows: 10, viewer: 'phone' });
  terminals.resize('t', 41, 11, 'phone');
  assert.deepEqual(await sizeAfter('laptop'), [100, 30]);
  assert.deepEqual(await sizeAfter('phone'), [41, 11]);
  assert.deepEqual(await sizeAfter('laptop'), [100, 30]);
  // The phone leaving hands the size back without anyone typing.
  terminals.write('t', '', 'phone');
  terminals.unview('t', 'phone');
  assert.deepEqual(await sizeAfter('nobody'), [100, 30]);
});

test('an unwatched terminal reports how long it has been quiet', { skip: !pty && 'no pty' }, async (context) => {
  const { terminals } = await sizer(context);
  terminals.view('t', { cols: 80, rows: 24, viewer: 'laptop', persistent: true });
  assert.equal(terminals.unwatchedQuiet('t'), 0);
  terminals.unview('t', 'laptop');
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(terminals.unwatchedQuiet('t') >= 20);
});

test('closing a terminal reports its end exactly once', { skip: !pty && 'no pty' }, async (context) => {
  const { terminals } = await sizer(context);
  const ends = [];
  terminals.on('exit', (e) => ends.push(e.id));
  terminals.close('t');
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(ends, ['t']);
});

test('Claude waiting on a permission or question reads as needing you', () => {
  assert.equal(claudeLiveStatus([{ status: 'waiting' }]), 'blocked');
  assert.equal(claudeLiveStatus([{ status: 'busy' }]), 'working');
  assert.equal(claudeLiveStatus([{ status: 'idle' }]), 'idle');
});

test('a CLI behind a launcher is matched through its process family', () => {
  assert.equal(descendsFrom(process.pid, process.ppid), true);
  assert.equal(descendsFrom(process.ppid, process.pid), false);
});
