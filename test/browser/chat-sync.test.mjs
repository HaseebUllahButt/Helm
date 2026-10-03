import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

let browser, script;
before(async () => {
  const bundle = await build({stdin:{contents:`
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { useSessionLog } from './apps/web/src/session/useSessionLog';
    import { saveCached } from './apps/web/src/session/logCache';
    const listeners=new Set();
    const client={subscribe:()=>{},on:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},rpc:window.rpc};
    const root=createRoot(document.getElementById('root'));
    function Chat({id}) { const state=useSessionLog(client,'machine',id); window.state=state;
      return <pre>{JSON.stringify(state.log)}</pre>; }
    window.mount=(id='chat')=>root.render(<Chat id={id}/>);
    window.unmount=()=>root.render(null);
    window.seed=events=>saveCached('machine','chat',events.at(-1)?.seq??0,events,events[0]?.seq??0);
    window.emit=(kind,payload,machine='machine')=>listeners.forEach(fn=>fn(machine,kind,payload));
  `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic'});
  script=bundle.outputFiles[0].text;
  browser=await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM?{executablePath:process.env.HELM_TEST_CHROMIUM}:{})});
});
after(async()=>browser?.close());
const event=(seq,type,extra={})=>({seq,type,at:seq,...extra});
const transcript=(text='old',start=1)=>[
  event(start,'turn.start',{turnId:'turn-'+start,text:'Question '+start}),
  event(start+1,'item.start',{id:'reply-'+start,turnId:'turn-'+start,kind:'text'}),
  event(start+2,'item.delta',{id:'reply-'+start,text}),
];
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
function server(events=transcript()) {
  return {events,calls:[],watchers:new Set(),pageSize:500,pending:[],status:'working',handler:null,
    history(params) {
      const events=params.tail?this.events.slice(-params.tail):this.events.filter(e=>e.seq>(params.since??0));
      const page=events.slice(0,this.pageSize);
      return {events:page,last:this.events.at(-1)?.seq??0,hasMore:page.length<events.length,
        firstSeq:page[0]?.seq??0,logFirst:this.events[0]?.seq??0,pending:this.pending,session:{status:this.status}};
    },
    async rpc(env,method,params) {
      this.calls.push({env,method,params});
      if(method==='session.watch'){this.watchers.add(params.watchId);return {last:this.events.at(-1)?.seq??0};}
      if(method==='session.unwatch'){this.watchers.delete(params.watchId);return {ok:true};}
      if(method==='session.events') return this.handler?this.handler(params):this.history(params);
      throw Error(method);
    }};
}
async function device(t,remote,{cache,clock=false}={}) {
  const context=await browser.newContext();
  t.after(()=>context.close());
  const page=await context.newPage();
  await page.route('http://helm-test/**',r=>r.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));
  await page.goto('http://helm-test/');
  if(clock) await page.clock.install();
  await page.exposeFunction('rpc',(...args)=>remote.rpc(...args));
  await page.addScriptTag({content:script});
  if(cache) await page.evaluate(events=>window.seed(events),cache);
  await page.evaluate(()=>window.mount());
  return page;
}
const caughtUp=(page,last)=>page.waitForFunction(last=>window.state?.log.last===last&&!window.state.syncing,last);
const text=page=>page.evaluate(()=>window.state.log.turns.flatMap(t=>t.items.map(i=>i.text)).join(''));

test('cached history and newer live pushes merge in order while the first fetch is pending',async t=>{
  const remote=server([...transcript(),event(4,'item.delta',{id:'reply-1',text:' middle'})]);
  const gate=deferred();
  remote.handler=async p=>{const reply=remote.history(p);await gate.promise;return reply};
  const page=await device(t,remote,{cache:transcript()});
  await page.waitForFunction(()=>window.state?.log.last===3);
  assert.equal(await page.evaluate(()=>window.state.syncing),true);
  const push=event(5,'item.delta',{id:'reply-1',text:' newest'});
  remote.events.push(push);
  await page.evaluate(push=>window.emit('session.event',{id:'chat',events:[push]}),push);
  gate.resolve();
  await caughtUp(page,5);
  assert.equal(await text(page),'old middle newest');
});

test('cold live pushes cannot move the cursor past history before it is loaded',async t=>{
  const remote=server(); const gate=deferred();
  remote.handler=async p=>{const r=remote.history(p);await gate.promise;return r};
  const page=await device(t,remote);
  const push=event(4,'item.delta',{id:'reply-1',text:' latest'});
  remote.events.push(push);
  await page.evaluate(push=>window.emit('session.event',{id:'chat',events:[push]}),push);
  gate.resolve();
  await caughtUp(page,4);
  assert.equal(await text(page),'old latest');
});

test('all catch-up pages are fetched, including more than the previous eight-page limit',async t=>{
  const events=[...transcript(),...Array.from({length:12},(_,i)=>event(i+4,'item.delta',{id:'reply-1',text:String(i)}))];
  const remote=server(events);remote.pageSize=1;
  const page=await device(t,remote,{cache:transcript()});
  await caughtUp(page,15);
  assert.equal(await text(page),'old01234567891011');
  assert.ok(remote.calls.filter(c=>c.method==='session.events').length>=12);
});

test('a sleeping device catches up on focus and repairs silently missed final events on renewal',async t=>{
  const remote=server();
  const page=await device(t,remote,{clock:true});await caughtUp(page,3);
  remote.events.push(event(4,'item.delta',{id:'reply-1',text:' while asleep'}));
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await caughtUp(page,4);
  remote.events.push(event(5,'item.delta',{id:'reply-1',text:' final'}));remote.status='idle';
  await page.clock.fastForward(10000);
  await caughtUp(page,5);
  assert.equal(await text(page),'old while asleep final');
  assert.equal(await page.evaluate(()=>window.state.log.status),'idle');
});

test('failed initial refresh retries and clears stale pending permissions from the server snapshot',async t=>{
  const cached=[...transcript(),event(4,'permission.request',{requestId:'old-ask',kind:'command',title:'Old permission'})];
  const remote=server(cached);remote.status='idle';
  let attempts=0;remote.handler=p=>{if(++attempts===1)throw Error('disconnected');return remote.history(p)};
  const page=await device(t,remote,{cache:cached,clock:true});
  await page.waitForFunction(()=>window.state?.error==='disconnected');
  await page.clock.fastForward(1000);
  await caughtUp(page,4);
  assert.equal(await page.evaluate(()=>window.state.error),'');
  assert.equal(await page.evaluate(()=>window.state.log.pending.length),0);
});

test('trimmed or replaced machine history heals an old device cache',async t=>{
  for(const [cached,fresh] of [[transcript('cached'),transcript('fresh',100)],[transcript('cached',100),transcript('fresh')]]){
    const remote=server(fresh);
    const page=await device(t,remote,{cache:cached});
    await caughtUp(page,fresh.at(-1).seq);
    assert.equal(await text(page),'fresh');
    assert.ok(remote.calls.some(c=>c.params.tail));
  }
});

test('late replies from another chat cannot overwrite the newly opened chat',async t=>{
  const remote=server(),gate=deferred();
  remote.handler=async p=>{if(p.id==='chat'){await gate.promise;return remote.history(p)}return {...remote.history(p),events:transcript('new chat')};};
  const page=await device(t,remote);
  await page.waitForFunction(()=>window.state!==undefined);
  await page.evaluate(()=>window.mount('other'));
  await caughtUp(page,3);assert.equal(await text(page),'new chat');
  gate.resolve();
  await page.evaluate(()=>new Promise(r=>setTimeout(r,30)));
  assert.equal(await text(page),'new chat');
});

test('two independent device views keep their own watch across refresh and close',async t=>{
  const remote=server();
  const a=await device(t,remote),b=await device(t,remote);
  await caughtUp(a,3);await caughtUp(b,3);assert.equal(remote.watchers.size,2);
  await a.evaluate(()=>window.unmount());
  await a.waitForFunction(()=>document.querySelector('pre')===null);
  await b.evaluate(()=>new Promise(r=>setTimeout(r,20)));
  assert.equal(remote.watchers.size,1);
  const push=event(4,'item.delta',{id:'reply-1',text:' still live'});remote.events.push(push);
  await b.evaluate(push=>window.emit('session.event',{id:'chat',events:[push]}),push);
  await caughtUp(b,4);assert.equal(await text(b),'old still live');
  await a.evaluate(()=>window.mount());await caughtUp(a,4);
  assert.equal(await text(a),'old still live');assert.equal(remote.watchers.size,2);
});

test('chat reads recover through the hub when a direct channel stays open but silent',async t=>{
  const bundle=await build({stdin:{contents:`
    import { Client } from './apps/web/src/client';
    window.checkRoute = async method => {
      const client=new Client([], 'test-token'), calls=[];
      client.ws={readyState:WebSocket.OPEN,send:frame=>{
        calls.push('hub');const msg=JSON.parse(frame),pending=client.pending.get(msg.id);
        client.pending.delete(msg.id);pending?.resolve({latest:true});
      }};
      client.peers=new Map([['machine',{ready:true,channel:{readyState:'open',bufferedAmount:0,send:()=>calls.push('direct')}}]]);
      const result=await client.rpc('machine',method,{},200).catch(e=>({error:e.message}));
      client.close();
      return {calls,result};
    };
  `,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'iife'});
  const context=await browser.newContext();t.after(()=>context.close());
  const page=await context.newPage();await page.addScriptTag({content:bundle.outputFiles[0].text});
  for(const method of ['session.events','session.watch','session.list','session.messages']){
    assert.deepEqual(await page.evaluate(method=>window.checkRoute(method),method),{calls:['direct','hub'],result:{latest:true}});
  }
  for(const method of ['session.input','session.answer']){
    const result=await page.evaluate(method=>window.checkRoute(method),method);
    assert.deepEqual(result.calls,['direct']);assert.match(result.result.error,/timed out/);
  }
});
