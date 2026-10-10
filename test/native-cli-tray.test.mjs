import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'helm-native-cli-tray-'));
process.env.HELM_DIR = root;
process.env.HELM_NATIVE_SOCKET = join(root, 'native.sock');
process.env.HELM_NO_SERVICE = '1';
const { Sessions } = await import('../packages/connect/src/sessions.js');
const { Daemon } = await import('../packages/connect/src/agent.js');
const { createNetwork } = await import('@helm/protocol/network');
const { M } = await import('@helm/protocol');
const { primeModels } = await import('../packages/connect/src/models.js');
const { ENGINES } = await import('../packages/connect/src/engines.js');
const { nativeControls, nativeControlCommand } = await import('../packages/connect/src/native-controls.js');
createNetwork({name:'Test'});
const engines = Object.values(ENGINES).filter(e => e.bin && !e.plain).map(e => e.id);
let nextHost = 0;
class Host extends EventEmitter {
  writes = []; alive = true;
  constructor(engine) { super(); this.engine = engine; this.home = join(root,engine); primeModels(engine,this.home,null,{models:[]}); this.id = `native-${engine}-${++nextHost}`; }
  nativeSessions() { return [{id:this.id,engine:this.engine,configHome:this.home,cwd:root,createdAt:1}]; }
  has() { return this.alive; }
  async write(id, text) { this.writes.push(text); }
  detach() {}
}
test.after(() => rmSync(root,{recursive:true,force:true}));
for (const engine of engines) test(`${engine}: native tray targets the same terminal without claiming changes`, async () => {
  const host = new Host(engine), sessions = new Sessions(new EventEmitter(), {nativeHost:host,nativeDiscovery:false});
  try {
    const s = sessions.get(host.id);
    const daemon = new Daemon(); daemon.sessions = sessions;
    const catalog = await daemon.dispatch(M.MODEL_LIST, {id:s.id,profileId:'unrelated'});
    assert.deepEqual(catalog.nativeControls, nativeControls(engine));
    assert.ok(catalog.nativeControls.includes('settings'));
    assert.equal(catalog.default,null); assert.equal(catalog.defaultMode,null);
    assert.deepEqual(catalog.modes,[]); // headless auto-approval is not a native permission mode
    for (const kind of catalog.nativeControls) {
      host.writes = [];
      const result = await daemon.dispatch(M.SESSION_CONTROL, {id:s.id,kind});
      const command = nativeControlCommand(engine,kind);
      assert.equal(result.terminal,true);
      assert.deepEqual(host.writes, command == null ? [] : [`\x1b[200~${command}\x1b[201~`,'\r']);
      assert.equal(s.model,undefined); assert.equal(s.effort,undefined); assert.equal(s.mode,undefined);
    }
  } finally { await sessions.stop(); }
});
test('native controls refuse unknown kinds, busy, blocked, and exited sessions without sending bytes', async () => {
  const host = new Host('pi'), sessions = new Sessions(new EventEmitter(), {nativeHost:host,nativeDiscovery:false});
  try {
    const s = sessions.get(host.id);
    await assert.rejects(sessions.control(s.id,'mode'),/does not offer/);
    await assert.rejects(sessions.control(s.id,'model\rmalicious'),/does not offer/);
    s.status = 'working'; await assert.rejects(sessions.control(s.id,'model'),/finishes/);
    s.status = 'blocked'; await assert.rejects(sessions.control(s.id,'model'),/question/);
    s.status = 'idle'; host.alive = false; await assert.rejects(sessions.control(s.id,'model'),/no longer running/);
    assert.deepEqual(host.writes,[]);
  } finally { await sessions.stop(); }
});
test('native messages and picker commands keep each paste paired with its Enter', async () => {
  const host = new Host('pi'), sessions = new Sessions(new EventEmitter(), {nativeHost:host,nativeDiscovery:false});
  try {
    await Promise.all([sessions.input(host.id,'first\nline'),sessions.control(host.id,'model'),sessions.input(host.id,'second')]);
    assert.deepEqual(host.writes,['\x1b[200~first\nline\x1b[201~','\r','\x1b[200~/model\x1b[201~','\r','\x1b[200~second\x1b[201~','\r']);
    host.writes=[]; sessions.get(host.id).status='blocked';
    await sessions.input(host.id,'my answer');
    assert.deepEqual(host.writes,['\x1b[200~my answer\x1b[201~','\r']);
  } finally { await sessions.stop(); }
});

test('native model and effort choices write provider commands without inventing accepted settings', async () => {
  const host = new Host('pi'), sessions = new Sessions(new EventEmitter(), {nativeHost:host,nativeDiscovery:false});
  try {
    const s = sessions.get(host.id);
    s.engineModel='provider/old'; s.engineEffort='low';
    primeModels('pi',host.home,null,{models:['provider/old','provider/new'],default:'provider/new',effort:'high',efforts:['low','high']});
    const daemon = new Daemon(); daemon.sessions=sessions;
    const options = await daemon.dispatch(M.MODEL_LIST,{id:host.id});
    assert.deepEqual(options.models,['provider/old','provider/new']);
    assert.deepEqual(options.nativeControls,['settings']);
    assert.equal(options.default,null); assert.equal(options.effort,null);
    await sessions.setModel(host.id,'provider/new'); await sessions.setEffort(host.id,'high');
    assert.deepEqual(host.writes,['\x1b[200~/model provider/new\x1b[201~','\r','\x1b[200~/thinking high\x1b[201~','\r']);
    assert.equal(s.engineModel,'provider/old'); assert.equal(s.engineEffort,'low'); assert.equal(s.model,undefined);
    host.writes=[];
    await assert.rejects(sessions.setModel(host.id,'provider/new\n/exit'),/invalid/);
    s.status='working';await assert.rejects(sessions.setEffort(host.id,'high'),/finishes/);
    assert.deepEqual(host.writes,[]);
  } finally { await sessions.stop(); }
});
