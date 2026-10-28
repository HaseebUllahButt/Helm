import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('backup commands create a private key and restore receipts without starting work', t => {
  const root=mkdtempSync(join(tmpdir(),'helm-backup-cli-')); t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=join(root,'source'); mkdirSync(source);
  writeFileSync(join(source,'network.json'),JSON.stringify({revoked:{removed:1}}));
  writeFileSync(join(source,'receipt.json'),'completed');
  const key=join(root,'key'), archive=join(root,'backup'), restored=join(root,'restored');
  const run=(...args)=>execFileSync(process.execPath,['packages/connect/bin/helm.js','backup',...args],{
    env:{...process.env,HELM_DIR:join(root,'private'),HELM_NO_SERVICE:'1',HELM_NO_UPDATE:'1'},encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const output=run('key',key); assert.equal(readFileSync(key).length,32);
  assert.doesNotMatch(output,/[a-f0-9]{64}/);
  if(process.platform!=='win32') assert.equal(statSync(key).mode&0o777,0o600);
  assert.throws(()=>run('key',key));
  assert.throws(()=>run('create',source,archive,'--key-file',key));
  run('create',source,archive,'--key-file',key,'--offline');
  assert.doesNotMatch(readFileSync(archive).toString(),/completed|removed/);
  assert.match(run('restore',archive,restored,'--key-file',key),/Startup is blocked/);
  assert.equal(readFileSync(join(restored,'data','receipt.json'),'utf8'),'completed');
  assert.deepEqual(JSON.parse(readFileSync(join(restored,'data','network.json'))).revoked,{removed:1});
  assert.throws(()=>run('restore',archive,restored,'--key-file',key));
});
