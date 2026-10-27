import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deserialize } from 'node:v8';
import { pathToFileURL } from 'node:url';
import { buildLogReader } from '../scripts/build-log-reader.mjs';
import { binaryPath, buildId } from '../native/log-index/build-id.mjs';

let available;
before(async () => { ({ available } = await buildLogReader({ log: () => {} })); });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'helm-rust-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function run(reader, code, args = []) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', code, ...args], {
    env: { ...process.env, HELM_LOG_READER: reader }, encoding: null,
  });
}

test('Rust and JavaScript agree on positions, contexts and cached tails for valid and damaged JSON', t => {
  if (!available) return t.skip('Rust is not installed. The JavaScript reader stays available.');
  const dir = fixture(t), file = join(dir, 'chat.jsonl');
  const rows = [
    'null', '4', 'true', '[1,"turn.start"]', '{bad}', '',
    '{"seq":1,"seq":2,"type":"turn.start","text":"duplicate sequence"}',
    '{"seq":3,"type":"item.start","type":"item.delta"}',
    '{"seq":4,"type":{}}', '{"seq":5,"type":[]}',
    '{"seq":6,"type":null}', '{"seq":"7"}', '{"seq":8,"type":false}',
    '{"seq":1e999,"type":"item.delta"}', '{"seq":9,"value":1e999}',
    '{"s\\u0065q":10,"ty\\u0070e":"turn.start"}',
    '{"seq":11,"type":"turn.\\ud800","text":"\\udfff"}',
    '{"seq":12,"text":"bad\u0001"}',
    '\ufeff{"seq":13,"type":"item.delta"}',
    '{"seq":14,"text":' + '['.repeat(200) + '0' + ']'.repeat(200) + '}',
  ];
  for (let n = 0; n < 3000; n++) {
    const type = ['turn.start', 'turn.done', 'item.start', 'item.done', 'item.delta', null, 1, {}][n % 8];
    const row = JSON.stringify({ text: 'اردو 日本語 😀 \\" \n'.repeat(n % 40), nested: { seq: -1, type: 'turn.start' }, type, seq: n + 20 });
    rows.push(n % 19 === 0 ? row.slice(0, -2) : row);
  }
  writeFileSync(file, Buffer.concat([Buffer.from(rows.join('\r\n') + '\n'), Buffer.from('{"seq":4000,"text":"'), Buffer.from([0xff]), Buffer.from('"}\n{"seq":4001,"type":"turn.done"}') ]));
  const code = `
    import {serialize} from 'node:v8';
    import {EventFile} from './packages/connect/src/event-file.js';
    import {logReader} from './packages/connect/src/log-index-native.js';
    if(logReader!==process.env.HELM_LOG_READER)throw Error('The requested reader did not load.');
    const file=new EventFile(process.argv[1]);let tail;
    file.refresh(f=>{tail=[...f.view()].slice(-15)},15);
    process.stdout.write(serialize({starts:file.starts,ends:file.ends,seqs:file.seqs,contexts:file.contexts,
      summaries:file.summaries,turns:file.turns,first:file.first,complete:file.complete,tail}));
  `;
  assert.deepEqual(deserialize(run('rust', code, [file])), deserialize(run('javascript', code, [file])));
});

test('cold chat opens and earlier pages return identical text, approvals and queued messages', t => {
  if (!available) return t.skip('Rust is not installed. The JavaScript reader stays available.');
  const dir = fixture(t), rows = []; let seq=0;
  const put = event => rows.push(JSON.stringify({ seq: ++seq, at: seq, ...event }));
  put({type:'turn.start',turnId:'local-waiting',text:'Keep my waiting message',queued:true,delivery:'queue'});
  for(let n=0;n<90;n++) {
    put({type:'turn.start',turnId:`t${n}`,text:`Question ${n}`});
    put({type:'item.start',turnId:`t${n}`,id:`a${n}`,kind:'text'});
    for(let d=0;d<40;d++)put({type:'item.delta',id:`a${n}`,text:`Words ${n} 😀 `});
    put({type:'item.done',id:`a${n}`,status:'ok'});
    put({type:'turn.done',turnId:`t${n}`,status:'ok'});
  }
  put({type:'permission.request',requestId:'answer-me',kind:'command',title:'Run a check',options:[]});
  writeFileSync(join(dir,'chat.jsonl'),rows.join('\n')+'\n');
  const code = `
    import {serialize} from 'node:v8';import {EventLog} from './packages/connect/src/events.js';
    const log=new EventLog(process.argv[1]);
    process.stdout.write(serialize({tail:log.window('chat',{tail:200}),older:log.window('chat',{before:3000,tail:200}),
      pending:log.pending('chat'),since:log.since('chat',3800)}));
  `;
  assert.deepEqual(deserialize(run('rust',code,[dir])),deserialize(run('javascript',code,[dir])));
});

test('a missing, stale or incompatible Rust binary keeps chat reading available', t => {
  const dir = fixture(t), native = join(dir,'native/log-index'), loader = join(dir,'packages/connect/src');
  mkdirSync(loader,{recursive:true});
  cpSync('native/log-index', native, {recursive:true, filter:src=>!src.includes('/target')&&!src.endsWith('.node')});
  cpSync('packages/connect/src/log-index-native.js',join(loader,'log-index-native.js'));
  writeFileSync(join(dir,'package.json'),'{"type":"module"}');
  const probe = `import {logReader,scanEventPositions} from ${JSON.stringify(pathToFileURL(join(loader,'log-index-native.js')).href)};console.log(logReader,scanEventPositions(Buffer.from('{}')));`;
  assert.equal(run('rust',probe).toString().trim(),'javascript null');
  const filename = binaryPath(native);
  writeFileSync(filename,'not a shared library');
  assert.equal(run('rust',probe).toString().trim(),'javascript null');
  const old = buildId(native);
  writeFileSync(join(native,'src/lib.rs'),readFileSync(join(native,'src/lib.rs'),'utf8')+'\n// Different build.\n');
  assert.notEqual(buildId(native),old);
  assert.notEqual(binaryPath(native),filename);
  assert.equal(run('rust',probe).toString().trim(),'javascript null');
});
