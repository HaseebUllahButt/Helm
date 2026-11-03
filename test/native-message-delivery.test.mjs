import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeMessageDelivery } from '../packages/connect/src/session-subagents.js';

const request={actionId:'a'.repeat(32),id:'parent',agentId:'helper',data:'look again'};
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'helm-native-message-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let calls=0, release, entered; const started=new Promise(resolve=>{entered=resolve;});
  const pending=new Promise(resolve=>{release=resolve;});
  const sessions={messageNative:async()=>{calls++; entered(); await pending; return {ok:true};}};
  return {dir,sessions,started,release,calls:()=>calls,make:()=>new NativeMessageDelivery(sessions,{dir})};
}

test('lost replies and concurrent retries send one native helper message',async t=>{
  const f=fixture(t), d=f.make();
  const first=d.deliver(request,'phone'), second=d.deliver(request,'phone');
  await f.started; assert.equal(f.calls(),1); f.release();
  assert.equal((await first).state,'done'); assert.equal((await second).state,'done');
  const restarted=f.make();
  assert.equal((await restarted.deliver(request,'phone')).state,'done');
  assert.equal(f.calls(),1);
  await assert.rejects(restarted.deliver({...request,data:'other'},'phone'),{code:'delivery_conflict'});
  assert.equal(restarted.status(request.actionId,'other').state,'missing');
});

test('a crash during native delivery stays uncertain and does not resend',async t=>{
  const f=fixture(t), d=f.make(); const running=d.deliver(request,'phone');
  await f.started;
  assert.equal((await f.make().deliver(request,'phone')).state,'checking');
  assert.equal(f.calls(),1); f.release(); await running;
});

test('an invalid native message is refused before delivery',async t=>{
  const f=fixture(t), d=f.make();
  await assert.rejects(d.deliver({...request,actionId:'bad'},'phone'),{code:'invalid_argument'});
  await assert.rejects(d.deliver({...request,data:''},'phone'),{code:'invalid_argument'});
  assert.equal(f.calls(),0);
});

for (const scenario of ['missing chat','missing helper','messaging unavailable']) test(`${scenario} is a final failure before any helper send`, async t=>{
  const { SessionSubagents } = await import('../packages/connect/src/session-subagents.js');
  const dir=mkdtempSync(join(tmpdir(),'helm-native-preflight-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let sent=0;
  const session={id:'parent',engine:'codex',driver:'codex',nativeCards:scenario==='missing helper'?[]:[{id:'helper',canMessage:scenario!=='messaging unavailable'}]};
  const sessions={get:()=>{if(scenario==='missing chat')throw Error('No such chat.'); return session;}};
  const core={drivers:new Map([['parent',{messageSubagent:async()=>{sent++;}}]]),save(){}};
  const helpers=new SessionSubagents(sessions,core); helpers.refreshNative=async()=>{};
  sessions.messageNative=(...args)=>helpers.messageNative(...args);
  const delivery=new NativeMessageDelivery(sessions,{dir});
  const result=await delivery.deliver(request,'phone');
  assert.equal(result.state,'done');
  assert.ok(result.error?.message);
  assert.equal(sent,0);
  assert.equal((await delivery.deliver(request,'phone')).state,'done');
});

test('a provider error after sending starts remains uncertain',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'helm-native-uncertain-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let calls=0;
  const d=new NativeMessageDelivery({messageNative:async()=>{calls++;throw Error('reply lost');}},{dir});
  assert.equal((await d.deliver(request,'phone')).state,'checking');
  assert.equal((await d.deliver(request,'phone')).state,'checking');
  assert.equal(calls,1);
});
