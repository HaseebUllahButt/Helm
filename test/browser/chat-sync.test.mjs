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
    const client={input:(env,params)=>client.rpc(env,'session.input',params),subscribe:()=>{},on:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},rpc:window.rpc};
    const root=createRoot(document.getElementById('root'));
    function Chat({id}) { const state=useSessionLog(client,'machine',id, { wholeChat: window.wholeChat === true }); window.state=state;
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

test('focus and transport changes share an outstanding slow watch renewal', async t => {
  const remote = server(), gate = deferred(), rpc = remote.rpc.bind(remote); let watches = 0;
  remote.rpc = async (...args) => {
    if (args[1] === 'session.watch') { watches++; await gate.promise; }
    return rpc(...args);
  };
  const page = await device(t, remote, { clock: true });
  await caughtUp(page, 3);
  await page.evaluate(() => {
    for (let i = 0; i < 3; i++) { window.dispatchEvent(new Event('focus')); window.emit('transport', {}); }
  });
  assert.equal(watches, 1, 'slow renewals cannot build up behind reconnection events');
  gate.resolve(); await page.clock.runFor(11000);
  assert.equal(watches, 2, 'renewal continues after the outstanding call finishes');
});

test('image recovery updates an already completed cached turn without replacing its answer', async t => {
  const old = [
    event(1, 'turn.start', { turnId: 'imported-image', text: 'Old image envelope' }),
    event(2, 'item.start', { id: 'answer', turnId: 'imported-image', kind: 'text' }),
    event(3, 'item.delta', { id: 'answer', text: 'Existing answer' }),
    event(4, 'turn.done', { turnId: 'imported-image', status: 'ok' }),
  ];
  const remote = server([...old, event(5, 'turn.images', { turnId: 'imported-image', text: 'Clean caption',
    attachments: [{ filename: 'saved.png', mime: 'image/png', data: 'aGVsbG8=' }],
  })]);
  remote.status = 'idle';
  const page = await device(t, remote, { cache: old });
  await caughtUp(page, 5);
  const turn = await page.evaluate(() => window.state.log.turns[0]);
  assert.equal(turn.text, 'Clean caption');
  assert.equal(turn.attachments[0].data, 'aGVsbG8=');
  assert.equal(turn.items[0].text, 'Existing answer');
  assert.equal(turn.done.status, 'ok');
  assert.equal(turn.revision, 5);
});

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

test('earlier pages merge fuller duplicate event fields without duplicating output', async t => {
  const start = event(1, 'turn.start', { turnId: 'turn', text: 'run it' });
  const sparse = event(2, 'item.start', { id: 'cmd', turnId: 'turn', kind: 'command' });
  const output = event(3, 'item.delta', { id: 'cmd', text: 'output' });
  const full = event(2, 'item.start', {
    id: 'cmd', turnId: 'turn', kind: 'command', command: 'echo original-command', input: { data: 'details' },
  });
  const remote = server([start, sparse, output]);
  remote.handler = (params) => {
    if (params.tail) return { ...remote.history(params), firstSeq: 2, logFirst: 1 };
    if (params.before) return { events: [full], pending: [], last: 3, firstSeq: 1, logFirst: 1, session: { status: 'idle' } };
    return remote.history(params);
  };
  const page = await device(t, remote);
  await caughtUp(page, 3);
  assert.equal(await page.evaluate(() => window.state.log.turns[0].items[0].command), undefined);
  await page.evaluate(() => window.state.loadEarlier());
  await page.waitForFunction(() => window.state?.log.turns[0]?.items[0]?.command === 'echo original-command');
  assert.equal(await text(page), 'output');
  assert.equal(await page.evaluate(() => window.state.log.turns[0].items.length), 1);
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
  await page.waitForFunction(()=>window.state?.error==='This machine is not connected. Check the connection. Try again.');
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
  for(const end=Date.now()+5000;remote.watchers.size!==1&&Date.now()<end;) await new Promise(r=>setTimeout(r,5));
  assert.equal(remote.watchers.size,1);
  const push=event(4,'item.delta',{id:'reply-1',text:' still live'});remote.events.push(push);
  await b.evaluate(push=>window.emit('session.event',{id:'chat',events:[push]}),push);
  await caughtUp(b,4);assert.equal(await text(b),'old still live');
  await a.evaluate(()=>window.mount());await caughtUp(a,4);
  assert.equal(await text(a),'old still live');assert.equal(remote.watchers.size,2);
});

test('chat reads recover through HTTP when a direct channel stays open but silent',async t=>{
  const bundle=await build({stdin:{contents:`
    import { Client } from './apps/web/src/client';
    window.checkRoute = async method => {
      const client=new Client(['http://helm.test'], 'test-token'), calls=[];
      window.fetch=async()=>{calls.push('http');return {ok:true,json:async()=>({result:{latest:true}})};}
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
    assert.deepEqual(await page.evaluate(method=>window.checkRoute(method),method),{calls:['direct','http'],result:{latest:true}});
  }
  for(const method of ['session.input','session.rename']){
    const result=await page.evaluate(method=>window.checkRoute(method),method);
    assert.deepEqual(result.calls,['direct']);assert.match(result.result.error,/timed out/);
  }
});

// A held history read, so live events can arrive while it waits.
const holdNextRead=remote=>{
  const started=deferred(),gate=deferred();
  remote.handler=async p=>{remote.handler=null;const r=remote.history(p);started.resolve();await gate.promise;return r};
  return {started:started.promise,release:gate.resolve};
};
const reads=remote=>remote.calls.filter(c=>c.method==='session.events');
const reply=(seq,n)=>[
  event(seq,'turn.start',{turnId:'t'+seq,text:'Question '+n}),
  event(seq+1,'item.start',{id:'a'+seq,turnId:'t'+seq,kind:'text'}),
  event(seq+2,'item.delta',{id:'a'+seq,text:'Answer '+n}),
  event(seq+3,'turn.done',{turnId:'t'+seq,status:'ok'}),
];

test('live replies appear while a history check waits, and its old reply cannot erase them',async t=>{
  const remote=server();remote.status='idle';
  const page=await device(t,remote);await caughtUp(page,3);
  const held=holdNextRead(remote);
  await page.evaluate(()=>{void window.state.refresh();});
  await held.started;
  const push=event(4,'item.delta',{id:'reply-1',text:' live'});
  await page.evaluate(push=>window.emit('session.event',{id:'chat',events:[push]}),push);
  await page.waitForFunction(()=>window.state.log.last===4);
  assert.equal(await text(page),'old live');
  held.release();
  await caughtUp(page,4);
  assert.equal(await text(page),'old live');
  assert.equal(reads(remote).length,2);
});

test('repeated online notices do not queue more history reads behind a slow read',async t=>{
  const remote=server();remote.status='idle';
  const page=await device(t,remote);await caughtUp(page,3);
  const held=holdNextRead(remote);
  await page.evaluate(()=>{void window.state.refresh();});
  await held.started;
  for(let n=0;n<4;n++) await page.evaluate(()=>window.emit('presence',{online:true}));
  held.release();
  await caughtUp(page,3);
  assert.equal(reads(remote).length,2);
});

test('an older history reply keeps its unanswered question and does not restore a resolved one',async t=>{
  const remote=server();remote.status='idle';
  const page=await device(t,remote);await caughtUp(page,3);
  remote.pending=[{requestId:'open',text:'Approve?'},{requestId:'done',text:'Already answered'}];
  const held=holdNextRead(remote);
  await page.evaluate(()=>{void window.state.refresh();});
  await held.started;
  await page.evaluate(events=>window.emit('session.event',{id:'chat',events}),
    [event(4,'permission.resolved',{requestId:'done'}),event(5,'status',{status:'working'})]);
  await page.waitForFunction(()=>window.state.log.last===5);
  held.release();await caughtUp(page,5);
  assert.deepEqual(await page.evaluate(()=>window.state.log.pending.map(p=>p.requestId)),['open']);
  assert.equal(await page.evaluate(()=>window.state.log.status),'working');
});

test('a gap of several pages is read page by page and keeps the chat behind it',async t=>{
  const remote=server();remote.status='idle';
  const page=await device(t,remote);await caughtUp(page,3);
  remote.pageSize=50;
  for(let n=0;n<60;n++) remote.events.push(...reply(4+n*4,n+2));
  const seen=reads(remote).length;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await caughtUp(page,remote.events.at(-1).seq);
  const later=reads(remote).slice(seen);
  assert.ok(later.every(c=>!c.params.tail),JSON.stringify(later));
  assert.ok(later.filter(c=>c.params.since).length>=5,'it read each page');
  const turns=await page.evaluate(()=>window.state.log.turns.map(t=>t.items.map(i=>i.text).join('')));
  assert.equal(turns.length,61);
  assert.equal(turns[0],'old','the first reply is still there');
});

test('settings saves use the hub when a direct channel stops answering, with direct-only fallback',async t=>{
  const bundle=await build({stdin:{contents:`
    import { Client } from './apps/web/src/client';
    window.testRoute = async (method, relayOpen) => {
      const client = Object.create(Client.prototype), calls = [];
      client.seq = 0; client.pending = new Map();
      const reply = (route, frame) => {
        calls.push(route);
        const msg = JSON.parse(frame);
        client.pending.get(msg.id).resolve({ok:true}); client.pending.delete(msg.id);
      };
      client.ws = { readyState:relayOpen ? WebSocket.OPEN : WebSocket.CLOSED,send:frame=>reply('hub',frame) };
      client.peers = new Map([['machine',{ready:true,channel:{readyState:'open',bufferedAmount:0,send:frame=>{
        if (relayOpen && ['profile.defaults','model.prefs','picker.prefs'].includes(method)) { calls.push('stale-direct'); throw new Error('stale channel'); }
        reply('direct',frame);
      }}}]]);
      await client.rpc('machine',method,{},1000);
      return calls;
    };
  `,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'iife'});
  const context=await browser.newContext();t.after(()=>context.close());
  const page=await context.newPage();await page.addScriptTag({content:bundle.outputFiles[0].text});
  for(const method of ['profile.defaults','model.prefs','picker.prefs']){
    assert.deepEqual(await page.evaluate(method=>window.testRoute(method,true),method),['hub']);
    assert.deepEqual(await page.evaluate(method=>window.testRoute(method,false),method),['direct']);
  }
  assert.deepEqual(await page.evaluate(()=>window.testRoute('session.messages',true)),['direct']);
});
