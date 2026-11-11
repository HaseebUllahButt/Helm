import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['apps/web/src/balancer.ts', 'apps/web/src/machineStats.ts'], bundle: true, write: false, format: 'esm', outdir: 'out', external: ['react'], alias: { react: 'data:text/javascript,export const useEffect=()=>{},useState=(x)=>[x,()=>{}];' } });
const load = (name) => import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles.find((f) => f.path.endsWith(name)).text).toString('base64'));
const { balanced, windowsOf } = await load('balancer.js');

const soon = Date.now() / 1000 + 3600;
const account = (key, engine, id) => ({ key, engine, account: key, token: false, aliases: [id], profile: { id, engine } });
const reading = (engine, id, used) => ({ engine, aliases: [id], windows: [{ label: '5h', used, resetsAt: soon }] });

test('a new chat leaves an account that is out for one of the same tool with limit left', () => {
  const work = account('w', 'claude', 'claude-w'), home = account('h', 'claude', 'claude-h'), codex = account('c', 'codex', 'codex');
  const readings = [reading('claude', 'claude-w', 100), reading('claude', 'claude-h', 40), reading('codex', 'codex', 0)];
  const moved = balanced([work, home, codex], work, readings);
  assert.equal(moved.account, home);
  assert.equal(moved.from, work);
  assert.equal(moved.until, soon);
  assert.deepEqual(balanced([work, home], home, readings), { account: home });
  assert.equal(windowsOf(codex, readings)[0].used, 0);
});

test('with no other account that has room, the chat stays and says when the limit comes back', () => {
  const work = account('w', 'claude', 'claude-w');
  const moved = balanced([work], work, [reading('claude', 'claude-w', 100)]);
  assert.equal(moved.account, work);
  assert.equal(moved.from, undefined);
  assert.equal(moved.until, soon);
});

test('a machine row reads its load in a few words', async () => {
  const { loadPhrase, bytes } = await load('machineStats.js');
  const stats = { cpu: { cores: 8, used: 12.4 }, memory: { total: 100, used: 40 }, gpus: [{ name: 'RTX', used: 55, memory: null }] };
  assert.equal(loadPhrase(stats), 'CPU 12% · memory 40% · GPU 55%');
  assert.equal(loadPhrase('old'), '');
  assert.equal(bytes(33.4e9), '33.4 GB');
});
