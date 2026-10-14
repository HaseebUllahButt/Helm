import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
const root=mkdtempSync(join(tmpdir(),'helm-device-rpc-'));
Object.assign(process.env,{HELM_DIR:root,HELM_DB:join(root,'hub.sqlite'),HELM_SSH_DIR:join(root,'ssh'),HELM_TERMINALS_SOCKET:join(root,'term.sock'),HELM_PROCS_SOCKET:join(root,'proc.sock'),HELM_NATIVE_SOCKET:join(root,'native.sock'),HERDR_SOCKET_PATH:join(root,'herdr.sock'),HELM_NO_SERVICE:'1'});
const N=await import('../packages/protocol/network.js');
const {startRelay}=await import('../apps/relay/src/server.js');
const {default:WebSocket}=await import('ws');
const {connectHub}=await import('../packages/connect/src/hub-client.js');
const {DeviceService}=await import('../packages/connect/src/devices/service.js');
const {createDeviceRoutes}=await import('../packages/connect/src/devices/routes.js');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6N8AAAAASUVORK5CYII=','base64');
const service=new DeviceService({directory:join(root,'devices'),inspect:()=>({tools:{adb:'/test-adb'},platform:'linux',android:{available:true,reason:'fixture',setup:[]},ios:{available:false,reason:'Mac required',setup:[]}}),run:async(cmd,args)=>args[0]==='devices'?Buffer.from('List of devices attached\nphone device\n'):png});
const routes=createDeviceRoutes({service});
let hub,env,client;
test.before(async()=>{
  hub=await startRelay({port:0,host:'127.0.0.1',openLogin:false});
  const port=hub.server.address().port;const net=N.createNetwork({name:'device-test-host',port});
  env=new WebSocket(`ws://127.0.0.1:${port}/helm/ws?role=self`,{headers:{authorization:`Bearer ${N.machineToken(net)}`}});
  env.on('message',async raw=>{const msg=JSON.parse(raw);if(msg.t!=='rpc')return;
    try{env.send(JSON.stringify({t:'rpcResult',id:msg.id,ok:true,result:msg.method==='env.info'?{name:'device-test-host'}:await routes.dispatch(msg.method,msg.params,msg.sub)}));}
    catch(error){env.send(JSON.stringify({t:'rpcResult',id:msg.id,ok:false,error:{message:error.message}}));}
  });await once(env,'message');client=await connectHub(net,net.self);
});
test.after(async()=>{client?.close();env?.terminate();hub?.stop();await service.stop();rmSync(root,{recursive:true,force:true});});
test('discovery, thread open, leased frame, control and close cross the real authenticated Helm relay',async()=>{
  const catalog=await client.rpc('device.list',{});assert.equal(catalog.devices[0].id,'android:phone');
  await client.rpc('device.open',{deviceId:'android:phone',sessionId:'thread'});
  assert.equal((await client.rpc('device.list',{sessionId:'thread'})).sessions[0].deviceId,'android:phone');
  const watch=await client.rpc('device.watch',{deviceId:'android:phone'});
  const frame=await client.rpc('device.frame',{watchId:watch.watchId});assert.deepEqual(Buffer.from(frame.data,'base64'),png);assert.equal(frame.width,1);
  await client.rpc('device.action',{deviceId:'android:phone',action:{type:'tap',x:2,y:3}});
  await client.rpc('device.unwatch',{watchId:watch.watchId});assert.equal(service.streams.size,0);
  await assert.rejects(()=>client.rpc('device.frame',{watchId:watch.watchId}),/expired/);
  await client.rpc('device.close',{sessionId:'thread'});assert.deepEqual((await client.rpc('device.list',{})).sessions,[]);
});
