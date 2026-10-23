// Compare startup chat scans using private generated histories and separate processes.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if(process.argv[2]==='--read') {
  const {EventLog}=await import('../packages/connect/src/events.js');
  const {nativeFunction}=await import('../packages/connect/src/log-index-native.js');
  const reader=nativeFunction('scanGlancePositions')?'rust':'javascript';
  if(reader!==process.env.HELM_LOG_READER)throw Error('The requested startup scanner did not load.');
  global.gc();const heap=process.memoryUsage().heapUsed;
  const log=new EventLog(process.argv[3]),start=performance.now();
  const results=Array.from({length:40},(_,n)=>log.glance(`chat-${n}`));
  const ms=performance.now()-start;
  const digest=createHash('sha256').update(JSON.stringify(results)).digest('hex');
  global.gc();
  console.log(JSON.stringify({ms,digest,heap:process.memoryUsage().heapUsed-heap,rss:process.resourceUsage().maxRSS*1024}));
} else {
  const dir=mkdtempSync(join(tmpdir(),'helm-glance-bench-'));
  try {
    for(const [name,deltas] of [['short',20],['long',20000]]) {
      for(let c=0;c<40;c++) {
        const rows=[JSON.stringify({seq:1,type:'turn.start',text:'Private question',turnId:'first'})];
        for(let n=2;n<=deltas+1;n++)rows.push(JSON.stringify({seq:n,type:'item.delta',text:'Words '.repeat(100)}));
        rows.push(JSON.stringify({seq:deltas+2,type:'turn.done',turnId:'first',status:'ok'}));
        writeFileSync(join(dir,`chat-${c}.jsonl`),rows.join('\n')+'\n');
      }
      const runs={javascript:[],rust:[]};
      for(let n=0;n<3;n++)for(const reader of n%2?['rust','javascript']:['javascript','rust']) {
        runs[reader].push(JSON.parse(execFileSync(process.execPath,['--expose-gc',fileURLToPath(import.meta.url),'--read',dir],{
          env:{...process.env,HELM_LOG_READER:reader,HELM_DIR:join(dir,'private-helm')},encoding:'utf8',
        })));
      }
      if(new Set(Object.values(runs).flat().map(r=>r.digest)).size!==1)throw Error('Startup scans returned different chat states.');
      const median=rows=>rows.toSorted((a,b)=>a-b)[1];
      console.log(JSON.stringify({name,...Object.fromEntries(Object.entries(runs).map(([reader,rows])=>[reader,{
        ms:Math.round(median(rows.map(r=>r.ms))*10)/10,
        retainedMiB:Math.round(median(rows.map(r=>r.heap))/104857.6)/10,
        peakMiB:Math.round(median(rows.map(r=>r.rss))/104857.6)/10,
      }]))}));
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
}
