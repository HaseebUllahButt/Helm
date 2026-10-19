import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transform } from 'esbuild';
const root = mkdtempSync(join(tmpdir(), 'helm-settings-'));
for (const [key, name] of Object.entries({HELM_DIR:'helm', HELM_DB:'db.sqlite', HELM_SSH_DIR:'ssh', HELM_NATIVE_SOCKET:'native.sock', HELM_TERMINALS_SOCKET:'terminals.sock', HELM_PROCS_SOCKET:'procs.sock'})) process.env[key] = join(root, name);
process.env.HELM_NO_SERVICE = '1';
mkdirSync(process.env.HELM_DIR);
const { Sessions } = await import('../packages/connect/src/sessions.js');
const { sendHook } = await import('../packages/connect/src/claude-hooks.js');
const { piChatArgs, BASH_GUARD_MODES } = await import('../packages/connect/src/pi-settings.js');
const { primeModels } = await import('../packages/connect/src/models.js');
const { Daemon } = await import('../packages/connect/src/agent.js');
const { createNetwork } = await import('@helm/protocol/network');
const { M } = await import('@helm/protocol');
createNetwork({name:'Isolated settings test'});
test.after(() => rmSync(root, {recursive:true, force:true}));
class Host extends EventEmitter {
  writes = [];
  nativeSessions() { return ['pi','claude'].map(engine=>({id:`native-${engine}`,engine,nativeChat:engine==='claude',cwd:root,configHome:root,createdAt:1})); }
  has() { return true; }
  async write(id,text) { this.writes.push(text); }
  async view() { return ''; }
  unview() {}
  detach() {}
}
test('new native chats learn model, effort and actual permissions; refresh retains them',async()=>{
  const host=new Host(), sessions=new Sessions(new EventEmitter(),{nativeHost:host,nativeDiscovery:false});
  await sessions.hooks;
  try {
    await sendHook('native-claude',{hook_event_name:'SessionStart',session_id:'c',model:'claude-opus-5-5',effort:{level:'xhigh'},permission_mode:'bypassPermissions'});
    assert.equal(sessions.get('native-claude').engineModel,'claude-opus-5-5');
    assert.equal(sessions.get('native-claude').engineEffort,'xhigh');
    assert.equal(sessions.get('native-claude').mode,'bypassPermissions');
    await sendHook('native-claude',{hook_event_name:'HelmSettings',model:'claude-sonnet-5-5',effort:{level:'low'}});
    assert.equal(sessions.get('native-claude').engineEffort,'low');
    host.emit('data',{id:'native-claude',text:'\x1b[1;1Haccept edits on'});
    assert.equal(sessions.get('native-claude').mode,'acceptEdits');
    await sendHook('native-pi',{hook_event_name:'HelmSettings',model:'anthropic/model',effort:'high',mode:'guard',permissionControl:'bash-guard'});
    primeModels('pi',root,null,{models:['anthropic/model'],efforts:['low','high']});
    const daemon=new Daemon();daemon.sessions=sessions;
    const options=await daemon.dispatch(M.MODEL_LIST,{id:'native-pi'});
    assert.deepEqual(options.modes,BASH_GUARD_MODES);
    const changing = sessions.setMode('native-pi','guard-off');
    await new Promise(resolve => setTimeout(resolve,100));
    assert.equal(sessions.get('native-pi').mode,'guard','sending the toggle is not confirmation');
    assert.deepEqual(host.writes,['\x1b[200~/bash-guard\x1b[201~','\r']);
    await sendHook('native-pi',{hook_event_name:'HelmSettings',model:'anthropic/model',effort:'low',mode:'guard-off',permissionControl:'bash-guard'});
    assert.equal((await changing).session.mode,'guard-off');
    assert.equal(sessions.get('native-pi').mode,'guard-off');
    assert.equal(sessions.get('native-pi').engineEffort,'low');
    await sendHook('native-pi',{hook_event_name:'HelmSettings',model:'anthropic/model',effort:'low',mode:'guard-off',permissionControl:'bash-guard',session_id:'pi-new-chat'});
    sessions.flush();
    const saved=JSON.parse(readFileSync(join(process.env.HELM_DIR,'sessions.json'))).sessions;
    assert.equal(saved.find(s=>s.id==='native-pi').permissionControl,'bash-guard');
    assert.equal(saved.find(s=>s.id==='native-pi').engineSessionId,'pi-new-chat');
    await sendHook('native-pi',{hook_event_name:'HelmSettings',model:'anthropic/model',effort:'off',mode:null,permissionControl:'none'});
    await assert.rejects(sessions.setMode('native-pi','guard-off'),/does not offer/);
    assert.deepEqual((await daemon.dispatch(M.MODEL_LIST,{id:'native-pi'})).modes,[]);
  } finally {await sessions.stop();}
});
test('every driven provider reports startup settings and partial init does not erase them',async()=>{
  const engines=['claude','codex','opencode','opencode2','devin','grok','cursor','agy','antigravity','pi','omp'];
  writeFileSync(join(process.env.HELM_DIR,'profiles.json'),JSON.stringify({profiles:engines.map(engine=>({id:engine,engine,cmd:engine}))}));
  const drivers=[];
  class Driver extends EventEmitter {
    constructor(opts){super();Object.assign(this,opts);this.engineSessionId=`session-${opts.engine}`;this.status='idle';drivers.push(this);}
    async start(){this.emit('init',{model:`${this.engine}/actual`,effort:'high',permissionMode:this.engine==='claude'?'acceptEdits':undefined});}
    async kill(){}
  }
  const runtime=new EventEmitter();
  const sessions=new Sessions(runtime,{nativeDiscovery:false,nativeHost:new Host(),makeDriver:(engine,opts)=>new Driver({engine,...opts})});
  try {
    for(const engine of engines){
      const s=await sessions.start({cwd:root,profileId:engine});
      assert.equal(s.engineModel,`${engine}/actual`);assert.equal(s.engineEffort,'high');
      if(engine==='claude')assert.equal(s.mode,'acceptEdits');
      drivers.at(-1).emit('init',{version:'new metadata'});
      assert.equal(s.engineModel,`${engine}/actual`);assert.equal(s.engineEffort,'high');
    }
    const selected=await sessions.start({cwd:root,profileId:'pi',model:'requested-alias',effort:'low'});
    assert.equal(selected.model,'pi/actual');assert.equal(selected.effort,'high','the accepted Pi level outranks the requested one');
  } finally{await sessions.stop();}
});
test('Pi adapter observes keyboard guard changes, reports live settings and leaves the footer intact',async()=>{
  const source=readFileSync(new URL('../packages/connect/extensions/helm-settings.ts',import.meta.url),'utf8').replace("'../src/claude-hooks.js'",JSON.stringify(pathToFileURL(join(process.cwd(),'packages/connect/src/claude-hooks.js')).href));
  const code=(await transform(source,{loader:'ts',format:'esm'})).code;
  const extension=(await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)).default;
  for(const present of [true,false]){
    const handlers=new Map(), statuses=[];
    let effort='high';
    const pi={on:(name,fn)=>handlers.set(name,fn),getThinkingLevel:()=>effort,getCommands:()=>present?[{name:'bash-guard'}]:[],getFlag:()=>false};
    const original=(key,text)=>statuses.push({key,text});
    const ctx={model:{provider:'provider',id:'model'},sessionManager:{getSessionId:()=> 'pi-session',getSessionFile:()=>undefined},ui:{setStatus:original}};
    extension(pi);await handlers.get('session_start')({},ctx);
    let state=JSON.parse(statuses.find(s=>s.key==='helm-settings').text);
    assert.equal(state.model,'provider/model');assert.equal(state.effort,'high');assert.equal(state.mode,present?'guard':null);
    ctx.ui.setStatus(' bash-guard', 'BG OFF');
    if(present){state=JSON.parse(statuses.filter(s=>s.key==='helm-settings').at(-1).text);assert.equal(state.mode,'guard-off');}
    assert.ok(statuses.some(s=>s.key===' bash-guard'&&s.text==='BG OFF'));
    await handlers.get('session_start')({reason:'new'},ctx);
    state=JSON.parse(statuses.filter(s=>s.key==='helm-settings').at(-1).text);
    assert.equal(state.mode,present?'guard-off':null,'a new conversation retains the running extension toggle');
    effort='off';ctx.model={provider:'other',id:'new'};await handlers.get('model_select')({},ctx);
    state=JSON.parse(statuses.filter(s=>s.key==='helm-settings').at(-1).text);assert.equal(state.model,'other/new');assert.equal(state.effort,'off');
    await handlers.get('session_shutdown')();assert.equal(ctx.ui.setStatus,original);
  }
  assert.deepEqual(piChatArgs(piChatArgs(['--model','p/m'])),piChatArgs(['--model','p/m']));
});


test('native startup flags distinguish enabling Claude bypass from actually selecting it',async()=>{
  const {nativeLaunchSettings}=await import('../packages/connect/src/native-settings.js');
  assert.deepEqual(nativeLaunchSettings('claude',['--allow-dangerously-skip-permissions']),{});
  assert.deepEqual(nativeLaunchSettings('claude',['--model','opus','--effort=xhigh','--dangerously-skip-permissions']),{model:'opus',effort:'xhigh',mode:'bypassPermissions'});
  assert.deepEqual(nativeLaunchSettings('pi',['--model','provider/model','--thinking','off']),{model:'provider/model',effort:'off'});
  assert.deepEqual(nativeLaunchSettings('codex',['--yolo']),{mode:'full'});
  const { reportedMode } = await import('../packages/connect/src/native-settings.js');
  assert.equal(reportedMode('codex',{approvalPolicy:'never',sandbox:{type:'dangerFullAccess'}}),'full');
  assert.equal(reportedMode('codex',{approvalPolicy:'on-request',sandbox:'workspace-write'}),'ask');
  assert.equal(reportedMode('codex',{}),undefined);
});
test('stopping a terminal Pi mid-reply presses Esc there, and never at its prompt',async()=>{
  const host=new Host(), sessions=new Sessions(new EventEmitter(),{nativeHost:host,nativeDiscovery:false});
  await sessions.hooks;
  try {
    await sendHook('native-pi',{hook_event_name:'Stop'});
    await sessions.interrupt('native-pi');
    assert.deepEqual(host.writes,[],'an idle Pi gets no keys');
    await sendHook('native-pi',{hook_event_name:'UserPromptSubmit'});
    assert.equal(sessions.get('native-pi').status,'working');
    await sessions.interrupt('native-pi');
    assert.deepEqual(host.writes,['\x1b']);
  } finally {await sessions.stop();}
});
