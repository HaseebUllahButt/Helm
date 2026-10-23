// Compare the Rust transcript filter with the JavaScript reader on generated
// private transcripts. Each reader runs in its own process. Run after
// `node scripts/build-log-reader.mjs`.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const transcriptModule = fileURLToPath(new URL('../packages/connect/src/transcript.js', import.meta.url));

/** A deterministic random source, so both readers see the same files. */
export function random(seed = 1) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['fix', 'the', 'build', 'اردو', '😀', 'naïve', '中文', 'test', '"quoted"', 'back\\slash', 'tab\there', 'line\nbreak'];
const words = (rand, n) => Array.from({ length: n }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(' ');

/** Lines a long Codex rollout holds: mostly tool output, reasoning and events. */
export function codexLines(rand, count, { big = 20_000 } = {}) {
  const lines = [{ type: 'session_meta', payload: { cli_version: '1.2.3', cwd: '/work', model_provider: 'openai' } }];
  for (let i = 0; i < count; i++) {
    const at = `2026-10-23T00:00:${String(i % 60).padStart(2, '0')}Z`;
    const pick = rand();
    if (pick < 0.08) lines.push({ type: 'response_item', timestamp: at, payload: { type: 'message', role: rand() < 0.5 ? 'user' : 'assistant', id: `m${i}`, content: [{ type: rand() < 0.5 ? 'input_text' : 'output_text', text: words(rand, 30) }] } });
    else if (pick < 0.16) lines.push({ type: 'response_item', timestamp: at, payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: words(rand, 6) }), call_id: `c${i}` } });
    else if (pick < 0.40) lines.push({ type: 'response_item', timestamp: at, payload: { type: 'function_call_output', call_id: `c${i}`, output: words(rand, big / 6) } });
    else if (pick < 0.55) lines.push({ type: 'response_item', timestamp: at, payload: { type: 'reasoning', summary: [], encrypted_content: 'gAAAA'.repeat(big / 10) } });
    else if (pick < 0.80) lines.push({ type: 'event_msg', timestamp: at, payload: { type: 'exec_command_end', aggregated_output: words(rand, big / 6) } });
    else if (pick < 0.88) lines.push({ type: 'event_msg', timestamp: at, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: i, output_tokens: i * 2 }, last_token_usage: { input_tokens: 1 }, model_context_window: 200000 }, rate_limits: { primary: i } } });
    else if (pick < 0.92) lines.push({ type: 'turn_context', timestamp: at, payload: { cwd: '/work', model: 'gpt', effort: 'high' } });
    else if (pick < 0.96) lines.push({ type: 'event_msg', timestamp: at, payload: { type: rand() < 0.5 ? 'task_started' : 'task_complete' } });
    else lines.push({ type: 'response_item', timestamp: at, payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: words(rand, 200) }] } });
  }
  return lines.map(line => JSON.stringify(line));
}

/** Lines a long Claude log holds: mostly tool results, thinking and progress. */
export function claudeLines(rand, count, { big = 20_000 } = {}) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    const at = `2026-10-23T00:00:${String(i % 60).padStart(2, '0')}Z`;
    const id = `msg_${Math.floor(i / 3)}`;
    const sidechain = rand() < 0.05 ? { isSidechain: true } : {};
    const usage = { input_tokens: i, output_tokens: 3, cache_read_input_tokens: 7 };
    const pick = rand();
    if (pick < 0.08) lines.push({ type: 'user', uuid: `u${i}`, timestamp: at, ...sidechain, message: { role: 'user', content: words(rand, 20) } });
    else if (pick < 0.18) lines.push({ type: 'assistant', uuid: `a${i}`, timestamp: at, ...sidechain, message: { id, model: 'claude', usage, content: [{ type: 'text', text: words(rand, 40) }] } });
    else if (pick < 0.28) lines.push({ type: 'assistant', uuid: `a${i}`, timestamp: at, ...sidechain, message: { id, model: 'claude', usage, content: [{ type: 'tool_use', name: 'Bash', input: { command: words(rand, 5), description: words(rand, 4) } }] } });
    else if (pick < 0.38) lines.push({ type: 'assistant', uuid: `a${i}`, timestamp: at, ...sidechain, message: { id, model: 'claude', usage, content: [{ type: 'thinking', thinking: words(rand, big / 12), signature: 'x'.repeat(400) }] } });
    else if (pick < 0.75) lines.push({ type: 'user', uuid: `r${i}`, timestamp: at, ...sidechain, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: [{ type: 'text', text: words(rand, big / 6) }] }] }, toolUseResult: { stdout: words(rand, big / 6) } });
    else if (pick < 0.90) lines.push({ type: 'progress', timestamp: at, data: { output: words(rand, big / 12) } });
    else lines.push({ type: 'file-history-snapshot', snapshot: { files: words(rand, big / 12) } });
  }
  return lines.map(line => JSON.stringify(line));
}

/** Records that test recovery: bad JSON, duplicate keys, escapes, torn writes. */
export function oddLines(engine) {
  const codex = engine === 'codex';
  const message = codex
    ? (text, extra = '') => `{"type":"response_item"${extra},"payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":${JSON.stringify(text)}}]}}`
    : (text, extra = '') => `{"type":"assistant"${extra},"message":{"id":${JSON.stringify(text)},"content":[{"type":"text","text":${JSON.stringify(text)}}]}}`;
  return [
    '', '   ', '\t', ' ', '﻿' + message('after a byte order mark'),
    '{bad', 'null', '[]', '"text"', '7', '[{"type":"response_item"}]',
    message('duplicate type', codex ? ',"type":"event_msg"' : ',"type":"progress"'),
    (codex ? '{"type":"event_msg","type":"response_item","payload":{"type":"message","role":"user","content":"x"}}'
      : '{"type":"progress","type":"user","message":{"content":"duplicate last wins"}}'),
    codex ? '{"typ\\u0065":"response_\\u0069tem","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"escaped keys"}]}}'
      : '{"typ\\u0065":"\\u0075ser","message":{"content":"escaped keys"}}',
    codex ? '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"lone \\ud800 surrogate"}]}}'
      : '{"type":"user","message":{"content":"lone \\ud800 surrogate"}}',
    message('Unicode اردو 😀 中文 naïve'),
    message('carriage return') + '\r',
    message('first on a line') + '\r' + message('second after a lone return'),
    message('crlf') + '\r\n' + message('after crlf'),
    message('a') + ' ' + message('b'),
    // Invalid UTF-8 inside a kept record and inside an ignored record.
    Buffer.concat([Buffer.from(message('bad byte ').slice(0, -5)), Buffer.from([0xff, 0xc3]), Buffer.from('"}]}}')]),
    Buffer.concat([Buffer.from(codex ? '{"type":"event_msg","payload":{"x":"' : '{"type":"progress","data":{"x":"'), Buffer.from([0xe2, 0x82]), Buffer.from('"}}')]),
    codex ? '{"type":"response_item","payload":{"type":"function_call_output","output":"\\ud800"},"x":1}' : '{"type":"user","message":{"content":[{"type":"tool_result","content":"\\ud800"}]}}',
    codex ? '{"type":"response_item","payload":"string"}' : '{"type":"user","message":"string"}',
    codex ? '{"type":"response_item","payload":[{"type":"message"}]}' : '{"type":"user","message":{"content":[["text"],null,1,{"type":"tool_result"}]}}',
    codex ? '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>x"}]}}'
      : '{"type":"user","isSidechain":0,"message":{"content":"zero is not a side chat"}}',
    codex ? '{"type":"event_msg","payload":{"type":"token_count","type":"other"}}' : '{"type":"user","isSidechain":"","message":{"content":"empty string is not a side chat"}}',
    codex ? '{"type":"response_item","payload":{"type":"message","role":"assistant","channel":"final","content":[{"type":"output_text","text":"final"}]}}'
      : '{"type":"user","isSidechain":1e-400,"message":{"content":"underflow is zero"}}',
    '['.repeat(300) + ']'.repeat(300),
    '{"a":' + '['.repeat(200) + ']'.repeat(200) + ',"type":"user","message":{"content":"deep"}}',
    codex ? '{"type":"turn_context","payload":{"model":"m","effort":"low"}}' : '{"type":"assistant","message":{"content":[{"type":"text","text":"[Image #1]"},{"type":"image"}]}}',
  ];
}

/** Join string and Buffer lines into one file body. */
export const body = (lines, end = '\n') => Buffer.concat(lines.flatMap(line => [Buffer.from(line), Buffer.from(end)]));

/** Output of every changed reader for each file, from one process. */
export async function readAll(files, { reader, incremental = [] } = {}) {
  const env = { ...process.env, HELM_LOG_READER: reader === 'javascript' ? 'javascript' : '' };
  const code = `
    import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
    const t = await import(${JSON.stringify(transcriptModule)});
    const native = await import(${JSON.stringify(new URL('../packages/connect/src/transcript-native.js', import.meta.url).href)});
    const { files, incremental } = JSON.parse(process.argv[1]);
    const out = { reader: native.transcriptReader, files: [] };
    for (const { engine, path } of files) {
      const r = {};
      if (engine === 'codex') {
        r.all = await t.messages({ engine, path, all: true });
        r.tail = await t.messages({ engine, path, limit: 50 });
        r.state = await t.codexSessionState(path);
      } else {
        r.all = await t.messages({ engine, path, all: true });
        r.tail = await t.messages({ engine, path, limit: 50 });
        r.side = await t.messages({ engine, path, all: true, sidechain: true });
        r.snapshot = await t.sessionSnapshot({ engine, path, sessionId: 's', cwd: '/w' });
      }
      r.activity = await t.sessionActivity({ engine, path, sessionId: 's', active: true });
      delete r.activity.updatedAt;
      out.files.push(r);
    }
    for (const { engine, source, target, steps, sidechain } of incremental) {
      const bytes = readFileSync(source);
      writeFileSync(target, '');
      const reader = new t.IncrementalTranscript({ engine, path: target, sidechain });
      const reads = [];
      let at = 0;
      for (const step of steps) {
        appendFileSync(target, bytes.subarray(at, step));
        at = step;
        try { const x = await reader.read(); reads.push({ ...x, revision: undefined }); }
        catch (error) { reads.push({ error: error.message }); }
      }
      out.files.push({ reads });
    }
    process.stdout.write(JSON.stringify(out));`;
  const started = performance.now();
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', code, JSON.stringify({ files, incremental })],
    { env, maxBuffer: 1 << 30 });
  return { ...JSON.parse(stdout), ms: performance.now() - started };
}

async function timed(code, args, reader) {
  const env = { ...process.env, HELM_LOG_READER: reader === 'javascript' ? 'javascript' : '' };
  const { stdout } = await exec(process.execPath, ['--expose-gc', '--input-type=module', '-e', code, ...args], { env, maxBuffer: 1 << 30 });
  return JSON.parse(stdout);
}

// One process per reader and case. The file is read once to warm the disk
// cache, then timed over several reads.
const BENCH = `
  import { readFileSync } from 'node:fs';
  // VmHWM is this process's own peak. maxRSS can include the parent's.
  const peak = () => Number(/VmHWM:\\s+(\\d+)/.exec(readFileSync('/proc/self/status', 'utf8'))[1]) * 1024;
  const t = await import(${JSON.stringify(transcriptModule)});
  const [engine, path, kind] = process.argv.slice(1);
  const run = () => kind === 'all' ? t.messages({ engine, path, all: true })
    : kind === 'tail' ? t.messages({ engine, path })
    : kind === 'state' ? t.codexSessionState(path)
    : kind === 'usage' ? t.sessionSnapshot({ engine, path, sessionId: 's', cwd: '/w' })
    : (async () => { const r = new t.IncrementalTranscript({ engine, path }); return (await r.read()).messages; })();
  await run();
  const times = [];
  for (let i = 0; i < 5; i++) { const s = performance.now(); await run(); times.push(performance.now() - s); }
  times.sort((a, b) => a - b);
  const kept = await run();
  // Native buffers are freed by finalizers after a collection; let them run.
  for (let i = 0; i < 3; i++) { global.gc(); await new Promise(resolve => setImmediate(resolve)); }
  const { heapUsed, external } = process.memoryUsage();
  process.stdout.write(JSON.stringify({ median: times[2], best: times[0], rss: peak(), retained: heapUsed + external, kept: !!kept }));`;

async function bench() {
  const dir = mkdtempSync(join(tmpdir(), 'helm-transcript-bench-'));
  try {
    const sizes = [];
    const files = [];
    for (const engine of ['codex', 'claude']) {
      const path = join(dir, `${engine}.jsonl`);
      const lines = (engine === 'codex' ? codexLines : claudeLines)(random(engine.length), 9000);
      writeFileSync(path, body(lines));
      files.push({ engine, path });
      sizes.push(`${engine} ${(Buffer.byteLength(lines.join('\n')) / 1e6).toFixed(0)} MB, ${lines.length} records`);
    }
    // Old logs can end lines with a lone "\r". Full reads must stay streamed.
    const cr = join(dir, 'claude-cr.jsonl');
    writeFileSync(cr, body(claudeLines(random(9), 9000), '\r'));
    console.log(`Private generated files: ${sizes.join('; ')}; the Claude file again with lone "\\r" line ends`);
    const js = await readAll(files, { reader: 'javascript' });
    const rust = await readAll(files, { reader: 'rust' });
    if (rust.reader !== 'rust') throw new Error('Build the Rust reader first: node scripts/build-log-reader.mjs');
    if (JSON.stringify(js.files) !== JSON.stringify(rust.files)) throw new Error('The readers gave different output.');
    console.log('Both readers gave identical output.');
    for (const { engine, path } of [...files, { engine: 'claude', path: cr, only: 'all' }]) {
      for (const kind of path === cr ? ['all'] : engine === 'codex' ? ['all', 'tail', 'live', 'state'] : ['all', 'tail', 'live', 'usage']) {
        const a = await timed(BENCH, [engine, path, kind], 'javascript');
        const b = await timed(BENCH, [engine, path, kind], 'rust');
        console.log(`${engine}${path === cr ? ' \\r' : ''} ${kind.padEnd(5)} JavaScript ${a.median.toFixed(0).padStart(5)} ms, Rust ${b.median.toFixed(0).padStart(5)} ms`
          + ` (${(a.median / b.median).toFixed(1)}x); peak memory ${(a.rss / 1e6).toFixed(0)} -> ${(b.rss / 1e6).toFixed(0)} MB`
          + `, kept after the read ${(a.retained / 1e6).toFixed(1)} -> ${(b.retained / 1e6).toFixed(1)} MB`);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await bench();
