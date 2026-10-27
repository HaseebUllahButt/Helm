import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'helm-replay-host-'));
mkdirSync(join(root, 'home'));
Object.assign(process.env, { HOME: join(root, 'home'), HELM_DIR: join(root, 'helm'),
  HELM_SSH_DIR: join(root, 'ssh'), HELM_PROCS_SOCKET: join(root, 'p.sock'),
  HELM_TERMINALS_SOCKET: join(root, 't.sock'), HELM_NO_SERVICE: '1', HELM_NO_SYSTEMD_RUN: '1' });
const { TerminalHost, PROC_SOCKET_PATH } = await import('../packages/connect/src/terminals.js');
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) {
  const end = Date.now() + 8000;
  while (!fn()) { if (Date.now() > end) throw Error('Private replay fixture timed out.'); await pause(10); }
}

test('both process backlogs preserve the hard UTF-16 tail across disconnect, attach and exit', async t => {
  const a = new TerminalHost({ socketPath: PROC_SOCKET_PATH, unit: 'helm-test-replay' });
  const b = new TerminalHost({ socketPath: PROC_SOCKET_PATH, unit: 'helm-test-replay' });
  t.after(async () => { await b.shutdown(); a.detach(); b.detach(); rmSync(root, { recursive: true, force: true }); });
  const script = join(root, 'producer.mjs');
  writeFileSync(script, `import {existsSync,writeFileSync} from 'node:fs';
    let n=0,busy=false;const root=${JSON.stringify(root)};
    const timer=setInterval(()=>{if(busy||!existsSync(root+'/go-'+n))return;busy=true;
      const text=n===0?'😀'+'x'.repeat(262143):'z'.repeat(262143)+'😀';
      process.stdout.write(text,()=>{writeFileSync(root+'/done-'+n++,'');busy=false;});
    },10);
    process.on('SIGTERM',()=>{clearInterval(timer);process.exit(0);});`);
  await a.openProc('private', { cmd: process.execPath, args: [script], cwd: root });
  a.detach();
  await pause(50); // Let the private host observe the socket close before output.
  writeFileSync(join(root, 'go-0'), '');
  await until(() => existsSync(join(root, 'done-0')));
  await pause(50); // The stream's read completes after its writer's callback.
  assert.equal(await b.ensure(), true);
  const first = b.procPipe('private');
  let replay = '';
  first.onData(data => { replay += data; });
  await until(() => replay.length === 262144);
  assert.equal(replay, ('😀' + 'x'.repeat(262143)).slice(-262144));
  assert.equal(replay.charCodeAt(0), 0xde00, 'the retained tail can begin inside a surrogate pair');
  first.detach();
  writeFileSync(join(root, 'go-1'), '');
  await until(() => existsSync(join(root, 'done-1')));
  await pause(50);
  const second = b.procPipe('private');
  replay = '';
  second.onData(data => { replay += data; });
  await until(() => replay.length === 262144);
  assert.equal(replay, ('z'.repeat(262143) + '😀').slice(-262144));
  const received = replay;
  second.detach();
  const empty = b.procPipe('private');
  empty.onData(data => { replay += data; });
  await pause(30);
  assert.equal(replay, received, 'consuming a backlog does not replay it twice');
  const exited = new Promise(resolve => empty.onExit(resolve));
  await empty.kill('SIGTERM');
  await exited;
  assert.equal(b.procPipe('private'), null);
});
