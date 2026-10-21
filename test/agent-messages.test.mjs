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
  const dir = mkdtempSync(join(root,'case-')), sent=[], updates=[], queued=new Map();
  const rows=new Map(['parent','one','two','other'].map(id=>[id,{id,title:id,driver:'claude',engine:'claude',model:'opus',status:'idle',
    ...(id==='one'||id==='two'?{delegation:{parentId:'parent'}}:{})}]));
  const sessions={ get:id=>{if(!rows.has(id))throw Error('No such chat');return rows.get(id);},list:async()=>[...rows.values()],
    turnState:()=>null, input:async(id,text,options)=>{sent.push({id,text,options});queued.set(options.turnId,{id,text});return {ok:true};},
    dequeue:(id,turnId)=>({ok:true,found:queued.get(turnId)?.id===id && queued.delete(turnId)}) };
  const delivery=new InputDelivery(sessions,{dir:join(dir,'delivery')});
  const make=()=>new AgentMessages({sessions,delivery,self:'local',dir:join(dir,'messages'),rpc:()=>assert.fail('unexpected remote'),emit:p=>updates.push(p)});
  return {service:make(),make,dir,rows,sent,updates,sessions,delivery,queued};
}
test('siblings exchange short named messages and replies; parent sees each once, unrelated chats see none',async t=>{
  const f=setup(t);
  await f.service.send({id:'one',to:{env:'local',id:'two'},text:'Does the test pass?',messageId:mid(1)});
  await f.service.send({id:'two',replyTo:mid(1),text:'Yes, 14 passed.',messageId:mid(2)});
  assert.equal(f.sent.length,2);
  assert.match(f.sent[0].text,/From claude agent one/);
  assert.match(f.sent[0].text,new RegExp(`helm reply ${mid(1)}`));
  assert.equal(f.sent[0].options.delivery,'auto');
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

test('reading the inbox clears only returned incoming agent tickets, not history reads or owner prompts',async t=>{
  const f=setup(t);
  for(let n=1;n<=5;n++)await f.service.send({id:'one',to:{env:'local',id:'parent'},text:`Update ${n}`,messageId:mid(n)});
  await f.service.send({id:'parent',to:{env:'local',id:'one'},text:'Owner followup',messageId:mid(6),asUser:true});
  await f.service.list('parent');
  assert.equal(f.queued.size,6,'the Agents panel does not consume input');
  await assert.rejects(f.service.list('parent',{consume:true,callerThreadId:'wrong'}),/does not match/);
  const page=await f.service.list('parent',{consume:true,limit:2});
  assert.equal(f.queued.size,5,'only one incoming message in this page; owner input stays');
  assert.equal(page.messages.filter(m=>m.readAt).length,1);
  await f.make().list('parent',{consume:true});
  assert.equal(f.queued.size,1);
  await f.make().send({id:'one',to:{env:'local',id:'parent'},text:'Update 1',messageId:mid(1)});
  assert.equal(f.queued.size,1,'an acknowledged ticket is not requeued after restart');
});

test('collecting a helper result returns every unread reply and removes its queued copies once',async t=>{
  const f=setup(t);
  for(let n=1;n<=55;n++)await f.service.send({id:'one',to:{env:'local',id:'parent'},text:`Update ${n}`,messageId:mid(n)});
  await f.service.send({id:'two',to:{env:'local',id:'parent'},text:'Unrelated progress',messageId:mid(60)});
  assert.deepEqual(await f.service.collectResult({id:'one',parentId:'parent'}),[]);
  const messages=await f.service.collectResult({id:'one',parentId:'parent',consume:true});
  assert.equal(messages.length,55,'no silent loss at the history page boundary');
  assert.equal(messages[0].text,'Update 1');assert.equal(messages.at(-1).text,'Update 55');
  assert.equal(f.queued.size,1,'other helpers remain queued');
  assert.deepEqual(await f.make().collectResult({id:'one',parentId:'parent',consume:true}),[]);
  assert.equal((await f.service.list('parent')).messages.length,30,'history is preserved');
  f.rows.get('parent').stopGeneration=1;
  assert.deepEqual(await f.service.collectResult({id:'two',parentId:'parent',consume:true}),[]);
  assert.equal(f.queued.size,1,'stale result collectors cannot clear new work');
});

test('identical replies with new IDs deliver once, while changed answers and different questions survive',async t=>{
  const f=setup(t);
  await f.service.send({id:'parent',to:{env:'local',id:'one'},text:'Status?',messageId:mid(1)});
  const reply={id:'one',replyTo:mid(1),text:'All checks passed.'};
  const results=await Promise.all([2,3,4,5,6].map(n=>f.service.send({...reply,messageId:mid(n)})));
  assert.equal(f.sent.length,2,'one question and one reply');
  assert.equal(new Set(results.map(r=>r.message.id)).size,1);
  assert.equal((await f.make().send({...reply,messageId:mid(7)})).duplicate,true);
  await f.service.send({...reply,text:'One check now fails.',messageId:mid(8)});
  await f.service.send({id:'parent',to:{env:'local',id:'one'},text:'Status?',messageId:mid(9)});
  await f.service.send({...reply,replyTo:mid(9),messageId:mid(10)});
  assert.equal(f.sent.length,5);
});

test('CLI inbox reads acknowledge only its own chat, with the native caller identity',async()=>{
  const calls=[];
  const deps={self:'local',senderId:'parent',callerThreadId:'native-thread',findSession:async()=>({env:'remote',session:{id:'other'}}),
    rpc:async(env,method,p)=>{calls.push({env,method,p});return {messages:[]};},write:()=>{}};
  await runMessageCommand('messages',['--json'],deps);
  assert.deepEqual(calls[0].p,{id:'parent',consume:true,callerThreadId:'native-thread'});
  await runMessageCommand('messages',['other','--json'],deps);
  assert.deepEqual(calls[1].p,{id:'other'});
});

test('a reply retried with a fresh ID after a lost remote acknowledgement reuses the original delivery',async t=>{
 const f=setup(t),g=setup(t);let loseReply=true;
 const local=new AgentMessages({sessions:f.sessions,delivery:f.delivery,self:'local',dir:join(f.dir,'local'),rpc:async(_env,method,p)=>method==='session.agent-address'?{address:remote.address(p.id)}:remote.receive(p.message,'local')});
 const remote=new AgentMessages({sessions:g.sessions,delivery:g.delivery,self:'remote',dir:join(g.dir,'remote'),rpc:async(_env,method,p)=>{
  if(method==='session.agent-address')return {address:local.address(p.id)};
  const result=await local.receive(p.message,'remote');
  if(loseReply){loseReply=false;throw Error('Acknowledgement lost');}return result;
 }});
 await local.send({id:'one',to:{env:'remote',id:'two'},text:'Status?',messageId:mid(1)});
 const reply={id:'two',replyTo:mid(1),text:'All passed.'};
 await assert.rejects(remote.send({...reply,messageId:mid(2)}),/unconfirmed/);
 await remote.send({...reply,messageId:mid(3)});
 assert.equal(f.sent.length,1);
 assert.equal((await remote.list('two')).messages.find(m=>m.replyTo)?.id,mid(2));
});

test('a deduplicated CLI reply prints the original usable reply ID',async()=>{
 const lines=[];
 await runMessageCommand('reply',[mid(1),'--message-id',mid(9),'--','Same answer'],{
  self:'local',senderId:'one',callerThreadId:undefined,write:s=>lines.push(s),
  rpc:async()=>({duplicate:true,message:{id:mid(2),to:{title:'Parent'}}})
 });
 assert.match(lines[0],new RegExp(`Message ${mid(2)} already delivered`));
 assert.ok(!lines[0].includes(mid(9)));
});
