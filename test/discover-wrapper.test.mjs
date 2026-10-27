import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverAliasProfiles, wrappedEngine } from '../packages/connect/src/discover.js';

const script = (body) => {
  const path = join(mkdtempSync(join(tmpdir(), 'helm-wrap-')), 'wrapper');
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
};

test('a profile script that execs agy through a variable is an agy account', () => {
  // The shape of agy-profile: `a1='agy-profile 1'` points HOME at a saved
  // login and execs agy - the alias alone says nothing about agy.
  const path = script(`#!/usr/bin/env bash
set -Eeuo pipefail
profile="\${1-}"
real_home="\${HOME:?HOME must be set}"
profile_home="$real_home/.config/google-cli-profiles/agy-$profile"
agy_bin="$real_home/.local/bin/agy"
if [[ ! -x "$agy_bin" ]]; then
  exit 1
fi
export HOME="$profile_home"
export GEMINI_FORCE_FILE_STORAGE=true
exec "$agy_bin" "$@"
`);
  assert.equal(wrappedEngine(path), 'agy');
});

test('a wrapper that sets variables on the exec line still names its engine', () => {
  assert.equal(wrappedEngine(script('#!/bin/sh\nexec env CODEX_HOME=/x codex "$@"\n')), 'codex');
  assert.equal(wrappedEngine(script('#!/bin/sh\nexec CLAUDE_CONFIG_DIR=/x claude "$@"\n')), 'claude');
});

test('scripts that launch no engine, and non-scripts, are not accounts', () => {
  assert.equal(wrappedEngine(script('#!/bin/sh\nexec ls "$@"\n')), null);
  assert.equal(wrappedEngine(script('#!/bin/sh\nagy models\n')), null);
  assert.equal(wrappedEngine(script('\x7fELF binary')), null);
  assert.equal(wrappedEngine('/definitely/not/here'), null);
});

test('every alias is looked up in one login shell, not one shell each', async () => {
  // A shell with hundreds of aliases started hundreds of login shells on
  // every daemon start: eight seconds of CPU before anything else.
  const dir = mkdtempSync(join(tmpdir(), 'helm-which-'));
  const calls = join(dir, 'calls');
  writeFileSync(join(dir, 'sh'), `#!/bin/bash\necho run >> '${calls}'\nexec /bin/sh "$@"\n`);
  chmodSync(join(dir, 'sh'), 0o755);
  writeFileSync(join(dir, 'my-claude'), '#!/bin/sh\nexec claude "$@"\n');
  chmodSync(join(dir, 'my-claude'), 0o755);
  const symbols = new Map(Array.from({ length: 20 }, (_, i) => [`a${i}`, { kind: 'alias', body: `tool${i} --x` }]));
  symbols.set('mine', { kind: 'alias', body: 'my-claude --fast' });
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try {
    const { profiles } = await discoverAliasProfiles(symbols, { claude: 'claude' });
    assert.deepEqual(profiles.map((p) => [p.id, p.engine, p.wraps, p.args]), [['mine', 'claude', 'claude', ['--fast']]]);
    assert.equal(readFileSync(calls, 'utf8').split('\n').filter(Boolean).length, 1);
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tool only the owner's terminal PATH reaches is found and keeps its full path", async () => {
  // opencode's installer adds ~/.opencode/bin in ~/.bashrc only, which a
  // login shell never reads, so OpenCode 2 never showed.
  const dir = mkdtempSync(join(tmpdir(), 'helm-term-'));
  writeFileSync(join(dir, 'my-opencode'), '#!/bin/sh\nexec opencode2 "$@"\n');
  chmodSync(join(dir, 'my-opencode'), 0o755);
  const symbols = new Map([
    ['mine', { kind: 'alias', body: 'my-opencode --x' }],
    ['O2', { kind: 'alias', body: 'opencode2' }],
  ]);
  try {
    const { profiles } = await discoverAliasProfiles(symbols, { opencode2: join(dir, 'opencode2') },
      { termPath: dir, far: new Map([['opencode2', join(dir, 'opencode2')]]) });
    assert.deepEqual(profiles.map((p) => [p.id, p.engine, p.cmd]), [
      ['mine', 'opencode2', join(dir, 'my-opencode')],
      ['O2', 'opencode2', join(dir, 'opencode2')],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
