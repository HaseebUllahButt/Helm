import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLogReader } from '../scripts/build-log-reader.mjs';

let available;
before(async () => { ({available} = await buildLogReader({log:()=>{}})); });
const worker = String.raw`
import Module from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
const mode=process.env.USAGE_TEST_MODE;
const load=Module._load;
Module._load=function(name,...args){
  if(name.endsWith('.node')) {
    if(mode==='missing'){const e=Error('Missing private library');e.code='MODULE_NOT_FOUND';throw e;}
    if(mode==='old')return {};
    if(mode==='failure')return {extractUsageMessages(){throw Error('Private failure');}};
  }
  return load.call(this,name,...args);
};
const {devinSessionConsumption}=await import('./packages/connect/src/devin-usage.js');
const {usageReader,extractUsageMessages}=await import('./packages/connect/src/usage-native.js');
const file=join(process.env.HELM_DIR,'usage.db');
const db=new DatabaseSync(file);
db.exec('CREATE TABLE IF NOT EXISTS message_nodes(session_id TEXT, chat_message TEXT); DELETE FROM message_nodes;');
const insert=db.prepare('INSERT INTO message_nodes VALUES (?,?)');
for(const row of [
  '{bad}', 'null', '42', '[]', '{}',
  '{"message_id":"duplicate","message_id":"last","metadata":{"committed_credit_cost":2}}',
  JSON.stringify({message_id:'last',metadata:{committed_credit_cost:4},text:'large unused body'.repeat(10000)}),
  JSON.stringify({message_id:'unicode',metadata:{committed_credit_cost:'2.5',committed_acu_cost:1},text:'اردو 😀'}),
  '{"message_id":null,"metadata":{"committed_credit_cost":1000}}',
  '{"message_id":"null","metadata":null}',
  '{"message_id":"negative","metadata":{"committed_credit_cost":-1}}',
])insert.run('basic',row);
for(const row of [
  {message_id:'old',metadata:{response_dimensions:[{uid:'credit',kind:{CumulativeMetric:{value:100,prefix:'$',tail:' unit',plural_tail:' units'}}}]}},
  {message_id:'old',metadata:{response_dimensions:[{uid:'credit',kind:{CumulativeMetric:{value:2,prefix:'$',tail:' unit',plural_tail:' units'}}}]}},
  {message_id:'next',metadata:{response_dimensions:[{uid:'credit',kind:{CumulativeMetric:{value:3,prefix:'$',tail:' unit',plural_tail:' units'}}},{uid:'irrelevant',kind:{CumulativeMetric:{value:100}}}]}},
])insert.run('dimensions',JSON.stringify(row));
db.close();
const projected=extractUsageMessages([JSON.stringify({message_id:'small',metadata:{committed_credit_cost:2},text:'body'.repeat(10000)})]);
console.log(JSON.stringify({reader:usageReader,basic:devinSessionConsumption(file,'basic'),dimensions:devinSessionConsumption(file,'dimensions'),projectedBytes:projected?JSON.stringify(projected).length:null}));
`;

test('Rust usage extraction preserves totals, revisions, dimensions and JavaScript recovery', () => {
  const dir=mkdtempSync(join(tmpdir(),'helm-usage-native-'));
  try {
    let expected;
    for(const mode of ['javascript',...(available?['rust']:[]),'missing','old','failure']) {
      const result=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',worker],{
        env:{...process.env,HELM_DIR:dir,HELM_LOG_READER:mode==='javascript'?'javascript':'rust',USAGE_TEST_MODE:mode},encoding:'utf8',
      }));
      if(mode==='javascript')expected={basic:result.basic,dimensions:result.dimensions};
      else assert.deepEqual({basic:result.basic,dimensions:result.dimensions},expected,mode);
      assert.equal(result.reader,['rust','failure'].includes(mode)?'rust':'javascript');
      if(mode==='rust')assert.ok(result.projectedBytes<100,'message text stays outside the projected metadata');
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});
