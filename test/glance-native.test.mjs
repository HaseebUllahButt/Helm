import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deserialize } from 'node:v8';
import { buildLogReader } from '../scripts/build-log-reader.mjs';

let available;
before(async () => { ({ available } = await buildLogReader({ log: () => {} })); });

test('Rust startup scans preserve chat turns, pending approvals and damaged-record recovery', t => {
  if (!available) return t.skip('Rust is not installed. The JavaScript reader stays available.');
  const dir = mkdtempSync(join(tmpdir(), 'helm-glance-native-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rows = ['', 'null', '{bad}', '{"seq":1,"type":"turn.start","turnId":"old","text":"اردو 😀"}'];
  for (let n = 2; n < 2500; n++) {
    rows.push(n % 41 ? JSON.stringify({seq:n,type:'item.delta',text:'Ignored text '.repeat(20)}) : '');
  }
  rows.push(
    '{"seq":2500,"type":"permission.request","requestId":"closed"}',
    '{"seq":2501,"type":"permission.resolved","requestId":"closed"}',
    '{"seq":2502,"type":"permission.request","requestId":"open"}',
    '{"seq":2503,"type":"turn.start","type":"item.delta"}',
    '{"seq":2504,"type":"turn.start","nested":{"type":"permission.request"}}',
    '{"seq":2505,"type":"turn.done"}',
    '{"seq":2506,"type": "turn.start"}',
    '{"seq":2507,"type":"turn.done","text":"日本語"}',
    '{"seq":2508,"type":"permission.request","requestId":"unterminated"}',
  );
  writeFileSync(join(dir,'mixed.jsonl'), rows.join('\r\n'));
  writeFileSync(join(dir,'torn.jsonl'), rows.join('\n') + '\n{"seq":2509,"type":"turn.');
  writeFileSync(join(dir,'empty.jsonl'), '\n\n');
  writeFileSync(join(dir,'no-type.jsonl'), '{"seq":4}\n{"seq":0}\n{bad}\n');
  const code = `
    import {serialize} from 'node:v8';
    import {EventLog} from './packages/connect/src/events.js';
    import {nativeFunction} from './packages/connect/src/log-index-native.js';
    if(process.env.HELM_LOG_READER==='rust'&&!nativeFunction('scanGlancePositions'))throw Error('The Rust startup scanner did not load.');
    const log=new EventLog(process.argv[1]);
    const results=['mixed','torn','empty','no-type'].map(id=>[log.glance(id),log.glance(id),log.glance(id,{cache:false})]);
    process.stdout.write(serialize(results));
  `;
  const run = reader => deserialize(execFileSync(process.execPath,['--input-type=module','-e',code,dir], {
    env:{...process.env, HELM_LOG_READER:reader, HELM_DIR:join(dir,'private-helm')},
  }));
  assert.deepEqual(run('rust'),run('javascript'));
});

test('the shared loader returns no native feature when JavaScript is selected', () => {
  const output=execFileSync(process.execPath,['--input-type=module','-e',
    `import {nativeFunction} from './packages/connect/src/log-index-native.js';console.log(nativeFunction('scanGlancePositions'),nativeFunction('missing'));`],
  {env:{...process.env,HELM_LOG_READER:'javascript'},encoding:'utf8'});
  assert.equal(output.trim(),'null null');
});
