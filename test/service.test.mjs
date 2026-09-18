import test from 'node:test';
import assert from 'node:assert/strict';
import { systemdArg } from '../packages/connect/src/service.js';

test('systemd service arguments preserve spaces and disable specifiers', () => {
  assert.equal(systemdArg('/home/a path/helm'), '"/home/a path/helm"');
  assert.equal(systemdArg('https://helm.example/%n'), '"https://helm.example/%%n"');
  assert.equal(systemdArg('a"b\\c'), '"a\\"b\\\\c"');
  assert.throws(() => systemdArg('one\ntwo'), /newlines/);
});
