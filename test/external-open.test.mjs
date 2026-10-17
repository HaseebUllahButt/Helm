import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { externalFixtures } from './helpers/external-fixtures.mjs';

const root = mkdtempSync(join(tmpdir(), 'helm-external-open-'));
Object.assign(process.env, {
  HOME: join(root, 'home'), HELM_DIR: join(root, 'helm'), HELM_DB: join(root, 'helm.db'),
  HELM_SSH_DIR: join(root, 'ssh'), HELM_NATIVE_SOCKET: join(root, 'native.sock'),
  HELM_PROC_SOCKET: join(root, 'proc.sock'), HELM_TERMINAL_SOCKET: join(root, 'terminal.sock'),
  HELM_NO_SERVICE: '1', XDG_DATA_HOME: join(root, 'home', '.local', 'share'),
});
mkdirSync(process.env.HELM_DIR);
const { profiles, rows } = externalFixtures(root);
writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({ version: 1, profiles }));
const { Sessions } = await import('../packages/connect/src/sessions.js');
class Runtime extends EventEmitter { async listLive() { return new Map(); } watch() {} }
class Driver extends EventEmitter {
  constructor(options) { super(); Object.assign(this, options); this.status = 'idle'; }
  async send(text) { this.sent = text; }
  kill() {}
}
test.after(() => rmSync(root, { recursive: true, force: true }));

for (const row of rows) test(`${row.engine}: saved outside history opens with the managed tray, then continues the same conversation`, async () => {
  let driver;
  const sessions = new Sessions(new Runtime(), { makeDriver: (_engine, options) => (driver = new Driver(options)) });
  try {
    const opened = await sessions.resumeExternal({ engine: row.engine, account: row.engine, id: row.id });
    assert.equal(opened.driver, row.engine, 'opening chooses the managed chat screen');
    assert.equal(driver, undefined, 'reading history never starts a provider');
    const events = sessions.history(opened.id).events;
    assert.ok(events.some(e => e.type === 'turn.start' && e.text === row.user));
    assert.ok(events.some(e => e.type === 'item.delta' && e.text === row.answer));
    await sessions.setModel(opened.id, 'model-b');
    await sessions.setEffort(opened.id, 'low');
    assert.equal(driver, undefined, 'tray choices are saved for the next message');
    await sessions.input(opened.id, 'next step');
    assert.equal(driver.engineSessionId, row.id);
    assert.equal(driver.model, 'model-b');
    assert.equal(driver.effort, 'low');
    assert.equal(driver.sent, 'next step');
    assert.equal((await sessions.resumeExternal({ engine: row.engine, account: row.engine, id: row.id })).id, opened.id);
  } finally { await sessions.stop(); }
});

test('outside histories saved by an older Helm regain the tray and their messages after restart', async () => {
  const row = rows[0];
  const id = 'old-saved-external';
  writeFileSync(join(process.env.HELM_DIR, 'sessions.json'), JSON.stringify({ sessions: [{
    id, engine: row.engine, engineSessionId: row.id, profileId: row.engine,
    cwd: row.cwd, transcript: row.path, external: true, externalSource: true, status: 'idle',
  }] }));
  const sessions = new Sessions(new Runtime(), { makeDriver: () => { throw Error('must stay read-only'); } });
  try {
    assert.equal(sessions.get(id).driver, row.engine);
    await sessions.prepareHistory(id);
    assert.ok(sessions.history(id).events.some(e => e.text === row.answer));
    const last = sessions.history(id).last;
    await sessions.prepareHistory(id);
    assert.equal(sessions.history(id).last, last, 'refresh does not duplicate history');
    assert.ok(readFileSync(row.path, 'utf8').includes(row.answer), 'outside history remains intact');
  } finally { await sessions.stop(); }
});
