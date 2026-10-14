import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {readFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=mkdtempSync(join(tmpdir(),'helm-device-browser-'));
Object.assign(process.env,{HELM_DIR:root,HELM_DB:join(root,'hub.sqlite'),HELM_SSH_DIR:join(root,'ssh'),HELM_TERMINALS_SOCKET:join(root,'term.sock'),HELM_PROCS_SOCKET:join(root,'proc.sock'),HELM_NATIVE_SOCKET:join(root,'native.sock'),HERDR_SOCKET_PATH:join(root,'herdr.sock'),HELM_NO_SERVICE:'1'});
const {chromium}=await import('@playwright/test');const {build}=await import('esbuild');
let browser,page;
before(async()=>{
  const bundle=await build({stdin:{contents:`
    import React from 'react';import{createRoot}from'react-dom/client';
    import{DevicesView,DeviceAccess}from'./apps/web/src/Devices';
    const root=createRoot(document.getElementById('root'));
    const canvas=document.createElement('canvas');canvas.width=240;canvas.height=480;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#162236';ctx.fillRect(0,0,240,480);ctx.fillStyle='#8bb8ff';ctx.fillRect(20,100,200,80);ctx.fillStyle='white';ctx.font='22px sans-serif';ctx.fillText('Device test',36,150);
    const data=canvas.toDataURL('image/png').split(',')[1];
    window.calls=[];window.framePending=0;window.maxPending=0;window.links=[];window.watchCount=0;window.hideDevice=false;
    const device={id:'android:phone',target:'phone',name:'Pixel test',platform:'android',kind:'physical',state:'running',control:true};
    const client={rpc:async(machine,method,params)=>{window.calls.push({machine,method,params});
      if(method==='device.list')return{devices:window.hideDevice?[]:[device],sessions:window.links,errors:[],readiness:{tools:{},android:{available:true,reason:'ADB installed',setup:['Connect USB and authorize debugging.']},ios:{available:false,reason:'iOS simulators require a Mac with Xcode.',setup:['Choose a Mac host in Helm.']}}};
      if(method==='device.open'){window.links=[{sessionId:params.sessionId,deviceId:device.id}];return{device,quickStart:'opened'};}
      if(method==='device.watch'){window.watchCount++;return{watchId:'watch-'+window.watchCount,device,intervalMs:60};}
      if(method==='device.frame'){window.framePending++;window.maxPending=Math.max(window.maxPending,window.framePending);if(window.holdFrames)await new Promise(r=>window.releaseFrame=r);else await new Promise(r=>setTimeout(r,30));window.framePending--;return{data,width:240,height:480,mimeType:'image/png',at:Date.now()};}
      if(method==='device.screenshot')return{data,width:240,height:480,mimeType:'image/png',at:Date.now()};
      if(method==='device.close')window.links=[];
      return{ok:true};}};
    window.render=()=>root.render(<><DeviceAccess onOpenDevices={()=>window.accessClicked=true}/><DevicesView client={client} env={{id:'laptop',name:'Laptop',online:true}} sessionId="thread" onBack={()=>window.backClicked=true}/></>);
    window.unmount=()=>root.unmount();window.render();
  `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'empty'}});
  browser=await chromium.launch({headless:true,executablePath:process.env.HELM_TEST_CHROMIUM||'/snap/bin/chromium'});
  page=await browser.newPage({viewport:{width:390,height:844}});
  await page.route('http://helm.test/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root" style="height:100vh;display:flex;flex-direction:column"></div>'}));
  await page.goto('http://helm.test/');
  await page.addStyleTag({content:(await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'')+'\n'+await readFile('apps/web/src/devices.css','utf8')});
  await page.addScriptTag({content:bundle.outputFiles[0].text});
});
after(async()=>{await browser?.close();rmSync(root,{recursive:true,force:true});});

test('phone and desktop discovery show host/setup and thread access without capturing frames before view',async()=>{
  await page.getByRole('button',{name:/Pixel test.*View/}).waitFor();
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='device.frame').length),0);
  await page.getByRole('button',{name:'Devices',exact:true}).click();assert.equal(await page.evaluate(()=>window.accessClicked),true);
  await page.getByText('Device setup on Laptop').click();await page.getByText('iOS simulators require a Mac with Xcode.').waitFor();
  for(const width of [390,1280]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));}
  await page.setViewportSize({width:390,height:844});
});

test('open pins host/thread; live tap and swipe map CSS pixels to device pixels, with text/keys/app/screenshot controls',async()=>{
  await page.getByRole('button',{name:/Pixel test.*View/}).click();
  const image=page.getByRole('img',{name:'Pixel test current screen'});await image.waitFor();
  const open=await page.evaluate(()=>window.calls.find(c=>c.method==='device.open'));assert.deepEqual(open,{machine:'laptop',method:'device.open',params:{deviceId:'android:phone',sessionId:'thread'}});
  const box=await image.boundingBox();await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
  await page.waitForFunction(()=>window.calls.some(c=>c.params.action?.type==='tap'));
  const tap=await page.evaluate(()=>window.calls.find(c=>c.params.action?.type==='tap').params.action);assert.ok(Math.abs(tap.x-120)<=1);assert.ok(Math.abs(tap.y-240)<=1);
  await page.mouse.move(box.x+box.width/2,box.y+box.height*.75);await page.mouse.down();await page.mouse.move(box.x+box.width/2,box.y+box.height*.25,{steps:4});await page.mouse.up();
  await page.waitForFunction(()=>window.calls.some(c=>c.params.action?.type==='swipe'));const swipe=await page.evaluate(()=>window.calls.find(c=>c.params.action?.type==='swipe').params.action);assert.ok(swipe.y>swipe.y2);
  await page.getByLabel('Text to type on device').fill('hello from phone');await page.getByRole('button',{name:'Type',exact:true}).click();
  await page.getByRole('button',{name:'Home',exact:true}).click();await page.getByLabel('App ID or deep link').fill('myapp://test');await page.getByRole('button',{name:'Open app',exact:true}).click();
  await page.waitForFunction(()=>window.calls.some(c=>c.params.action?.url==='myapp://test'));
  assert.equal(await page.evaluate(()=>window.calls.find(c=>c.params.action?.type==='type').params.action.text),'hello from phone');
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Save screenshot',exact:true}).click();assert.equal((await download).suggestedFilename(),'android-screenshot.png');
  await page.getByRole('application').focus();await page.keyboard.press('Backspace');await page.keyboard.press('a');await page.keyboard.press('Control+k');
  await page.waitForFunction(()=>window.calls.some(c=>c.params.action?.text==='a'));assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.params.action?.text==='k').length),0);
  assert.equal(await page.evaluate(()=>window.maxPending),1);
  for(const width of [390,1280]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    if(process.env.HELM_TEST_SCREENSHOT_DIR){await mkdir(process.env.HELM_TEST_SCREENSHOT_DIR,{recursive:true});await page.evaluate(()=>document.querySelector('.scroll').scrollTop=0);await page.screenshot({path:join(process.env.HELM_TEST_SCREENSHOT_DIR,`devices-${width}.png`)});}
  }
});

test('pause and document visibility release leases; in-flight frames do not schedule after close',async()=>{
  await page.getByRole('button',{name:'Pause viewing',exact:true}).click();
  await page.waitForFunction(()=>window.calls.some(c=>c.method==='device.unwatch'));
  const count=await page.evaluate(()=>window.calls.filter(c=>c.method==='device.frame').length);await page.waitForTimeout(180);assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='device.frame').length),count);
  await page.getByRole('button',{name:'Resume viewing',exact:true}).click();await page.waitForFunction(()=>window.watchCount>=2);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{value:true,configurable:true});document.dispatchEvent(new Event('visibilitychange'));});
  const unwatches=await page.evaluate(()=>window.calls.filter(c=>c.method==='device.unwatch').length);assert.ok(unwatches>=2);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{value:false,configurable:true});document.dispatchEvent(new Event('visibilitychange'));window.holdFrames=true;});
  await page.waitForFunction(()=>window.framePending===1&&window.releaseFrame);
  await page.getByRole('button',{name:'Close viewer',exact:true}).click();await page.waitForFunction(()=>window.calls.some(c=>c.method==='device.close'));
  await page.evaluate(()=>window.releaseFrame());const afterClose=await page.evaluate(()=>window.calls.filter(c=>c.method==='device.frame').length);await page.waitForTimeout(180);
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='device.frame').length),afterClose);
  assert.equal(await page.getByRole('application').count(),0);
});
