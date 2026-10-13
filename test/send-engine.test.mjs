import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, symlinkSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
const root = mkdtempSync(join(homedir(), '.helm-send-test-'));
Object.assign(process.env, { HELM_DIR: join(root, 'state'), HELM_DB: join(root,'hub.sqlite'), HELM_SSH_DIR: join(root,'ssh'), HELM_PROCS_SOCKET: join(root,'procs.sock'), HELM_TERMINALS_SOCKET: join(root,'terminals.sock'), HELM_NO_SERVICE: '1' });
const { SendEngine } = await import('../packages/connect/src/send-engine.js');
const { SendReceiver } = await import('../packages/connect/src/send-receiver.js');
const { CopyReceiver } = await import('../packages/connect/src/copy-transport.js');
const { codeSigningInfo, codeKeyInfo } = await import('../packages/connect/src/code-transfer.js');
const { M } = await import('@helm/protocol');
const { scanSend } = await import('../packages/connect/src/send-plan.js');
let seq = 0;

async function fixture({ delay = 0, old = false } = {}) {
  const dir = join(root, `f${++seq}`); mkdirSync(dir, { recursive: true });
  const home = join(dir,'home'); mkdirSync(home);
  const keys = { ...codeSigningInfo(), codePubkey: codeKeyInfo().codePubkey };
  const net = { self:'aa11', machines:{ aa11:{id:'aa11',name:'Laptop',...keys}, bb22:{id:'bb22',name:'VM',...keys} }, devices:{ phone:{} }, revoked:{} };
  const received = new SendReceiver({ directory:join(dir,'receipts'), home });
  const receiver = new CopyReceiver({ network:()=>({...net,self:'bb22'}), sendReceiver:received, spawnProcess:(command,args,opts)=>importSpawn(command,args,{...opts,cwd:home}) });
  const wss = new WebSocketServer({ port:0 }); await new Promise(r=>wss.once('listening',r));
  net.machines.bb22.endpoints = [`http://127.0.0.1:${wss.address().port}`];
  const send = (ws, data) => { if(delay) setTimeout(()=> { if(ws.readyState===1) ws.send(JSON.stringify(data)); },delay/2); else if(ws.readyState===1) ws.send(JSON.stringify(data)); };
  wss.on('connection',ws=> {
    const link = { id:randomBytes(6).toString('hex'), send:(t,extra)=>send(ws,{t,...extra}) };
    ws.on('message',raw=> { const frame=JSON.parse(raw); if(delay) setTimeout(()=>receiver.handle(link,frame,'aa11'),delay/2); else receiver.handle(link,frame,'aa11'); });
    ws.on('close',()=>receiver.dropLink(link));
  });
  let opens=0, credentials=0; const events=[];
  const proxyDeps = { credential:async()=> { credentials++; if(delay) await new Promise(r=>setTimeout(r,delay)); return 'test'; }, socket: async url=> { opens++; if(delay) await new Promise(r=>setTimeout(r,delay)); const ws = new WebSocket(url); await new Promise((r,j)=> { ws.once('open',r); ws.once('error',j); }); return ws; } };
  const options = { network:()=>net, directory:join(dir,'jobs'), emit:e=>events.push(e), proxyDeps,
    rpc:async(_id,method,p)=> { if(method===M.ENV_INFO) return {sendV2:!old,home,precopiedHandoff:true}; if(method===M.FS_LIST) throw new Error('ENOENT'); if(method===M.SEND_RECEIPT) return received.status(p.jobId,'aa11'); throw new Error(`unexpected ${method}`); },
    copy:async(opts,deps)=> { if(deps.signal?.aborted) throw new Error('cancelled'); execFileSync('rsync',['-a','--mkpath',...(opts.filesFrom?[`--files-from=${opts.filesFrom}`,'--from0','-r']:[]),...opts.excludes.flatMap(x=>['--exclude',x]),...(opts.filterFile?['--from0','--filter',`merge ${opts.filterFile}`]:[]),opts.source+(statSync(opts.source).isDirectory()?'/':''),opts.targetFolder.replace(/^~\//,home+'/')+'/']); } };
  const engine = new SendEngine(options);
  return { dir,home,net,engine,options,receiver,received,events, metrics:()=>({opens,credentials}), async close() { await engine.stop(); await receiver.stop(); for(const ws of wss.clients) ws.terminate(); await new Promise(r=>wss.close(r)); } };
}
const { spawn:importSpawn } = await import('node:child_process');
const finished = async(f,path,extra={})=> { const {job}=f.engine.start({path,targetMachineId:'bb22',...extra},'phone'); const result=await f.engine.wait(job.id); assert.equal(result.phase,'done', result.error); return result; };
test.after(()=>rmSync(root,{recursive:true,force:true}));

test('encrypted tunnel publishes atomically, preserves modes/symlinks/env, and uses a warm socket for delta re-sends',async()=> {
  const f=await fixture(); try {
    const source=join(f.dir,'project'); mkdirSync(source); writeFileSync(join(source,'app'),'first'); chmodSync(join(source,'app'),0o751); writeFileSync(join(source,'.env'),'synthetic'); symlinkSync('missing',join(source,'broken'));
    let initial;
    const {job}=f.engine.start({path:source,targetMachineId:'bb22'},'phone');
    assert.equal(existsSync(join(f.home,'project')),false); initial=await f.engine.wait(job.id); assert.equal(initial.phase,'done',initial.error);
    assert.equal(readFileSync(join(initial.target.path,'.env'),'utf8'),'synthetic'); assert.equal(statSync(join(initial.target.path,'app')).mode&0o777,0o751);
    assert.equal(readdirSync(initial.target.path).includes('broken'),true);
    const unchanged=await finished(f,source); assert.equal(unchanged.target.path,initial.target.path); assert.equal(unchanged.again,true); assert.equal(unchanged.changed.files,0);
    writeFileSync(join(source,'app'),'second edit');
    const delta=await finished(f,source); assert.equal(delta.changed.files,1); assert.equal(readFileSync(join(delta.target.path,'app'),'utf8'),'second edit');
    assert.deepEqual(f.metrics(),{opens:1,credentials:1});
    await new Promise(r=>setTimeout(r,300));
    assert.ok(f.events.some(e=>e.job.phase==='done'));
    for (const id of new Set(f.events.map(e=>e.job.id))) { const times=f.events.filter(e=>e.job.id===id).map(e=>e.job.updatedAt); for(let i=1;i<times.length;i++) assert.ok(times[i]>=times[i-1]); } assert.equal(f.engine.list({},'phone').jobs.length,3);
  } finally { await f.close(); }
});

test('occupied default destinations select and remember a stable suffix; explicit file names and non-Git no-env work', async () => {
  const f=await fixture(); try {
    const source=join(f.dir,'occupied'); mkdirSync(source); writeFileSync(join(source,'data'),'sent'); writeFileSync(join(source,'.ENVrc'),'synthetic');
    mkdirSync(join(f.home,'occupied')); writeFileSync(join(f.home,'occupied','keep'),'original');
    const first=await finished(f,source,{includeEnv:false}); assert.match(first.target.path,/occupied-[a-f0-9]{8}$/); assert.equal(existsSync(join(first.target.path,'.ENVrc')),false);
    const second=await finished(f,source,{includeEnv:false}); assert.equal(second.target.path,first.target.path); assert.equal(second.changed.files,0);
    assert.equal(readFileSync(join(f.home,'occupied','keep'),'utf8'),'original');
    const file=join(f.dir,'source.txt'); writeFileSync(file,'one'); const sent=await finished(f,file,{destination:'~/renamed.txt'});
    assert.equal(sent.target.path,join(f.home,'renamed.txt')); assert.equal(readFileSync(sent.target.path,'utf8'),'one');
    writeFileSync(file,'two changed'); const again=await finished(f,file); assert.equal(again.target.path,sent.target.path); assert.equal(readFileSync(again.target.path,'utf8'),'two changed');
  } finally {await f.close();}
});

test('over 32 MiB, 20,001 files, empty directories and single files have no cap',async()=> {
  const f=await fixture(); try {
    const file=join(f.dir,'large.bin'); writeFileSync(file,randomBytes(33*1024*1024));
    const single=await finished(f,file); assert.equal(single.source.kind,'file'); assert.deepEqual(readFileSync(single.target.path),readFileSync(file));
    const source=join(f.dir,'many'); mkdirSync(source); mkdirSync(join(source,'empty'));
    for(let i=0;i<20001;i++) writeFileSync(join(source,`f${i}`),`x${i}`);
    const many=await finished(f,source); assert.equal(many.files.total,20001); assert.equal(readdirSync(many.target.path).length,20002);
    assert.equal(readFileSync(join(many.target.path,'f20000'),'utf8'),'x20000');
  } finally { await f.close(); }
});

test('Git history, staged/dirty/untracked files travel; ignored caches and excluded env do not',async()=> {
  const f=await fixture(); try {
    const source=join(f.dir,'repo'); mkdirSync(source); execFileSync('git',['init','-q',source]);
    writeFileSync(join(source,'.gitignore'),'cache/\n.env*\n'); writeFileSync(join(source,'tracked'),'before');
    execFileSync('git',['-C',source,'add','.']); execFileSync('git',['-C',source,'-c','user.name=Fixture','-c','user.email=fixture@example.com','commit','-qm','first']);
    writeFileSync(join(source,'tracked'),'dirty'); writeFileSync(join(source,'new'),'new'); writeFileSync(join(source,'.env.local'),'synthetic'); mkdirSync(join(source,'cache')); writeFileSync(join(source,'cache','ignored'),'ignored');
    const plan=await f.engine.plan({path:source},'phone'); assert.equal(plan.git.dirty,true); assert.equal(plan.defaultTarget,'bb22'); assert.deepEqual(plan.envFiles,['.env.local']);
    const first=await finished(f,source); assert.equal(existsSync(join(first.target.path,'.git','HEAD')),true); assert.equal(existsSync(join(first.target.path,'cache')),false);
    const excluded=await finished(f,source,{includeEnv:false}); assert.equal(existsSync(join(excluded.target.path,'.env.local')),false);
    assert.equal(execFileSync('git',['-C',excluded.target.path,'rev-parse','HEAD'],{encoding:'utf8'}).toString().trim(),execFileSync('git',['-C',source,'rev-parse','HEAD']).toString().trim());
  } finally { await f.close(); }
});

test('two simultaneous jobs progress; same destination is refused without mixing files',async()=> {
  const f=await fixture({delay:100}); try {
    const one=join(f.dir,'one'),two=join(f.dir,'two'); mkdirSync(one); mkdirSync(two); writeFileSync(join(one,'one'),'one'); writeFileSync(join(two,'two'),'two');
    const a=f.engine.start({path:one,targetMachineId:'bb22'},'phone').job, b=f.engine.start({path:two,targetMachineId:'bb22'},'phone').job;
    const [ra,rb]=await Promise.all([f.engine.wait(a.id),f.engine.wait(b.id)]); assert.equal(ra.phase,'done',ra.error); assert.equal(rb.phase,'done',rb.error);
    const dest=join(f.home,'shared'); const c=f.engine.start({path:one,targetMachineId:'bb22',destination:dest},'phone').job, d=f.engine.start({path:two,targetMachineId:'bb22',destination:dest},'phone').job;
    const results=await Promise.all([f.engine.wait(c.id),f.engine.wait(d.id)]); assert.equal(results.filter(j=>j.phase==='done').length,1); assert.match(results.find(j=>j.phase==='failed').error,/another send|destination/);
    assert.equal(readdirSync(dest).length,1);
  } finally { await f.close(); }
});

test('cancel stops both ends; persisted interrupted jobs resume the same stage and destination',async()=> {
  const f=await fixture({delay:100}); try {
    const source=join(f.dir,'resume'); mkdirSync(source); writeFileSync(join(source,'data'),randomBytes(5*1024*1024));
    const {job}=f.engine.start({path:source,targetMachineId:'bb22'},'phone');
    while(f.engine.status({jobId:job.id},'phone').job.phase!=='sending') await new Promise(r=>setTimeout(r,10));
    await new Promise(r=>setTimeout(r,300));
    const cancelled=await f.engine.cancel({jobId:job.id},'phone'); assert.equal(cancelled.job.phase,'cancelled'); assert.equal(existsSync(join(f.home,'resume')),false);
    await new Promise(r=>setTimeout(r,200));
    f.engine.retry({jobId:job.id},'phone'); const resumed=await f.engine.wait(job.id); assert.equal(resumed.phase,'done',resumed.error); assert.deepEqual(readFileSync(join(resumed.target.path,'data')),readFileSync(join(source,'data')));
    const record=JSON.parse(readFileSync(join(f.options.directory,`${job.id}.json`))); record.job.phase='sending'; writeFileSync(join(f.options.directory,`${job.id}.json`),JSON.stringify(record));
    const restarted=new SendEngine(f.options); assert.equal(restarted.status({jobId:job.id},'phone').job.phase,'interrupted'); restarted.retry({jobId:job.id},'phone'); const recovered=await restarted.wait(job.id); assert.equal(recovered.phase,'done',recovered.error); await restarted.stop();
  } finally { await f.close(); }
});

test('older target uses uncapped copy with a visible compatibility message; permissions checked',async()=> {
  const f=await fixture({old:true}); try {
    const source=join(f.dir,'old'); mkdirSync(source); writeFileSync(join(source,'data'),'data');
    const result=await finished(f,source); assert.match(result.error,/Older target/); assert.equal(readFileSync(join(f.home,'old','data'),'utf8'),'data');
    assert.throws(()=>f.engine.list({},'stranger'),/paired device/); assert.throws(()=>f.engine.status({jobId:'bad'},'phone'),/not found/);
  } finally { await f.close(); }
});

test('a SIGKILL of the source process leaves no published folder and a fresh process resumes its journal',async()=> {
  const f=await fixture({delay:100});
  const { spawn } = await import('node:child_process');
  const worker = `
    const {SendEngine} = await import(${JSON.stringify(new URL('../packages/connect/src/send-engine.js',import.meta.url).href)});
    const {spawn} = await import('node:child_process');
    let engine, serial=0; const pending=new Map();
    const rpc=(_target,method,params)=>new Promise((resolve,reject)=>{const id=++serial; pending.set(id,{resolve,reject});process.send({type:'rpc',id,method,params});});
    process.on('message',async m=>{
      if(m.type==='response') {const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error)):p.resolve(m.result);return;}
      if(m.type==='close') {await engine.stop();process.exit();}
      if(m.type==='start'||m.type==='retry') {
        engine=new SendEngine({network:()=>m.net,directory:m.directory,rpc,emit:e=>process.send({type:'progress',...e}),
          proxyDeps:{credential:async()=> 'test'},spawnProcess:(cmd,args,opts)=>spawn(cmd,['--bwlimit=1024',...args],opts)});
        const {job}=m.type==='start'?engine.start({path:m.path,targetMachineId:'bb22'},'phone'):engine.retry({jobId:m.jobId},'phone');
        process.send({type:'started',job});const result=await engine.wait(job.id);process.send({type:'done',job:result});
      }
    });`;
  let child;
  const launch = message => {
    child=spawn(process.execPath,['--input-type=module','-e',worker],{env:process.env,stdio:['ignore','pipe','pipe','ipc']});
    let stderr=''; child.stderr.on('data',c=>stderr+=c);
    child.on('message',async m=> { if(m.type==='rpc') {try {child.send({type:'response',id:m.id,result:await f.options.rpc('bb22',m.method,m.params)});}catch(e){child.send({type:'response',id:m.id,error:e.message});}} });
    const events=[];child.on('message',m=>events.push(m));
    const next = async predicate => { const until=Date.now()+15000;while(!events.some(predicate)) {if(Date.now()>until||child.exitCode!==null) throw new Error(`worker stopped or timed out: ${stderr}`);await new Promise(r=>setTimeout(r,10));}return events.find(predicate); };
    child.send({...message,net:f.net,directory:join(f.dir,'killed-jobs')}); return next;
  };
  try {
    const source=join(f.dir,'killed-source');mkdirSync(source);writeFileSync(join(source,'data'),randomBytes(3*1024*1024));
    const next=launch({type:'start',path:source});const {job}=await next(m=>m.type==='started');
    await next(m=>m.type==='progress'&&m.job.bytes.sent>0);
    await new Promise(r=>setTimeout(r,400));
    child.kill('SIGKILL');await new Promise(r=>child.once('close',r));
    assert.equal(existsSync(join(f.home,'killed-source')),false);
    while(f.receiver.streams.size||f.receiver.closing.size) await new Promise(r=>setTimeout(r,20));
    const resumed=launch({type:'retry',jobId:job.id}); const completed=await resumed(m=>m.type==='done');
    assert.equal(completed.job.phase,'done',completed.job.error);assert.equal(completed.job.id,job.id);
    assert.deepEqual(readFileSync(join(completed.job.target.path,'data')),readFileSync(join(source,'data')));
    child.send({type:'close'});await new Promise(r=>child.once('close',r));child=null;
  } finally {child?.kill('SIGKILL');await f.close();}
});

test('task.send uses the engine once, includes its marker in the atomic commit, and adopts one task session',async()=> {
  const f=await fixture();try {
    const {TaskTransfers}=await import('../packages/connect/src/task-transfer.js');
    const {Handoffs}=await import('../packages/connect/src/handoffs.js');
    const source=join(f.dir,'task-code');mkdirSync(source);writeFileSync(join(source,'app'),'code');writeFileSync(join(source,'.env'),'synthetic');
    const starts=[],inputs=[], destination={id:'fake-task',status:'working'};
    const handoffs=new Handoffs({network:()=>({...f.net,self:'bb22'}),file:join(f.dir,'handoffs.json'),profiles:async()=>[{id:'fixture',engine:'codex'}],sessions:{start:async p=>{starts.push(p);return destination;},input:async(...a)=>inputs.push(a), get:()=>destination, history:async()=>({events:[{type:'turn.done',status:'ok'}],pending:[]}), setTaskTransfer:(_id,taskTransfer)=>{destination.taskTransfer=taskTransfer;}}});
    const sender=new TaskTransfers({network:()=>f.net,sessions:{get:()=>null},sendEngine:f.engine,directory:join(f.dir,'tasks'),enqueue:async()=>{},rpc:async(target,method,p)=> {
      if(method===M.AGENT_LIST)return {agents:[{id:'fixture',engine:'codex',available:true,defaultMode:'read-only'}]};
      if(method===M.TASK_COLLECT)return handoffs.collect(p.handoffId,'aa11');
      if(method===M.TASK_RETURNED)return handoffs.returned(p,'aa11');
      assert.equal(method,M.HANDOFF_ACCEPT);assert.equal(p.returnToSource,true);assert.ok(p.envelope.data.length<2000);assert.equal(f.engine.list({},'phone').jobs[0].phase,'done');return handoffs.accept(p,'aa11');
    }});
    const params={handoffId:randomBytes(12).toString('hex'),folder:source,targetMachineId:'bb22',profileId:'fixture',prompt:'Fixture task only',returnToSource:true};
    let result=await sender.send(params,'phone');assert.equal(result.status,'copying');
    const until=Date.now()+5000;
    while(result.status==='copying') {if(Date.now()>until)throw new Error('task timed out');await new Promise(r=>setTimeout(r,20));result=await sender.send(params,'phone');}
    assert.equal(result.status,'running');await sender.send(params,'phone');assert.equal(starts.length,1);assert.equal(inputs.length,1);
    assert.equal(existsSync(join(result.receipt.folder,'.helm','handoff',`${params.handoffId}.json`)),true);
    assert.equal(readFileSync(join(result.receipt.folder,'.env'),'utf8'),'synthetic');assert.deepEqual(f.metrics(),{opens:1,credentials:1});
    writeFileSync(join(result.receipt.folder,'app'),'remote edit');destination.status='done';await sender.collect(params.handoffId);
    assert.equal(readFileSync(join(source,'app'),'utf8'),'remote edit');assert.equal(sender.status(params,'phone').return.status,'returned');
  }finally {await f.close();}
});

async function legacyTimingCopy(f, source, timing) {
  const {createServer}=await import('node:net');
  const {copyProxy}=await import('../packages/connect/src/copy-proxy.js');
  const {runCopy}=await import('../packages/connect/src/copy.js');
  const socketPath=join(f.dir,'legacy.sock'), sockets=new Set();
  const destination=join(f.home,'legacy-timed');
  const server=createServer(socket=> {
    sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.on('error',()=>{});
    let header=Buffer.alloc(0);
    const read=chunk=> {
      header=Buffer.concat([header,chunk]);const end=header.indexOf(10);if(end<0)return;
      socket.off('data',read);socket.pause();const {args}=JSON.parse(header.subarray(0,end));
      if(header.length>end+1)socket.unshift(header.subarray(end+1));
      copyProxy(['--machine','bb22','--target-folder',destination,'--',...args],{
        ...f.options.proxyDeps,network:f.net,input:socket,output:socket,stderr:{write(){}},timing,
      }).then(()=>socket.end(),()=>socket.destroy());
    };socket.on('data',read);
  });
  await new Promise(r=>server.listen(socketPath,r));
  const quote=s=>`'${String(s).replace(/'/g,"''")}'`;
  const remote=[process.execPath,new URL('../packages/connect/src/send-proxy.js',import.meta.url).pathname,socketPath,'legacy'].map(quote).join(' ');
  try {
    await runCopy({machine:'bb22',source,targetFolder:destination,retries:0},{network:f.net,stdout:{write(){}},stderr:{write(){}},spawnProcess:(cmd,args)=>{
      args[args.indexOf('-e')+1]=remote;return importSpawn(cmd,args);
    }});
  }finally {for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(r));}
}

if(process.env.HELM_SEND_BENCH) test('timing harness: cold adapters and warm jobs, 500 ms simulated RTT',async()=> {
  for(const reuse of [false,true]) {
    const f=await fixture({delay:500});const traces=[];const now=()=>Number(process.hrtime.bigint())/1e6;
    f.engine.reuseConnections=reuse;f.engine.timing=(step,details)=>traces.push({step,at:now(),...details});
    try {
      const source=join(f.dir,'timed');mkdirSync(source);for(let i=0;i<50;i++)writeFileSync(join(source,`f${i}`),randomBytes(i===49?20472:20984));
      if (!reuse) {
        for(const kind of ['first','unchanged']) {
          const before=[];const started=now();await legacyTimingCopy(f,source,(step,details)=>before.push({step,at:Math.round(now()-started),...details}));
          console.log('SEND_BENCH '+JSON.stringify({mode:'legacy-v1',kind,totalMs:now()-started,steps:before}));
        }
      }
      for(const kind of ['first','unchanged','delta']) {
        if(kind==='delta')writeFileSync(join(source,'f0'),randomBytes(4096));
        const started=now(), from=traces.length;const result=await finished(f,source);
        console.log('SEND_BENCH '+JSON.stringify({mode:reuse?'pooled':'cold-adapter',kind,totalMs:now()-started,changed:result.changed,connections:f.metrics(),steps:traces.slice(from).map(t=>({...t,at:Math.round(t.at-started)}))}));
      }
    }finally {await f.close();}
  }
});

test('lost receipts are recovered only with the target signature and the original job intent', async()=> {
  const f=await fixture();try {
    const source=join(f.dir,'signed-receipt');mkdirSync(source);writeFileSync(join(source,'data'),'data');
    const sent=await finished(f,source), r=f.engine.get(sent.id), received=f.received.jobs.get(sent.id);
    const signature=received.receipt.signature;received.receipt.signature='invalid';r.receipt=null;r.job.phase='interrupted';
    f.engine.retry({jobId:sent.id},'phone');const bad=await f.engine.wait(sent.id);assert.equal(bad.phase,'failed');assert.match(bad.error,/receipt did not verify/);
    received.receipt.signature=signature;f.engine.retry({jobId:sent.id},'phone');const good=await f.engine.wait(sent.id);assert.equal(good.phase,'done',good.error);assert.deepEqual(f.metrics(),{opens:1,credentials:1});
  }finally {await f.close();}
});

test('planning uses cached presence and a remembered target without hashing file bodies', async()=> {
  const f=await fixture();try {
    const source=join(f.dir,'presence');mkdirSync(source);writeFileSync(join(source,'data'),'data');
    f.engine.presence=()=>({bb22:{online:false}});const plan=await f.engine.plan({path:source},'phone');assert.equal(plan.targets[0].online,false);
    assert.equal(plan.defaultTarget,'bb22');const done=await finished(f,source);const again=await f.engine.plan({path:source},'phone');assert.deepEqual(again.targets[0].sentBefore,{at:done.finishedAt,jobId:done.id});assert.equal(again.targets[0].destination,done.target.path);
  }finally {await f.close();}
});
