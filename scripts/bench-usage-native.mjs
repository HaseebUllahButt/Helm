import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if(process.argv[2]==='--read') {
  const {devinSessionConsumption}=await import('../packages/connect/src/devin-usage.js');
  const {usageReader}=await import('../packages/connect/src/usage-native.js');
  if(usageReader!==process.env.HELM_LOG_READER)throw Error('The requested usage reader did not load.');
  global.gc();const heap=process.memoryUsage().heapUsed,start=performance.now();
  const result=devinSessionConsumption(process.argv[3],'chat'),ms=performance.now()-start;
  global.gc();
  console.log(JSON.stringify({ms,result,heap:process.memoryUsage().heapUsed-heap,rss:process.resourceUsage().maxRSS*1024}));
} else {
  const dir=mkdtempSync(join(tmpdir(),'helm-usage-bench-'));
  try {
    for(const [name,count,chars] of [['short',100,100],['long-tool-output',1000,40000]]) {
      const file=join(dir,name+'.db'),db=new DatabaseSync(file);
      db.exec('CREATE TABLE message_nodes(session_id TEXT,chat_message TEXT); BEGIN;');
      const insert=db.prepare('INSERT INTO message_nodes VALUES (?,?)');
      for(let n=0;n<count;n++)insert.run('chat',JSON.stringify({message_id:String(n),metadata:{committed_credit_cost:0.25},text:'text '.repeat(chars/5)}));
      db.exec('COMMIT;');db.close();
      const runs={javascript:[],rust:[]};
      for(let n=0;n<3;n++)for(const reader of n%2?['rust','javascript']:['javascript','rust']) {
        runs[reader].push(JSON.parse(execFileSync(process.execPath,['--expose-gc',fileURLToPath(import.meta.url),'--read',file],{
          env:{...process.env,HELM_LOG_READER:reader,HELM_DIR:join(dir,'private-helm')},encoding:'utf8',
        })));
      }
      if(new Set(Object.values(runs).flat().map(r=>JSON.stringify(r.result))).size!==1)throw Error('Usage totals differ.');
      const median=xs=>xs.toSorted((a,b)=>a-b)[1];
      console.log(JSON.stringify({name,...Object.fromEntries(Object.entries(runs).map(([reader,rows])=>[reader,{
        ms:Math.round(median(rows.map(r=>r.ms))*10)/10,
        retainedMiB:Math.round(median(rows.map(r=>r.heap))/104857.6)/10,
        peakMiB:Math.round(median(rows.map(r=>r.rss))/104857.6)/10,
      }]))}));
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
}
