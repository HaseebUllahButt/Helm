import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'helm-execution-rpc-'));
process.env.HELM_DIR = root;
process.env.HELM_DB = join(root, 'relay.sqlite');
process.env.HELM_NO_SERVICE = '1';
const N = await import('@helm/protocol/network');
const { startRelay } = await import('../apps/relay/src/server.js');
const { Daemon } = await import('../packages/connect/src/agent.js');
const { T, M } = await import('@helm/protocol');
const { default: WebSocket } = await import('ws');
const { connectHub } = await import('../packages/connect/src/hub-client.js');
const hub = await startRelay({ port: 0, host: '127.0.0.1', openLogin: false });
const port = hub.server.address().port;
const net = N.createNetwork({ name: 'execution-box', port });
const daemon = new Daemon({ port });
daemon.describe = async () => ({ name: 'execution-box' });
daemon.sessions = { get: () => ({mode:'readonly'}) };
const env = new WebSocket(`ws://127.0.0.1:${port}/helm/ws?role=self`, {
  headers: {authorization:`Bearer ${N.machineToken(net)}`},
});
env.on('message', async raw => {
  const msg = JSON.parse(raw);
  if (msg.t !== T.RPC) return;
  try { env.send(JSON.stringify({t:T.RPC_RESULT,id:msg.id,ok:true,result:await daemon.dispatch(msg.method,msg.params,msg.sub)})); }
  catch (error) { env.send(JSON.stringify({t:T.RPC_RESULT,id:msg.id,ok:false,error:{message:error.message}})); }
});
await once(env, 'message');
test.after(async () => { await daemon.executions.stop(); env.terminate(); hub.stop(); rmSync(root,{recursive:true,force:true}); });
const bin = fileURLToPath(new URL('../packages/connect/bin/helm.js',import.meta.url));
const invoke = args => new Promise((resolve,reject) => {
  const child = spawn(process.execPath,[bin,...args],{cwd:root,env:{...process.env,HELM_SESSION_ID:''}});
  let out='',err='';const timer=setTimeout(()=>{child.kill();reject(new Error('execution CLI timed out'));},10000);
  child.stdout.on('data',chunk=>out+=chunk);child.stderr.on('data',chunk=>err+=chunk);
  child.on('error',error=>{clearTimeout(timer);reject(error);});
  child.on('close',code=>{clearTimeout(timer);resolve({code,out,err});});
});

test('real helm exec returns streamed output and exit status through the authenticated relay',async()=>{
  const r=await invoke(['exec','execution-box','--cwd',root,'--env','RPC_VALUE=explicit','--',process.execPath,'-e','console.log(process.env.RPC_VALUE);console.error("stderr");process.exitCode=6']);
  assert.equal(r.code,6,r.err);assert.equal(r.out.trim(),'explicit');assert.equal(r.err.trim(),'stderr');
});

test('read-only session restrictions and ownership are checked by the machine dispatcher',async()=>{
  const c=await connectHub(net,net.self);
  try {
    await assert.rejects(()=>c.rpc(M.EXEC_START,{id:'1'.repeat(32),argv:['true'],sessionId:'restricted'}),/read-only/);
    await assert.rejects(()=>c.rpc(M.EXEC_READ,{id:'2'.repeat(32)}),/not found/);
  }finally{c.close();}
});
