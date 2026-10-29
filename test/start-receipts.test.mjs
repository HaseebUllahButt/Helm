import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StartReceipts } from '../packages/connect/src/start-receipts.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'helm-start-receipts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const records = new Map(); let count = 0;
  const sessions = {
    get: id => records.get(id),
    async start(p) { count++; const s = { id: p.reservedSessionId ?? 'legacy' }; records.set(s.id, s); return s; },
  };
  return { dir, sessions, records, count: () => count, make: () => new StartReceipts(sessions, dir) };
}
const params = { startId: 'a'.repeat(32), quick: true, profileId: 'fake' };

test('a dropped reply, concurrent retry and daemon restart return one chat', async t => {
  const f = fixture(t), first = f.make();
  const [a,b] = await Promise.all([first.start(params, 'owner'),first.start(params, 'owner')]);
  assert.equal(a.id,b.id);
  assert.equal((await f.make().start(params, 'owner')).id,a.id);
  assert.equal(f.count(),1);
  await assert.rejects(first.start({...params,profileId:'other'},'owner'),{code:'start_conflict'});
  assert.notEqual((await first.start(params,'other')).id,a.id);
  f.records.delete(a.id);
  assert.equal((await f.make().start(params,'owner')).id,a.id,'deletion never repeats setup');
});

test('a crash after saving the chat recovers it without a final receipt', async t => {
  const f=fixture(t);
  f.sessions.start=async p => { const s={id:p.reservedSessionId}; f.records.set(s.id,s); return new Promise(()=>{}); };
  void f.make().start(params,'owner');
  // Wait for the actual reserved record, not a timer.
  await Promise.resolve(); await Promise.resolve();
  const recovered=await f.make().start(params,'owner');
  assert.equal(recovered.id,[...f.records.keys()][0]);
});

test('a crash during setup keeps its reservation and stops duplicate setup', async t => {
  const f=fixture(t);
  f.sessions.start=async()=>new Promise(()=>{});
  void f.make().start(params,'owner');
  await assert.rejects(f.make().start(params,'owner'),{code:'start_uncertain'});
});

test('a damaged receipt blocks retry; old callers still work without IDs', async t => {
  const f=fixture(t);
  const {readdirSync}=await import('node:fs');
  await f.make().start(params,'owner');
  const path=join(f.dir,readdirSync(f.dir)[0]);
  writeFileSync(path,'broken');
  await assert.rejects(f.make().start(params,'owner'),SyntaxError);
  assert.equal((await f.make().start({quick:true})).id,'legacy');
});

test('a safe refusal retries the same reserved chat after its cause is fixed', async t => {
  const f=fixture(t), create=f.sessions.start; let fixed=false, attempts=0;
  f.sessions.start=async p => {
    attempts++;
    if (!fixed) throw Object.assign(new Error('Choose an available account.'),{startRetrySafe:true});
    return create(p);
  };
  await assert.rejects(f.make().start(params,'owner'),/available account/);
  fixed=true;
  const session=await f.make().start(params,'owner');
  assert.equal((await f.make().start(params,'owner')).id,session.id);
  assert.equal(attempts,2);
  assert.equal(f.count(),1);
});

test('a partial setup failure stays blocked even after its cause is fixed', async t => {
  const f=fixture(t); let attempts=0;
  f.sessions.start=async () => { attempts++; throw new Error('Setup stopped after creating a folder.'); };
  await assert.rejects(f.make().start(params,'owner'),/creating a folder/);
  f.sessions.start=async () => { attempts++; return {id:'duplicate'}; };
  await assert.rejects(f.make().start(params,'owner'),/creating a folder/);
  assert.equal(attempts,1);
});
