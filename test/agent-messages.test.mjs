import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'helm-agent-messages-'));
Object.assign(process.env, { HELM_DIR: root, HELM_DB: join(root,'db'), HELM_SSH_DIR: join(root,'ssh'),
  HELM_PROCS_SOCKET: join(root,'procs'), HELM_NATIVE_SOCKET: join(root,'native'), HELM_TERMINALS_SOCKET: join(root,'terms'), HELM_NO_SERVICE:'1' });
test.after(() => rmSync(root,{recursive:true,force:true}));
const { AgentMessages } = await import('../packages/connect/src/agent-messages.js');
const { InputDelivery } = await import('../packages/connect/src/input-delivery.js');
const { runMessageCommand } = await import('../packages/connect/src/agent-message-cli.js');
const mid = n => n.toString(16).padStart(32,'0');
function setup(t) {
  const dir = mkdtempSync(join(root,'case-')), sent=[], updates=[];
  const rows=new Map(['parent','one','two','other'].map(id=>[id,{id,title:id,driver:'claude',engine:'claude',model:'opus',status:'idle',
    ...(id==='one'||id==='two'?{delegation:{parentId:'parent'}}:{})}]));
  const sessions={ get:id=>{if(!rows.has(id))throw Error('No such chat');return rows.get(id);},list:async()=>[...rows.values()],
    turnState:()=>null, input:async(id,text,options)=>{sent.push({id,text,options});return {ok:true};} };
  const delivery=new InputDelivery(sessions,{dir:join(dir,'delivery')});
  const make=()=>new AgentMessages({sessions,delivery,self:'local',dir:join(dir,'messages'),rpc:()=>assert.fail('unexpected remote'),emit:p=>updates.push(p)});
  return {service:make(),make,dir,rows,sent,updates,sessions,delivery};
}
test('siblings exchange short named messages and replies; parent sees each once, unrelated chats see none',async t=>{
  const f=setup(t);
  await f.service.send({id:'one',to:{env:'local',id:'two'},text:'Does the test pass?',messageId:mid(1)});
  await f.service.send({id:'two',replyTo:mid(1),text:'Yes, 14 passed.',messageId:mid(2)});
  assert.equal(f.sent.length,2);
  assert.match(f.sent[0].text,/From claude agent one/);
  assert.match(f.sent[0].text,new RegExp(`helm reply ${mid(1)}`));
  assert.equal(f.sent[0].options.delivery,'queue');
  assert.equal(f.sent[0].options.source,'agent');
  assert.match(f.sent[1].text,/Reply to/);
  const listing=await f.service.list('parent');
  assert.equal(listing.messages.length,2);
  assert.equal(listing.messages[0].replyTo,mid(1));
  assert.equal((await f.service.list('other')).messages.length,0);
  assert.equal((await f.make().list('parent')).messages.length,2,'survives daemon restart');
  assert.ok(f.updates.every(p=>!('text' in p)),'broadcasts carry no message body');
});
test('concurrent and restarted retries deliver once and reject a changed message',async t=>{
  const f=setup(t), request={id:'one',to:{env:'local',id:'two'},text:'Please check.',messageId:mid(1)};
  await Promise.all([f.service.send(request),f.service.send(request)]);
  await f.make().send(request);
  assert.equal(f.sent.length,1);
  await assert.rejects(f.service.send({...request,text:'Changed'}),{code:'delivery_conflict'});
});
test('rejects wrong reply author, wrong native caller, terminals, stopped recipients and self-messages',async t=>{
  const f=setup(t);
  await f.service.send({id:'one',to:{env:'local',id:'two'},text:'Question',messageId:mid(1)});
  await assert.rejects(f.service.send({id:'other',replyTo:mid(1),text:'Reply',messageId:mid(2)}),/received by/);
  assert.throws(()=>f.service.address('one','wrong-native-thread'),/does not match/);
  await assert.rejects(f.service.send({id:'one',to:{env:'local',id:'one'},text:'Loop',messageId:mid(3)}),/another agent/);
  f.rows.get('two').stoppedAt=Date.now();
  await assert.rejects(f.service.send({id:'one',to:{env:'local',id:'two'},text:'Wake',messageId:mid(4)}),/not woken/);
  assert.equal(f.sent.length,1);
  f.rows.get('other').driver=null;
  assert.throws(()=>f.service.address('other'),/managed by Helm/);
});
test('owner follow-ups are attributed to the owner, and are allowed to resume their helper',async t=>{
  const f=setup(t);f.rows.get('one').stoppedAt=Date.now();
  await f.service.send({id:'parent',to:{env:'local',id:'one'},text:'Continue please',messageId:mid(1),asUser:true});
  assert.match(f.sent[0].text,/From the owner/);
  assert.equal(f.sent[0].options.source,undefined,'user is the normal reliable-input path');
  assert.doesNotMatch(f.sent[0].text,/helm reply/);
});
test('page through saved exchanges without losing earlier messages',async t=>{
  const f=setup(t);
  for(let n=1;n<=4;n++)await f.service.send({id:'one',to:{env:'local',id:'two'},text:`Question ${n}`,messageId:mid(n)});
  const a=await f.service.list('parent',{limit:2}),b=await f.service.list('parent',{before:a.next,limit:2});
  assert.equal(a.messages.length,2);assert.equal(b.messages.length,2);assert.equal(b.next,null);
  assert.equal(new Set([...a.messages,...b.messages].map(m=>m.id)).size,4);
});
test('remote acknowledgement loss is visible; retry finds the recipient receipt without delivering twice',async t=>{
  const f=setup(t),g=setup(t);let drop=true;
  const remote=new AgentMessages({sessions:g.sessions,delivery:g.delivery,self:'remote',dir:join(g.dir,'remote'),rpc:()=>{}});
  const source=new AgentMessages({sessions:f.sessions,delivery:f.delivery,self:'local',dir:join(f.dir,'source'),rpc:async(env,method,p)=>{
    if(method==='session.agent-address')return {address:remote.address(p.id)};
    const r=await remote.receive(p.message,'local');if(drop){drop=false;throw Object.assign(Error('Connection lost'),{code:'disconnected'});}return r;
  }});
  const p={id:'one',to:{env:'remote',id:'two'},text:'Question over network',messageId:mid(1)};
  await assert.rejects(source.send(p),/same message ID/);
  assert.equal((await source.list('one')).messages[0].status,'unconfirmed');
  await source.send(p);assert.equal(g.sent.length,1);
  assert.equal((await source.list('one')).messages[0].status,'delivered');
  await assert.rejects(remote.receive({...((await source.list('one')).messages[0]),id:mid(2)},'wrong-machine'),/Invalid/);
});
test('CLI say names its actual sender and reply routes by message ID',async()=>{
  const calls=[],lines=[];
  const deps={self:'local',senderId:'one',callerThreadId:undefined,findSession:async()=>({env:'remote',session:{id:'two'}}),
    rpc:async(env,method,p)=>{calls.push({env,method,p});return {message:{to:{title:'Reviewer'}}};},write:s=>lines.push(s)};
  await runMessageCommand('say',['two','--message-id',mid(1),'--','a --literal question'],deps);
  assert.deepEqual(calls[0].p.to,{env:'remote',id:'two'});assert.equal(calls[0].p.id,'one');assert.equal(calls[0].p.text,'a --literal question');
  await runMessageCommand('reply',[mid(1),'--','Answer'],deps);
  assert.equal(calls[1].p.replyTo,mid(1));assert.equal(calls[1].p.to,undefined);
});


test('different payloads cannot share an in-flight message ID before its record is saved',async t=>{
  const f=setup(t),p={id:'one',to:{env:'local',id:'two'},text:'Original',messageId:mid(1)};
  const sending=f.service.send(p);
  await assert.rejects(f.service.send({...p,text:'Different'}),{code:'delivery_conflict'});
  await sending;assert.equal(f.sent.length,1);
});
