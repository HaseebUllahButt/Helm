import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'helm-previous-release-'));
process.env.HELM_DIR = join(root, 'state');
const { selfUpdate, rollbackPreviousRelease, makeBundle, syncFromBundle } = await import('../packages/connect/src/update.js');
const moduleUrl = new URL('../packages/connect/src/update.js', import.meta.url).href;
const gitBin = execFileSync('/bin/sh', ['-c', 'command -v git'], {encoding:'utf8'}).trim();
const git = (dir, ...args) => execFileSync(gitBin, ['-C', dir, ...args], {encoding:'utf8', stdio:'pipe'}).trim();
const put = (dir, file, text) => {mkdirSync(join(dir,file,'..'),{recursive:true});writeFileSync(join(dir,file),text);};
const journal = () => join(process.env.HELM_DIR, 'update-state.json');
const checkpointFile = () => join(process.env.HELM_DIR, 'previous-release.json');
test.after(() => rmSync(root,{recursive:true,force:true}));
async function fixture(t) {
  const base = mkdtempSync(join(root,'case-'));
  const remote = join(base,'remote'), dir = join(base,'installed'), bin = join(base,'bin');
  mkdirSync(bin);
  git(base,'init','-qb','main',remote);
  git(remote,'config','user.name','test');git(remote,'config','user.email','test@example.invalid');
  put(remote,'.gitignore','node_modules/\ndist/\n*.node\n');put(remote,'source','old source');
  put(remote,'package-lock.json','{}');
  git(remote,'add','.');git(remote,'commit','-qm','old');git(base,'clone','-q',remote,dir);
  const previous = git(dir,'rev-parse','HEAD');
  put(dir,'apps/web/dist/index.html','old app');put(dir,'node_modules/example/index.js','old dependency');
  put(dir,'native/log-index/log-index.old.node','old reader');
  put(remote,'source','new source');git(remote,'commit','-qam','new');
  const target = git(remote,'rev-parse','HEAD');
  put(bin,'npm',`#!${process.execPath}
const fs = require('node:fs');
for (const [file, value] of [['apps/web/dist/index.html','new app'],['node_modules/example/index.js','new dependency'],['native/log-index/log-index.new.node','new reader']]) {
 fs.mkdirSync(require('node:path').dirname(file), {recursive:true}); fs.writeFileSync(file,value);
}
`);chmodSync(join(bin,'npm'),0o755);
  const path=process.env.PATH;process.env.PATH=`${bin}:${path}`;
  t.after(()=> {process.env.PATH=path;rmSync(journal(),{force:true});});
  await selfUpdate(dir,{restart:false});
  const checkpoint = JSON.parse(readFileSync(checkpointFile()));
  return {dir,remote,bin,base,previous,target,checkpoint};
}
function oldFiles(f) {
  assert.equal(git(f.dir,'rev-parse','HEAD'),f.previous);
  assert.equal(readFileSync(join(f.dir,'apps/web/dist/index.html'),'utf8'),'old app');
  assert.equal(readFileSync(join(f.dir,'node_modules/example/index.js'),'utf8'),'old dependency');
  assert.equal(readFileSync(join(f.dir,'native/log-index/log-index.old.node'),'utf8'),'old reader');
  assert.equal(existsSync(join(f.dir,'native/log-index/log-index.new.node')),false);
}
function newFiles(f) {
  assert.equal(git(f.dir,'rev-parse','HEAD'),f.target);
  assert.equal(readFileSync(join(f.dir,'apps/web/dist/index.html'),'utf8'),'new app');
  assert.equal(readFileSync(join(f.dir,'node_modules/example/index.js'),'utf8'),'new dependency');
}
test('successful startup retains a complete previous release and reachable source',async t=>{
  const f=await fixture(t);
  assert.equal(git(f.dir,'rev-parse',f.checkpoint.ref),f.previous);
  assert.equal(existsSync(join(process.env.HELM_DIR,f.checkpoint.artifacts.id)),true);
  assert.equal(existsSync(journal()),false);
  assert.equal((await rollbackPreviousRelease(f.dir,{restart:false})).updated,true);oldFiles(f);
  // The release we left remains reachable too.
  const retained=JSON.parse(readFileSync(checkpointFile()));
  assert.equal(git(f.dir,'rev-parse',retained.ref),f.target);
});
test('a later release replaces only the older checkpoint',async t=>{
  const f=await fixture(t);put(f.remote,'source','third source');git(f.remote,'commit','-qam','third');
  await selfUpdate(f.dir,{restart:false});
  const saved=JSON.parse(readFileSync(checkpointFile()));
  assert.equal(saved.previousHead,f.target);
  assert.equal(existsSync(join(process.env.HELM_DIR,f.checkpoint.artifacts.id)),false);
  assert.equal(git(f.dir,'rev-parse',saved.ref),f.target);
  assert.equal(readdirSync(process.env.HELM_DIR).filter(p=>p.startsWith('update-backup-')).length,1);
});
for(const change of ['unstaged','staged','untracked','commit','branch','hidden','operation']) {
 test(`rollback preserves later owner ${change} changes`,async t=>{
  const f=await fixture(t);
  if(change==='branch')git(f.dir,'checkout','-qb','owner-choice');
  else if(change==='operation')put(f.dir,'.git/MERGE_HEAD',f.target);
  else {
   put(f.dir,change==='untracked'?'notes':'source','owner change');
   if(change==='staged'||change==='commit')git(f.dir,'add','source');
   if(change==='commit')git(f.dir,'-c','user.name=test','-c','user.email=test@example.invalid','commit','-qm','owner');
   if(change==='hidden')git(f.dir,'update-index','--assume-unchanged','source');
  }
  const head=git(f.dir,'rev-parse','HEAD'),status=git(f.dir,'status','--porcelain'),index=git(f.dir,'ls-files','-v');
  if(change==='operation')await assert.rejects(rollbackPreviousRelease(f.dir,{restart:false}),/Finish the source change/);
  else if(change==='hidden')await assert.rejects(rollbackPreviousRelease(f.dir,{restart:false}),/hidden edits/);
  else assert.equal((await rollbackPreviousRelease(f.dir,{restart:false})).updated,false);
  assert.equal(git(f.dir,'rev-parse','HEAD'),head);assert.equal(git(f.dir,'status','--porcelain'),status);
  assert.equal(git(f.dir,'ls-files','-v'),index);
  assert.equal(readFileSync(checkpointFile(),'utf8'),JSON.stringify(f.checkpoint));
 });
}
function wrapReset(f,body) {
 put(f.bin,'git',`#!${process.execPath}
const {spawnSync}=require('node:child_process'); const fs=require('node:fs');
const args=process.argv.slice(2); const result=spawnSync(${JSON.stringify(gitBin)},args,{stdio:'inherit'});
if(result.status===0&&args.includes('reset')&&args.at(-1)===${JSON.stringify(f.previous)}) {${body}}
process.exit(result.status??1);
`);chmodSync(join(f.bin,'git'),0o755);
}
test('failed rollback restores the installed files and retains its recovery journal',async t=>{
 const f=await fixture(t);
 const index=f.checkpoint.artifacts.paths.findIndex(p=>p.path==='apps/web/dist');
 const saved=join(process.env.HELM_DIR,f.checkpoint.artifacts.id,String(index),'index.html');
 // Removing one saved file after the source switch makes restoration fail.
 // Remove its containing folder too so the validation catches a missing copy.
 const folder=join(saved,'..');
 wrapReset(f,`fs.renameSync(${JSON.stringify(folder)},${JSON.stringify(folder+'.kept')});`);
 await assert.rejects(rollbackPreviousRelease(f.dir,{restart:false}),/saved update files/);
 newFiles(f);assert.equal(existsSync(journal()),true);
 assert.equal(JSON.parse(readFileSync(journal())).phase,'prepared');
 assert.equal(readFileSync(checkpointFile(),'utf8'),JSON.stringify(f.checkpoint));
 rmSync(join(f.bin,'git'));(await import('node:fs')).renameSync(folder+'.kept',folder);
 assert.equal((await rollbackPreviousRelease(f.dir,{restart:false})).updated,true);oldFiles(f);
});
test('SIGKILL during rollback recovers from the atomic journal before retry',async t=>{
 const f=await fixture(t);wrapReset(f,`process.kill(process.ppid,'SIGKILL');`);
 const child=spawn(process.execPath,['--input-type=module','-e',`const m=await import(${JSON.stringify(moduleUrl)});await m.rollbackPreviousRelease(${JSON.stringify(f.dir)},{restart:false});`],{env:process.env,stdio:'pipe'});
 const [code,signal]=await once(child,'exit');assert.equal(code,null);assert.equal(signal,'SIGKILL');
 assert.equal(existsSync(journal()),true);assert.equal(readFileSync(checkpointFile(),'utf8'),JSON.stringify(f.checkpoint));
 rmSync(join(f.bin,'git'));
 assert.equal((await rollbackPreviousRelease(f.dir,{restart:false})).updated,true);oldFiles(f);
});

test('peer sync keeps an owner rollback until a newer release arrives',async t=>{
 const f=await fixture(t);
 await rollbackPreviousRelease(f.dir,{restart:false});
 const rejected=await makeBundle({},f.remote);
 const result=await syncFromBundle(rejected.bundle,f.dir,{restart:false});
 assert.equal(result.updated,false);assert.match(result.reason,/restored release/);oldFiles(f);
 put(f.remote,'source','newer fixed source');git(f.remote,'commit','-qam','fixed');
 const fixed=await makeBundle({},f.remote);
 assert.equal((await syncFromBundle(fixed.bundle,f.dir,{restart:false})).updated,true);
 assert.equal(git(f.dir,'rev-parse','HEAD'),git(f.remote,'rev-parse','HEAD'));
 assert.equal(existsSync(join(process.env.HELM_DIR,'rollback-hold.json')),false);
});

test('rollback leaves an existing agent alive with the restored files',async t=>{
 const f=await fixture(t);
 const agent=spawn(process.execPath,['-e',`process.on('message',()=>process.send(require('node:fs').readFileSync('node_modules/example/index.js','utf8')));process.send('ready');`],
  {cwd:f.dir,stdio:['ignore','ignore','ignore','ipc']});
 t.after(async()=>{if(agent.exitCode===null&&agent.signalCode===null){const exited=once(agent,'exit');agent.kill();await exited;}});
 assert.equal((await once(agent,'message'))[0],'ready');
 await rollbackPreviousRelease(f.dir,{restart:false});
 const answer=once(agent,'message');agent.send('read');assert.equal((await answer)[0],'old dependency');
 assert.equal(agent.exitCode,null);
});
