import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['apps/web/src/startingChats.ts'], bundle: true, write: false, format: 'cjs' });
function fixture() {
  const saved = new Map(), events = [];
  const context = { module: { exports: {} }, exports: {}, Date, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    window: { dispatchEvent: event => events.push(event) },
    localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) } };
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
