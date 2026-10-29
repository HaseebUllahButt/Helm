import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['apps/web/src/startingChats.ts'], bundle: true, write: false, format: 'cjs' });
function fixture(saved = new Map(), { denyRemoval = false } = {}) {
  const events = [];
  const context = { module: { exports: {} }, exports: {}, Date, crypto: globalThis.crypto, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    window: { dispatchEvent: event => events.push(event) },
    localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => { if (denyRemoval) throw new Error('Cannot remove saved start'); return saved.delete(key); }, get length() { return saved.size; }, key: i => [...saved.keys()][i] ?? null } };
  vm.runInNewContext(bundle.outputFiles[0].text, context);
  return { ...context.module.exports, saved, events };
}
for (const code of ['delivery_pending', 'delivery_cancelled']) {
  test(`new chat opens before delivery finishes: ${code}`, async () => {
    const h = fixture(); let created, fail;
    const start = new Promise(resolve => { created = resolve; });
    const delivery = new Promise((_, reject) => { fail = reject; });
    const client = { input: () => delivery };
    const chat = h.beginChat(client, { envId: 'pc' }, () => start);
    h.sendWhenReady(chat.id, 'first message');
    created({ id: 'chat' }); await start; await Promise.resolve();
    assert.equal(chat.state, 'started');
    assert.equal(chat.draft, '');
    fail(Object.assign(new Error(code), { code }));
    await delivery.catch(() => {}); await Promise.resolve();
    assert.equal(chat.state, 'started');
    assert.equal(chat.draft, code === 'delivery_cancelled' ? 'first message' : '');
    assert.equal(h.events.length, code === 'delivery_cancelled' ? 1 : 0);
  });
}


test('a first-message storage failure restores its text and keeps a newer draft', async () => {
  const h = fixture(); let created;
  const start = new Promise(resolve => { created = resolve; });
  const client = { input() { throw new Error('Cannot read saved deliveries'); } };
  const chat = h.beginChat(client, { envId: 'pc' }, () => start);
  h.sendWhenReady(chat.id, 'first message');
  created({ id: 'chat' }); await start;
  h.saved.set('helm-draft:pc:chat', 'newer text');
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(chat.state, 'started');
  assert.equal(chat.draft, 'first message\n\nnewer text');
  assert.equal(h.events.length, 1);
});

test('reload repeats the saved start and queued delivery IDs', async () => {
  const saved = new Map(), first = fixture(saved), starts = [], sends = [];
  const info = { envId: 'pc', startParams: { quick: true, profileId: 'fake' } };
  const chat = first.beginChat({ rpc: async (_,method,params) => {
    starts.push(params); throw Object.assign(new Error('lost reply'), { code:'timeout' });
  } }, info, () => { throw new Error('old callback'); });
  first.sendWhenReady(chat.id, 'saved words');
  await Promise.resolve(); await Promise.resolve();
  const number = chat.messageId;
  const restored = fixture(saved);
  assert.equal(restored.startingChat(chat.id).message, 'saved words');
  let resolveSend;
  const delivered = new Promise(resolve => { resolveSend=resolve; });
  restored.restoreStartingChats({ rpc: async (_,method,params) => {
    starts.push(params); return {session:{id:'created'}};
  }, input: async (...args) => { sends.push(args); resolveSend(); } }, ['pc']);
  await delivered;
  assert.equal(starts[0].startId,starts[1].startId);
  assert.equal(sends[0][1].data,'saved words');
  assert.equal(sends[0][3], number);
});

test('a failed save keeps queued text and draft unchanged', () => {
  const h=fixture();
  const chat=h.beginChat({}, {envId:'pc'},()=>new Promise(()=>{}),'keep me');
  // Make writes fail after the chat and draft were saved.
  const contextSaved = h.saved.set;
  h.saved.set = () => { throw new Error('disk full'); };
  assert.throws(()=>h.sendWhenReady(chat.id,'keep me'));
  h.saved.set = contextSaved;
  assert.equal(chat.draft,'keep me');
  assert.equal(chat.message,'');
});

test('a pending first delivery keeps its ID across another reload', async () => {
  const saved=new Map(), h=fixture(saved); let ready;
  const start=new Promise(resolve=>{ready=resolve;});
  const chat=h.beginChat({rpc:()=>start,input:async()=>{throw Object.assign(new Error('pending'),{code:'delivery_pending'});}},
    {envId:'pc',startParams:{quick:true}},()=>start);
  h.sendWhenReady(chat.id,'once'); ready({session:{id:'created'}});
  await start; for(let i=0;i<6;i++) await Promise.resolve();
  h.forgetChat(chat.id);
  const back=fixture(saved).startingChat(chat.id);
  assert.equal(back.messageId,chat.messageId);
  assert.equal(back.message,'once');
});

test('two tabs save different starts without overwriting queued words', () => {
  const saved=new Map(), a=fixture(saved), b=fixture(saved);
  const info={envId:'pc',startParams:{quick:true}};
  const one=a.beginChat({rpc:()=>new Promise(()=>{})},info,()=>new Promise(()=>{}));
  const two=b.beginChat({rpc:()=>new Promise(()=>{})},info,()=>new Promise(()=>{}));
  a.sendWhenReady(one.id,'first tab');
  b.sendWhenReady(two.id,'second tab');
  const reload=fixture(saved);
  assert.equal(reload.startingChat(one.id).message,'first tab');
  assert.equal(reload.startingChat(two.id).message,'second tab');
});

test('malformed tokens and damaged saved starts report errors without throwing on restore', () => {
  const h=fixture();
  assert.doesNotThrow(()=>h.restoreStartingChats({token:'broken'},['pc']));
  assert.match(h.startingChatsError(),/Sign in/);
  const damaged=fixture(new Map([['helm.startingChat.v1:bad','broken']]));
  assert.match(damaged.startingChatsError(),/Cannot read saved chats/);
});

test('a saved failure card owns its text without creating a second draft', async () => {
  const h=fixture(); let created;
  const start=new Promise(resolve=>{created=resolve;}); let chat;
  const client={input:async()=>{throw Object.assign(new Error('refused'),{code:'delivery_failed',deliveryRetained:true,deliveryPersisted:true});}};
  chat=h.beginChat(client,{envId:'pc'},()=>start);
  h.sendWhenReady(chat.id,'failed words'); created({id:'created'}); await start;
  for(let i=0;i<8;i++) await Promise.resolve();
  assert.equal(chat.draft,'');
  assert.equal(h.events.length,0);
});


test('a failure kept only in memory retains the queued start copy for reload', async () => {
  const h=fixture(); let created;
  const start=new Promise(resolve=>{created=resolve;});
  const chat=h.beginChat({input:async()=>{throw Object.assign(new Error('full'),{deliveryRetained:true,deliveryPersisted:false});}},
    {envId:'pc'},()=>start);
  h.sendWhenReady(chat.id,'keep saved words'); created({id:'created'}); await start;
  for(let i=0;i<8;i++) await Promise.resolve();
  assert.equal(chat.draft,'');
  const saved=JSON.parse(h.saved.get('helm.startingChat.v1:'+chat.id));
  assert.equal(saved.message,'keep saved words');
  assert.equal(saved.messageId,chat.messageId);
});

test('retry after a safe start refusal keeps queued words and both numbers', async () => {
  const h=fixture(); let fixed=false, created, sent;
  const refused=new Promise(resolve=>{created=resolve;});
  const delivered=new Promise(resolve=>{sent=resolve;});
  let firstId;
  const client={rpc:async(_,method,params)=>{
    firstId ??= params.startId;
    assert.equal(params.startId,firstId);
    if(!fixed) { created(); throw new Error('Account is not ready.'); }
    return {session:{id:'created'}};
  },input:async(_,params,timeout,messageId)=>{sent({params,messageId});}};
  const chat=h.beginChat(client,{envId:'pc',startParams:{quick:true}},()=>{});
  h.sendWhenReady(chat.id,'keep through refusal');
  await refused; for(let i=0;i<4;i++) await Promise.resolve();
  assert.equal(chat.state,'failed');
  const number=chat.messageId;
  fixed=true; h.retryChat(client,chat.id);
  const result=await delivered;
  assert.equal(result.params.data,'keep through refusal');
  assert.equal(result.messageId,number);
});


for (const persisted of [true,false]) test(`a retained offline failure keeps only the required start backup: ${persisted}`, async () => {
  const h=fixture(); let created;
  const start=new Promise(resolve=>{created=resolve;});
  const chat=h.beginChat({input:async()=>{throw Object.assign(new Error('Final offline refusal'),
    {code:'offline',deliveryRetained:true,deliveryPersisted:persisted});}}, {envId:'pc'},()=>start);
  h.sendWhenReady(chat.id,'final failure words'); created({id:'created'}); await start;
  for(let i=0;i<8;i++) await Promise.resolve();
  assert.equal(chat.draft,'');
  assert.equal(h.events.length,0);
  assert.equal(h.saved.has('helm.startingChat.v1:'+chat.id),!persisted);
});

test('successful input never restores accepted text when saved-start removal fails', async () => {
  const h=fixture(new Map(),{denyRemoval:true}); let created;
  const start=new Promise(resolve=>{created=resolve;});
  const chat=h.beginChat({input:async()=>({ok:true})},{envId:'pc'},()=>start);
  h.sendWhenReady(chat.id,'already accepted'); created({id:'created'}); await start;
  for(let i=0;i<8;i++) await Promise.resolve();
  assert.equal(chat.draft,'');
  assert.equal(h.events.length,0);
  assert.equal(h.saved.has('helm-draft:pc:created'),false);
  assert.equal(h.saved.has('helm.startingChat.v1:'+chat.id),true);
});
