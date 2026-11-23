import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { diagnose } from '../packages/connect/src/doctor.js';
const exec=promisify(execFile);

test('a doctor report on an expired home certificate exports no private details', async () => {
  const report=await diagnose({network:async()=>({id:'private',self:'local',key:'secret',machines:{
    local:{id:'local'},home:{id:'home',kind:'vm',endpoints:['https://private.example']}}}),
    service:async()=>({state:'manual'}),web:()=>'/private-app',health:async address=>address.startsWith('http://127.')?'ok':'certificate-expired',
    rpc:async()=>({machines:[]})});
  assert.doesNotMatch(JSON.stringify(report),/private|secret|https/);
});

test('a real expired loopback certificate fails without bypassing the certificate check', async t => {
  const cert=fileURLToPath(new URL('./fixtures/expired-loopback-cert.pem',import.meta.url));
  const server=createServer({cert:readFileSync(cert),key:readFileSync(new URL('./fixtures/expired-loopback-key.pem',import.meta.url))},
    (_,res)=>res.end(JSON.stringify({ok:true,network:'private'})));
  server.on('tlsClientError',()=>{});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const module=new URL('../packages/connect/src/doctor.js',import.meta.url).href;
  const script=`import {probeHealth} from ${JSON.stringify(module)}; console.log(await probeHealth(${JSON.stringify('https://127.0.0.1:'+server.address().port)},'private'));`;
  const result=await exec(process.execPath,['--input-type=module','-e',script],{env:{...process.env,NODE_EXTRA_CA_CERTS:cert}});
  assert.equal(result.stdout.trim(),'certificate-expired');
});
