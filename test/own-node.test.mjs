import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ownNode } from '../packages/connect/src/own-node.js';

test('Helm starts its own programs through a link to Node that is not named node', { skip: process.platform !== 'linux' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-own-node-'));
  try {
    const link = ownNode({ dir });
    assert.equal(link, join(dir, 'helm-node'));
    assert.notEqual(basename(link), 'node');
    assert.equal(readlinkSync(link), process.execPath);
    // It is Node: the program starts under the link's name and runs.
    const out = execFileSync(link, ['-p', 'process.argv0 + " " + (1 + 1)'], { encoding: 'utf8' }).trim();
    assert.equal(out, `${link} 2`);
    // Node moved since (a version switch): the link follows the Node running now.
    assert.equal(ownNode({ dir, node: '/somewhere/else/node' }), link);
    assert.equal(readlinkSync(link), '/somewhere/else/node');
    assert.equal(ownNode({ dir }), link);
    assert.equal(readlinkSync(link), process.execPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('where the link cannot be made, plain Node still starts the program', { skip: process.platform !== 'linux' }, () => {
  assert.equal(ownNode({ dir: '/proc/helm-cannot-write-here' }), process.execPath);
});
