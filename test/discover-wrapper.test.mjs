import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrappedEngine } from '../packages/connect/src/discover.js';

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
