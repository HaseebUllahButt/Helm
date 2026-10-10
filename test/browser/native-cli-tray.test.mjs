import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { ENGINES } from '../../packages/connect/src/engines.js';
import { nativeControls } from '../../packages/connect/src/native-controls.js';
let browser, script, css;
before(async () => {
  const bundle = await build({
    stdin: { contents: `
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import { SessionView } from './apps/web/src/App';
      import { nativeControls } from './packages/connect/src/native-controls.js';
      const engine = new URL(location.href).searchParams.get('engine');
      const status = new URL(location.href).searchParams.get('status') || 'idle';
      const full = new URL(location.href).searchParams.get('full');
      window.calls=[];
      const client={on:()=>()=>{},subscribe:()=>()=>{},rpc:async(env,method,params)=>{
        window.calls.push({method,params});
        if(method==='model.list')return full ? {default:null,models:['provider/old','provider/new'],efforts:['low','high'],modes:[],nativeControls:['settings'],profileId:'pi-account',prefs:{approved:[],default:'provider/old'},favs:[],effortFavs:[],defaults:{}} : {default:null,models:[],modes:[],nativeControls:nativeControls(engine)};
        if(method==='model.prefs')return {prefs:{approved:[],default:params.default}};
        if(method==='session.messages')return {messages:[],status};
        if(method==='session.commands')return {commands:[{name:'model',description:'Open model picker'}]};
        if(method==='session.events')return {events:[],pending:[],last:0};
        if(method==='session.pending')return {pending:[]};
        if(method==='session.control'&&window.rejectControl)throw Error('Wait until the CLI finishes its turn');
        return {ok:true,terminal:true};
      }};
      createRoot(document.getElementById('root')).render(<SessionView client={client}
        env={{id:'laptop',name:'Laptop',online:true}} session={{id:'native-test',engine,engineModel:full?'provider/old':null,nativeCli:true,pty:true,status,cwd:'/project',title:'Native CLI'}}
        onBack={()=>{}} onClosed={()=>{}} onArchived={()=>{}} onSession={()=>{}} />);
    `, resolveDir:process.cwd(),loader:'tsx'}, bundle:true,write:false,format:'iife',jsx:'automatic',
    plugins:[{name:'native-session-view',setup(b){
      b.onLoad({filter:/\/App\.tsx$/},async a=>({contents:await readFile(a.path,'utf8')+'\nexport { SessionView };',loader:'tsx'}));
      b.onLoad({filter:/\/Terminal\.tsx$/},()=>({contents:'export function Terminal(){return <div className="xterm-host" data-testid="terminal">Native terminal</div>}',loader:'tsx'}));
    }}],
  });
  script=bundle.outputFiles[0].text; css=(await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'');
  browser=await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM?{executablePath:process.env.HELM_TEST_CHROMIUM}:{})});
});
after(async()=>browser?.close());
async function open(t,engine,status='idle',full=false) {
  const page=await browser.newPage({viewport:{width:390,height:844}});t.after(()=>page.close());page.setDefaultTimeout(6000);
  await page.route('http://helm.test/**',route=>route.fulfill({contentType:'text/html',body:'<div id="root" style="display:flex;flex-direction:column;height:100dvh"></div>'}));
  await page.goto(`http://helm.test/?engine=${engine}&status=${status}${full?'&full=1':''}`);await page.addStyleTag({content:css});await page.addScriptTag({content:script});return page;
}
for(const engine of Object.values(ENGINES).filter(e=>e.bin&&!e.plain).map(e=>e.id))test(`${engine}: tray and composer stay usable in the native terminal on a phone`,async t=>{
  const page=await open(t,engine);
  await page.getByTestId('terminal').waitFor();
  for(const kind of nativeControls(engine)){
    const title=kind==='effort'?'thinking':kind==='mode'?'permissions':kind;
    await page.getByRole('button',{name:`${title}: open CLI picker`,exact:true}).click();
    await page.waitForFunction(kind=>window.calls.some(c=>c.method==='session.control'&&c.params.kind===kind),kind);
  }
  await page.locator('textarea').fill('Hello from the phone');
  await page.getByRole('button',{name:'send',exact:true}).click();
  await page.waitForFunction(()=>window.calls.some(c=>c.method==='session.input'));
  assert.equal(await page.locator('textarea').inputValue(),'');
  assert.equal(await page.getByTestId('terminal').count(),1);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
});
for(const status of ['working','blocked'])test(`native controls do not send input while ${status}`,async t=>{
  const page=await open(t,'pi',status);
  const model=page.getByRole('button',{name:'model: open CLI picker'});await model.waitFor();
  assert.ok(await model.isDisabled());
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='session.control').length),0);
});
test('provider rejections stay visible beside the native tray',async t=>{
  const page=await open(t,'pi');await page.evaluate(()=>window.rejectControl=true);
  await page.getByRole('button',{name:'model: open CLI picker'}).click();
  await page.getByRole('alert').getByText('Wait until the CLI finishes its turn').first().waitFor();
});

test('native model sheet shares favorites and defaults while preserving provider-reported state',async t=>{
  const page=await open(t,'pi','idle',true);
  await page.getByRole('button',{name:'model: old',exact:true}).click();
  await page.getByRole('checkbox',{name:'Favorite provider/new'}).check();
  await page.getByRole('button',{name:'Use provider/new by default for new chats'}).click();
  await page.getByRole('button',{name:'provider/new is the default for new chats'}).waitFor();
  await page.getByRole('option',{name:'provider/new',exact:true}).click();
  await page.waitForFunction(()=>window.calls.some(c=>c.method==='session.model'));
  assert.equal(await page.getByRole('button',{name:'model: old',exact:true}).count(),1);
  assert.equal(await page.getByTestId('terminal').count(),1);
  const calls=await page.evaluate(()=>window.calls);
  assert.deepEqual(calls.find(c=>c.method==='session.model').params,{id:'native-test',model:'provider/new'});
  assert.deepEqual(calls.find(c=>c.method==='picker.prefs').params,{favs:{pi:['provider/new']}});
  assert.equal(calls.find(c=>c.method==='model.prefs').params.profileId,'pi-account');
});
