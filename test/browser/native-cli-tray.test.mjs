import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { ENGINES } from '../../packages/connect/src/engines.js';
import { nativeControls } from '../../packages/connect/src/native-controls.js';
const conversationEngines = ['claude','codex','opencode','opencode2','devin','grok','pi','omp','muse'];
let browser, script, css;
before(async () => {
  const bundle = await build({
    stdin: { contents: `
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import { SessionView } from './apps/web/src/App';
      import { nativeControls } from './packages/connect/src/native-controls.js';
      import { BASH_GUARD_MODES } from './packages/connect/src/modes.js';
      const engine = new URL(location.href).searchParams.get('engine');
      const status = new URL(location.href).searchParams.get('status') || 'idle';
      const full = new URL(location.href).searchParams.get('full');
      const guard = new URL(location.href).searchParams.get('guard');
      window.calls=[];
      const client={input:(env,params)=>client.rpc(env,'session.input',params),on:()=>()=>{},subscribe:()=>()=>{},rpc:async(env,method,params)=>{
        window.calls.push({method,params});
        if(method==='model.list')return full ? {default:null,models:['provider/old','provider/new'],efforts:['low','high'],modes:guard?BASH_GUARD_MODES:[],nativeControls:[],profileId:'pi-account',prefs:{approved:[],default:'provider/old'},favs:[],effortFavs:[],defaults:{}} : {default:null,models:[],modes:[],nativeControls:nativeControls(engine).filter(k=>k!=='settings')};
        if(method==='model.prefs')return {prefs:{approved:[],default:params.default}};
        if(method==='session.messages')return {messages:[{role:'assistant',text:'Existing native conversation',tools:[]}],status};
        if(method==='usage.limits')return {accounts:[
          {engine,aliases:['wrong-account'],windows:[{label:'5h',used:99}]},
          {engine,aliases:['native-account','pi-account'],windows:[{label:'5h',used:12,resetsAt:Math.floor(Date.now()/1000)+3600}]}
        ]};
        if(method==='session.commands')return {commands:[{name:'model',description:'Open model picker'}]};
        if(method==='session.events')return {events:[],pending:[],last:0};
        if(method==='session.pending')return {pending:[]};
        if(method==='session.control'&&window.rejectControl)throw Error('Wait until the CLI finishes its turn');
        return {ok:true,terminal:true};
      }};
      createRoot(document.getElementById('root')).render(<SessionView client={client}
        env={{id:'laptop',name:'Laptop',online:true}} session={{id:'native-test',engine,engineModel:full?'provider/old':null,engineEffort:full?'high':null,mode:guard?'guard':null,permissionControl:guard?'bash-guard':null,nativeCli:true,profileId:'native-account',pty:true,status,cwd:'/project',title:'Native CLI'}}
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
async function open(t,engine,status='idle',full=false,guard=false) {
  const page=await browser.newPage({viewport:{width:390,height:844}});t.after(()=>page.close());page.setDefaultTimeout(6000);
  await page.route('http://helm.test/**',route=>route.fulfill({contentType:'text/html',body:'<div id="root" style="display:flex;flex-direction:column;height:100dvh"></div>'}));
  await page.goto(`http://helm.test/?engine=${engine}&status=${status}${full?'&full=1':''}${guard?'&guard=1':''}`);await page.addStyleTag({content:css});await page.addScriptTag({content:script});return page;
}
for(const engine of Object.values(ENGINES).filter(e=>e.bin&&!e.plain).map(e=>e.id))test(`${engine}: tray and composer stay usable in the native terminal on a phone`,async t=>{
  const page=await open(t,engine);
  if (conversationEngines.includes(engine)) {
    await page.getByText('Existing native conversation', {exact:true}).waitFor();
    assert.equal(await page.getByTestId('terminal').count(),0);
    await page.getByRole('button',{name:'Show terminal',exact:true}).click();
  }
  await page.getByTestId('terminal').waitFor();
  await page.locator('.limits-line').getByText('5h 12%',{exact:true}).waitFor();
  assert.equal(await page.locator('.limits-line').getByText('5h 99%',{exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Open settings in the agent program',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'keys',exact:true}).count(),0,'the phone key row belongs to plain terminals');
  for(const kind of nativeControls(engine).filter(k=>k!=='settings')){
    const title=kind==='effort'?'thinking':kind==='mode'?'permissions':kind;
    await page.getByRole('button',{name:`Open ${title} in the agent program`,exact:true}).click();
    await page.waitForFunction(kind=>window.calls.some(c=>c.method==='session.control'&&c.params.kind===kind),kind);
  }
  await page.locator('textarea').fill('Hello from the phone');
  await page.getByRole('button',{name:'send',exact:true}).click();
  await page.waitForFunction(()=>window.calls.some(c=>c.method==='session.input'));
  assert.equal(await page.locator('textarea').inputValue(),'');
  assert.equal(await page.getByTestId('terminal').count(),1);
  await page.getByRole('button',{name:'Show chat',exact:true}).click();
  await page.getByText('Existing native conversation',{exact:true}).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
});
for(const status of ['working','blocked'])test(`native controls do not send input while ${status}`,async t=>{
  const page=await open(t,'pi',status);
  const model=page.getByRole('button',{name:'Open model in the agent program'});await model.waitFor();
  assert.ok(await model.isDisabled());
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='session.control').length),0);
});
test('a working terminal Pi shows a stop button that stops it',async t=>{
  const page=await open(t,'pi','working');
  await page.getByRole('button',{name:'stop the agent',exact:true}).click();
  await page.waitForFunction(()=>window.calls.some(c=>c.method==='session.interrupt'&&c.params.id==='native-test'));
  await page.screenshot({path:'/tmp/helm-pi-stop.png'});
  const idle=await open(t,'pi');await idle.getByText('Existing native conversation',{exact:true}).waitFor();
  assert.equal(await idle.getByRole('button',{name:'stop the agent'}).count(),0);
});
test('provider rejections stay visible beside the native tray',async t=>{
  const page=await open(t,'pi');await page.evaluate(()=>window.rejectControl=true);
  await page.getByRole('button',{name:'Open model in the agent program'}).click();
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
  await page.getByTestId('terminal').waitFor();
  const calls=await page.evaluate(()=>window.calls);
  assert.deepEqual(calls.find(c=>c.method==='session.model').params,{id:'native-test',model:'provider/new'});
  assert.deepEqual(calls.find(c=>c.method==='picker.prefs').params,{favs:{pi:['provider/new']}});
  assert.equal(calls.find(c=>c.method==='model.prefs').params.profileId,'pi-account');
});


test('Pi starts with reported model and effort, and bash-guard offers its real session toggle',async t=>{
  const page=await open(t,'pi','idle',true,true);
  await page.getByRole('button',{name:'model: old',exact:true}).waitFor();
  await page.getByRole('button',{name:'thinking: high',exact:true}).waitFor();
  assert.ok(await page.getByRole('button',{name:'model: old',exact:true}).locator('.chip-label').isVisible());
  assert.ok(await page.getByRole('button',{name:'thinking: high',exact:true}).locator('.chip-label').isVisible());
  assert.ok(await page.getByRole('button',{name:'permissions: guard',exact:true}).locator('.chip-label').isVisible());
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:'/tmp/helm-pi-settings-tray.png'});
  await page.getByRole('button',{name:'permissions: guard',exact:true}).click();
  await page.getByRole('option',{name:/Bash guard off/}).click();
  await page.getByRole('option',{name:/Bash guard off/}).click();
  await page.waitForFunction(()=>window.calls.some(c=>c.method==='session.mode'));
  assert.deepEqual((await page.evaluate(()=>window.calls)).find(c=>c.method==='session.mode').params,{id:'native-test',mode:'guard-off'});
  await page.getByRole('button',{name:'permissions: guard',exact:true}).waitFor();
  assert.equal(await page.getByTestId('terminal').count(),0,'a guard change stays in the conversation');
  assert.equal(await page.getByRole('button',{name:'Use Bash guard off by default for new chats'}).count(),0);
});
