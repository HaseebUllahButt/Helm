import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['apps/web/src/balancer.ts'], bundle: true, write: false, format: 'esm', external: ['react'], alias: { react: 'data:text/javascript,export const useEffect=()=>{},useState=(x)=>[x,()=>{}];' } });
const { balanced, windowsOf } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

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
