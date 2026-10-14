import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Set every production-state path BEFORE importing any Helm module.
const root = mkdtempSync(join(tmpdir(), 'helm-mobile-devices-'));
Object.assign(process.env, { HELM_DIR: root, HELM_DB: join(root,'hub.sqlite'), HELM_SSH_DIR: join(root,'ssh'),
  HELM_TERMINALS_SOCKET: join(root,'terminal.sock'), HELM_PROCS_SOCKET: join(root,'process.sock'), HELM_NATIVE_SOCKET: join(root,'native.sock'), HERDR_SOCKET_PATH: join(root,'herdr.sock'), HELM_NO_SERVICE:'1' });
const { DeviceService, pngFrame } = await import('../packages/connect/src/devices/service.js');
const { inspectDeviceTools, runDeviceTool } = await import('../packages/connect/src/devices/toolchain.js');
const { createDeviceRoutes } = await import('../packages/connect/src/devices/routes.js');
const { runDeviceCommand } = await import('../packages/connect/src/device-cli.js');
const { deviceNote } = await import('../packages/connect/src/devices/instructions.js');
const { DEVICE_LIMITS } = await import('../packages/protocol/devices.js');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6N8AAAAASUVORK5CYII=', 'base64');
const tools = {adb:'/fake/adb',emulator:'/fake/emulator',xcrun:null,agent:null,hub:null};
const ready = () => ({platform:'linux',tools:{...tools},android:{available:true,reason:'installed',setup:[]},ios:{available:false,reason:'Requires a Mac',setup:[]}});
const services = [];
function fixture(options={}) {
  const calls=[]; let serial='emulator-5554', booted=true;
  const run = async(command,args,opts={}) => {
    calls.push({command,args,opts});
    if (args[0] === 'devices') return Buffer.from(`List of devices attached\n${serial}\tdevice product:sdk model:Pixel_9 device:generic\nphone-1\tunauthorized usb:1\n`);
    if (args[0] === '-list-avds') return Buffer.from('Pixel_9\nPixel_10\n');
    if (args.includes('avd')) return Buffer.from('Pixel_9\nOK\n');
    if (args.includes('screencap')) return png;
    if (args.includes('sys.boot_completed')) return Buffer.from(booted?'1':'0');
    return Buffer.from('ok');
  };
  const service=new DeviceService({inspect:ready,run,directory:join(root,`service-${services.length}`), ...options});
  services.push(service);return {service,calls,setSerial:(s)=>{serial=s;},setBooted:(b)=>{booted=b;}};
}
test.after(async()=>{for(const s of services) await s.stop();rmSync(root,{recursive:true,force:true});});

test('readiness is inspect-only and discovers existing SDK executables with honest iOS constraints',()=>{
  const sdk=join(root,'Android','Sdk');mkdirSync(join(sdk,'platform-tools'),{recursive:true});mkdirSync(join(sdk,'emulator'),{recursive:true});
  writeFileSync(join(sdk,'platform-tools','adb'),'#!/bin/sh\n',{mode:0o755});writeFileSync(join(sdk,'emulator','emulator'),'#!/bin/sh\n',{mode:0o755});
  const r=inspectDeviceTools({env:{PATH:'',ANDROID_HOME:sdk},platform:'linux',home:root});
  assert.equal(r.tools.adb,join(sdk,'platform-tools','adb'));assert.ok(r.android.available);assert.equal(r.ios.available,false);assert.match(r.ios.reason,/Mac/);
  const f=fixture();assert.equal(f.calls.length,0);f.service.readiness();assert.equal(f.calls.length,0);
});

test('Android discovery merges booted AVDs and offline definitions, preserving explicit serials and authorization',async()=>{
  const {service}=fixture();const result=await service.list();
  assert.deepEqual(result.devices.map(d=>[d.id,d.state]),[['android:emulator-5554','running'],['android:phone-1','unauthorized'],['avd:Pixel_10','stopped']]);
  const opened=await service.open({deviceId:'android:emulator-5554',sessionId:'thread'});
  assert.match(opened.quickStart,/captures no frames/);assert.equal(service.streams.size,0);
  assert.deepEqual((await service.list({sessionId:'thread'})).sessions,[{sessionId:'thread',deviceId:'android:emulator-5554'}]);
  await assert.rejects(()=>service.start({deviceId:'android:phone-1'}),/RSA prompt/);
  service.close({sessionId:'thread'});assert.equal(service.sessions.size,0);
});

test('missing or failing platform tooling reports actionable readiness instead of installing anything',async()=>{
  const {service}=fixture({inspect:()=>({...ready(),tools:{adb:null,emulator:null,xcrun:null,agent:null,hub:null}})});
  assert.deepEqual((await service.list()).devices,[]);
  const failed=fixture({run:async()=>{throw Error('SDK tool failed');}}).service;
  const catalog=await failed.list();assert.equal(catalog.readiness.android.available,false);assert.match(catalog.errors[0],/SDK tool failed/);
});

test('emulator start is deduplicated, uses installed AVD only, and resolves its new runtime serial',async()=>{
  let now=0,launches=0, started=false;
  const {service}=fixture({now:()=>now,pause:async(ms)=>{now+=ms;},launch:async(cmd,args)=>{launches++;assert.deepEqual(args.slice(0,4),['-avd','Pixel_10','-no-snapshot-load','-no-boot-anim']);started=true;},
    run:async(cmd,args)=>{if(args[0]==='devices')return Buffer.from(`List of devices attached\n${started?'emulator-5556 device\n':''}`);if(args[0]==='-list-avds')return Buffer.from('Pixel_10');if(args.includes('avd'))return Buffer.from('Pixel_10\nOK');return Buffer.from('1');}});
  const [a,b]=await Promise.all([service.start({deviceId:'avd:Pixel_10'}),service.start({deviceId:'avd:Pixel_10'})]);
  assert.equal(launches,1);assert.equal(a.device.id,'android:emulator-5556');assert.deepEqual(a,b);
});

test('pull stream coalesces capture, rejects parallel requests per watcher, checks ownership and clears idle cache',async()=>{
  let now=1000,release,captures=0;
  const {service}=fixture({now:()=>now,limits:{leaseMs:100},run:async(cmd,args)=>{
    if(args[0]==='devices')return Buffer.from('List of devices attached\nphone device\n');if(args[0]==='-list-avds')return Buffer.from('');
    captures++;await new Promise(r=>{release=r;});return png;
  }});
  const a=await service.watch({deviceId:'android:phone'},'viewer-a');const b=await service.watch({deviceId:'android:phone'},'viewer-b');
  assert.equal(captures,0);
  const one=service.frame({watchId:a.watchId},'viewer-a');const two=service.frame({watchId:b.watchId},'viewer-b');
  await assert.rejects(()=>service.frame({watchId:a.watchId},'viewer-a'),/already in flight/);
  await assert.rejects(()=>service.frame({watchId:a.watchId},'viewer-b'),/another client/);
  assert.equal(captures,1);release();assert.deepEqual(await one,await two);
  await service.frame({watchId:a.watchId},'viewer-a');assert.equal(captures,1,'frame interval limits repeated captures');
  now+=101;await service.sweep();assert.equal(service.watchers.size,0);assert.equal(service.streams.size,0);assert.equal(service.cleanup,null);
});

test('closing an in-flight viewer discards the frame and frees slots without recreating a stream',async()=>{
  let release;
  const {service}=fixture({run:async(cmd,args)=>{
    if(args[0]==='devices')return Buffer.from('List of devices attached\nphone device\n');if(args[0]==='-list-avds')return Buffer.from('');await new Promise(r=>{release=r;});return png;
  }});
  const w=await service.watch({deviceId:'android:phone'},'v');const frame=service.frame({watchId:w.watchId},'v');
  service.unwatch({watchId:w.watchId},'v');release();await assert.rejects(()=>frame,/expired/);assert.equal(service.streams.size,0);
});

test('viewer and stream budgets are bounded; screenshot envelope validates PNG size and dimensions',async()=>{
  const {service}=fixture({limits:{watchers:1,streams:1}});const w=await service.watch({deviceId:'android:emulator-5554'},'v');
  await assert.rejects(()=>service.watch({deviceId:'android:emulator-5554'},'v2'),/Too many device viewers/);
  service.unwatch({watchId:w.watchId},'v');assert.equal(service.streams.size,0);
  assert.equal(pngFrame(png).width,1);assert.throws(()=>pngFrame(Buffer.alloc(DEVICE_LIMITS.frameBytes+1)),/4 MiB/);
  assert.throws(()=>pngFrame(Buffer.from('not a png')),/PNG/);const large=Buffer.from(png);large.writeUInt32BE(0xffffffff,16);assert.throws(()=>pngFrame(large),/dimensions/);
});

test('Android input pins its serial and protects the remote shell against text and URL command injection',async()=>{
  const {service,calls}=fixture();
  await service.action({deviceId:'android:emulator-5554',action:{type:'tap',x:4.2,y:7.7}});
  await service.action({deviceId:'android:emulator-5554',action:{type:'swipe',x:1,y:2,x2:3,y2:4,duration:500}});
  await service.action({deviceId:'android:emulator-5554',action:{type:'type',text:"hello ' $(touch /tmp/no) ; &"}});
  await service.action({deviceId:'android:emulator-5554',action:{type:'key',key:'home'}});
  await service.action({deviceId:'android:emulator-5554',action:{type:'open',url:'myapp://x?param=a&other=$(touch /tmp/no)'}});
  const inputs=calls.filter(c=>c.args.includes('shell'));
  assert.deepEqual(inputs[0].args,['-s','emulator-5554','shell','input','tap','4','8']);
  assert.deepEqual(inputs[1].args.slice(-6),['swipe','1','2','3','4','500']);
  assert.equal(inputs[2].args.at(-1),"'hello%s'\\''%s$(touch%s/tmp/no)%s;%s&'");
  assert.equal(inputs[3].args.at(-1),'3');assert.match(inputs[4].args.at(-1),/^'myapp:.*'$/);
  await assert.rejects(()=>service.action({deviceId:'android:emulator-5554',action:{type:'tap',x:NaN,y:1}}),/Coordinates/);
  await assert.rejects(()=>service.action({deviceId:'android:emulator-5554',action:{type:'key',key:'shell'}}),/Unsupported/);
  await assert.rejects(()=>service.action({deviceId:'android:emulator-5554',action:{type:'type',text:'नमस्ते'}}),/ASCII/);
});

test('iOS discovery and boot use simctl; screenshots use private temporary paths cleaned on failures',async()=>{
  let booted=false,fail=false;const calls=[];
  const {service}=fixture({inspect:()=>({...ready(),platform:'darwin',tools:{...tools,adb:null,emulator:null,xcrun:'/xcrun'}}),run:async(cmd,args)=>{
    calls.push(args);
    if(args.includes('list')) return Buffer.from(JSON.stringify({devices:{'com.apple.CoreSimulator.SimRuntime.iOS-27-0':[{udid:'UUID',name:'iPhone',isAvailable:true,state:booted?'Booted':'Shutdown'}]}}));
    if(args[1]==='boot')booted=true;
    if(args.includes('screenshot')){if(fail)throw Error('capture failed');writeFileSync(args.at(-1),png);}
    return Buffer.from('');
  }});
  const opened=await service.open({deviceId:'ios:UUID'});assert.equal(opened.device.state,'running');assert.equal(opened.device.control,false);
  assert.ok(calls.some(a=>a.join(' ')==='simctl bootstatus UUID -b'));
  assert.equal((await service.screenshot({deviceId:'ios:UUID'})).mimeType,'image/png');
  const capture=calls.find(a=>a.includes('screenshot'));assert.ok(capture.at(-1).startsWith(service.directory));assert.equal(existsSync(capture.at(-1)),false);
  await assert.rejects(()=>service.action({deviceId:'ios:UUID',action:{type:'tap',x:1,y:2}}),/agent-device/);
  fail=true;await assert.rejects(()=>service.screenshot({deviceId:'ios:UUID'}),/capture failed/);
  assert.equal(existsSync(calls.at(-1).at(-1)),false);
});

test('installed agent-device is lazy, pinned to target/thread and private state; overrides and daemon commands are refused',async()=>{
  const {service,calls}=fixture({env:{...process.env,AGENT_DEVICE_DAEMON_BASE_URL:'https://production.invalid',AGENT_DEVICE_CONFIG:'/owner/config'},inspect:()=>({...ready(),tools:{...tools,agent:'/agent-device.mjs'}})});
  assert.equal(service.agentUsed,false);
  await service.agent({deviceId:'android:emulator-5554',sessionId:'thread',args:['snapshot','-i']});
  const call=calls.find(c=>c.command==='/agent-device.mjs');
  assert.deepEqual(call.args.slice(0,6),['snapshot','-i','--platform','android','--serial','emulator-5554']);
  assert.equal(call.opts.env.AGENT_DEVICE_DAEMON_BASE_URL,undefined);assert.equal(call.opts.env.AGENT_DEVICE_CONFIG,undefined);assert.equal(call.args[call.args.indexOf('--config')+1],join(service.directory,'agent-device-config.json'));assert.match(call.args.at(-1),/^helm-[a-f0-9]{24}$/);assert.equal(call.opts.env.AGENT_DEVICE_STATE_DIR,join(service.directory,'agent-device'));
  for(const args of [['daemon','stop'],['snapshot','--serial=other'],['snapshot','--remote-config','https://evil'],['type','--state-dir','/production']])await assert.rejects(()=>service.agent({deviceId:'android:emulator-5554',args}),/interaction command/);
  await service.stop();assert.ok(calls.some(c=>c.args[0]==='daemon'&&c.args.includes(join(service.directory,'agent-device'))));
});

test('device routes enforce thread modes and viewer caller identity before reaching tools',async()=>{
  const {service}=fixture();const routes=createDeviceRoutes({service,getSession:()=>({mode:'readonly'})});
  assert.ok(routes.handles('device.frame'));assert.equal(routes.handles('session.input'),false);
  await assert.rejects(()=>routes.dispatch('device.action',{sessionId:'thread',deviceId:'android:emulator-5554',action:{type:'tap',x:1,y:2}},'v'),/read-only/);
  const w=await routes.dispatch('device.watch',{deviceId:'android:emulator-5554'},'v');
  await assert.rejects(()=>routes.dispatch('device.frame',{watchId:w.watchId},'other'),/another client/);
  await assert.rejects(()=>routes.dispatch('device.exec',{},'v'),/Unknown/);
});

test('CLI selects remote host, links current thread, maps controls and saves remote screenshot locally',async()=>{
  const calls=[],output=[];const deps={self:'self',machineId:n=>`host-${n}`,env:{HELM_SESSION_ID:'thread'},print:s=>output.push(s),rpc:async(...args)=>{calls.push(args);return pngFrame(png);}};
  await runDeviceCommand(['open','android:phone','--machine','Laptop'],deps);
  assert.deepEqual(calls[0].slice(0,3),['host-Laptop','device.open',{sessionId:'thread',deviceId:'android:phone'}]);
  await runDeviceCommand(['tap','android:phone','10','20'],deps);assert.deepEqual(calls[1][2].action,{type:'tap',x:10,y:20});
  await runDeviceCommand(['agent','android:phone','--machine','Laptop','--','snapshot','-i'],deps);assert.deepEqual(calls[2][2].args,['snapshot','-i']);
  const file=join(root,'download.png');await runDeviceCommand(['screenshot','android:phone','--output',file],deps);assert.deepEqual(readFileSync(file),png);
  for(const args of [['tap','x'],['type','x','text','--bogus','yes'],['start','x','--output','/tmp/no'],['agent','x'],['list','x']])await assert.rejects(()=>runDeviceCommand(args,deps));
  assert.match(deviceNote(),/never downloads SDKs/);
});

test('real tool executor preserves argv and bounds output/time without using a shell',async()=>{
  const script=join(root,'argv.mjs');writeFileSync(script,'console.log(JSON.stringify(process.argv.slice(2)));');
  assert.deepEqual(JSON.parse((await runDeviceTool(script,['literal $(touch /tmp/never)','a; b'])).toString()),['literal $(touch /tmp/never)','a; b']);
  writeFileSync(script,'process.stdout.write("x".repeat(10000));');await assert.rejects(()=>runDeviceTool(script,[],{maxBuffer:100}),/maxBuffer/);
  writeFileSync(script,'setTimeout(()=>{},10000);');await assert.rejects(()=>runDeviceTool(script,[],{timeout:30}));
});

test('Retina iOS screenshot coordinates become logical points; input keeps the thread agent session',async()=>{
  const retina=Buffer.from(png);retina.writeUInt32BE(1206,16);retina.writeUInt32BE(2622,20);
  const calls=[];
  const {service}=fixture({inspect:()=>({...ready(),platform:'darwin',tools:{adb:null,emulator:null,xcrun:'/xcrun',agent:'/agent'}}),run:async(cmd,args,opts)=>{
    calls.push({cmd,args,opts});
    if(args.includes('list'))return Buffer.from(JSON.stringify({devices:{ios:[{udid:'RETINA',name:'iPhone',isAvailable:true,state:'Booted'}]}}));
    if(args.includes('screenshot'))writeFileSync(args.at(-1),retina);
    if(args.includes('getenv'))return Buffer.from(args.at(-1).endsWith('SCALE')?'3':args.at(-1).endsWith('WIDTH')?'1206':'2622');
    return Buffer.from('ok');
  }});
  await service.action({deviceId:'ios:RETINA',sessionId:'thread',action:{type:'tap',x:603,y:1311}});
  assert.deepEqual(calls.find(c=>c.cmd==='/agent').args.slice(0,3),['press','201','437']);
  await service.action({deviceId:'ios:RETINA',sessionId:'thread',action:{type:'key',key:'enter'}});
  assert.deepEqual(calls.filter(c=>c.cmd==='/agent')[1].args.slice(0,2),['type','\n']);
  await service.action({deviceId:'ios:RETINA',sessionId:'thread',action:{type:'open',app:'com.example.app'}});
  const app=calls.filter(c=>c.cmd==='/agent')[2];assert.deepEqual(app.args.slice(0,2),['open','com.example.app']);
  const sessions=calls.filter(c=>c.cmd==='/agent').map(c=>c.args.at(-1));assert.equal(new Set(sessions).size,1);
});

test('device input serialization is bounded and preserves command order after a failed action',async()=>{
  let release;const seen=[];
  const {service}=fixture({run:async(cmd,args)=>{
    if(args[0]==='devices')return Buffer.from('List of devices attached\nphone device\n');if(args[0]==='-list-avds')return Buffer.from('');
    const x=args.at(-2);seen.push(x);
    if(x==='1')await new Promise(r=>{release=r;});if(x==='2')throw Error('input refused');return Buffer.from('ok');
  }});
  const actions=[1,2,3].map(x=>service.action({deviceId:'android:phone',action:{type:'tap',x,y:10}}));
  // Wait for actual first input without a timing assumption.
  while(!release)await new Promise(r=>setImmediate(r));assert.deepEqual(seen,['1']);
  release();const settled=await Promise.allSettled(actions);assert.equal(settled[1].status,'rejected');assert.deepEqual(seen,['1','2','3']);assert.equal(service.actionQueues.size,0);
});

test('unused routes stop without starting tools and cannot load a device service after shutdown',async()=>{
  const routes=createDeviceRoutes();await routes.stop();await assert.rejects(()=>routes.dispatch('device.readiness'),/stopped/);
});

test('unwatch cancels the capture subprocess and stop cancels outstanding isolated tool operations',async()=>{
  const {service}=fixture({run:async(cmd,args,options)=>{
    if(args[0]==='devices')return Buffer.from('List of devices attached\nphone device\n');if(args[0]==='-list-avds')return Buffer.from('');
    return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('capture aborted')),{once:true}));
  }});
  const w=await service.watch({deviceId:'android:phone'},'v');const next=service.frame({watchId:w.watchId},'v');
  service.unwatch({watchId:w.watchId},'v');await assert.rejects(()=>next,/aborted/);assert.equal(service.operations.size,0);
});
