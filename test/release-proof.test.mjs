import test from 'node:test';
import assert from 'node:assert/strict';
import { proveRelease } from '../packages/connect/src/release-proof.js';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('failed private checks still stop the exact private copy', async () => {
  const calls=[];
  await assert.rejects(proveRelease({ directory:'/private/release',tip:'a'.repeat(40), log:()=>{}, run:async (program,args,options) => {
    calls.push(args); assert.equal(program,process.execPath); assert.equal(options.cwd,'/private/release');
    if(args[0].endsWith('/release-proof.mjs')) throw new Error('terminated private proof');
    return {stdout:'cleaned'};
  }}), /private chat recovery check failed/);
  assert.equal(calls.length,2);
  assert.equal(calls[0][2],calls[1][2]);
  assert.deepEqual(calls[1].slice(3),['down']);
  assert.equal(calls[0][4],'a'.repeat(40));
});

test('a fresh source copy gets a private build without replacing its existing app', async t => {
  const root=mkdtempSync(join(tmpdir(),'helm-proof-build-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=join(root,'source'); mkdirSync(source);
  const put=(name,data)=>{const file=join(source,name);mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,data);};
  put('package.json',JSON.stringify({private:true,workspaces:['apps/*']}));
  put('apps/web/package.json',JSON.stringify({name:'@helm/web',scripts:{build:'node build.cjs'}}));
  put('apps/web/build.cjs',"const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html','private candidate');");
  put('packages/protocol/value','current source');
  put('.gitignore','node_modules/\ndist/\n');
  const git=(...args)=>execFileSync('git',['-C',source,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-q');git('add','.');git('-c','user.name=Test','-c','user.email=test@localhost','commit','-qm','fixture');
  const tip=git('rev-parse','HEAD');
  put('apps/web/dist/index.html','keep this app');
  const dependencies=join(root,'dependencies');mkdirSync(join(dependencies,'node_modules/@helm'),{recursive:true});
  mkdirSync(join(dependencies,'packages/protocol'),{recursive:true});
  writeFileSync(join(dependencies,'packages/protocol/value'),'old external source');
  symlinkSync('../../packages/protocol',join(dependencies,'node_modules/@helm/protocol'));
  const external=join(root,'external-package');mkdirSync(external);
  writeFileSync(join(external,'package.json'),JSON.stringify({name:'external-package'}));
  writeFileSync(join(external,'value'),'keep external files');
  symlinkSync(external,join(dependencies,'node_modules/external-package'));
  put('apps/web/build.cjs',"const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html','private candidate');fs.writeFileSync('../../node_modules/external-package/value','candidate only');");
  git('add','apps/web/build.cjs');git('-c','user.name=Test','-c','user.email=test@localhost','commit','-qm','check external dependency links');
  const buildTip=git('rev-parse','HEAD');
  symlinkSync(join(dependencies,'node_modules'),join(source,'node_modules'));
  let candidate;
  await proveRelease({directory:source,tip:buildTip,prepare:true,log:()=>{},run:async (_,args,options)=>{
    candidate=options.cwd;
    if(args[0].endsWith('/release-proof.mjs')) {
      assert.equal(readFileSync(join(candidate,'apps/web/dist/index.html'),'utf8'),'private candidate');
      assert.equal(readFileSync(join(candidate,'node_modules/@helm/protocol/value'),'utf8'),'current source');
      assert.ok(realpathSync(join(candidate,'node_modules/@helm/protocol')).startsWith(candidate));
      assert.equal(readFileSync(join(candidate,'node_modules/external-package/value'),'utf8'),'candidate only');
    }
    return {stdout:'private proof'};
  }});
  assert.equal(readFileSync(join(source,'apps/web/dist/index.html'),'utf8'),'keep this app');
  assert.equal(existsSync(candidate),false);
  assert.equal(readFileSync(join(external,'value'),'utf8'),'keep external files');
});
