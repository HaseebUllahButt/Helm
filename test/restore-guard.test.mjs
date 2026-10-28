import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { REVIEW_FILE } from '../packages/connect/src/restore-guard.js';

test('restored data blocks service and standalone agent before replay or a network connection', t => {
  const root = mkdtempSync(join(tmpdir(), 'helm-restored-start-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, REVIEW_FILE), '{"blocked":true}');
  const script = `
    const { up } = await import(${JSON.stringify(resolve('packages/connect/src/serve.js'))});
    const { Daemon } = await import(${JSON.stringify(resolve('packages/connect/src/agent.js'))});
    try { await up({ port: 0, host: '127.0.0.1' }); throw new Error('started'); }
    catch (error) { if (!error.message.includes('blocked for review')) throw error; }
    try { new Daemon(); throw new Error('started'); }
    catch (error) { if (!error.message.includes('blocked for review')) throw error; }
    console.log('blocked before startup');
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HELM_DIR: root, HELM_DB: join(root, 'hub.sqlite'), HELM_NO_SERVICE: '1', HELM_NO_UPDATE: '1' }, encoding: 'utf8', timeout: 15000,
  });
  assert.match(output, /blocked before startup/);
  assert.deepEqual(readdirSync(root), [REVIEW_FILE]);
});
