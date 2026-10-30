#!/usr/bin/env node
// What the Helm web app's main thread spends while one long reply streams in:
// PandaCode's W1 (bench/t3-compare in github.com/aicodeking/pandacode), the
// same 50 KB of Markdown as 2,000 deltas of 25 B, one every 16 ms.
//
//   node scripts/bench-stream/run.mjs [--runs 5] [--label name] [--no-build] [--keep] [--profile]
//
// --profile builds without minifying, records one stream with the CPU profiler,
// and prints the functions that used the most time (results/<label>.cpuprofile).
//
// Unlike PandaCode's bench, the reply travels the whole real path: a fake ACP
// agent (agent.mjs) writes the deltas to a private verify-helm daemon, which
// sends them over its socket to the app. So socket work and JSON parsing count
// here; PandaCode's and T3 Code's numbers skip them. Each run is a new Chrome
// and a new chat with one short turn before the stream. The span runs from
// just before the message is sent to 1 s after the frame that shows the last
// line; the turn stays open until then, so its end is not measured.
// Results: scripts/bench-stream/results/<label>.json. The owner's ~/.helm is
// never used.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { systemChromium } from '../../packages/connect/src/browser-window.js';
import { W1_DELTAS, DELTA_MS, SENTINEL } from './workload.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '../..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const PROFILE = argv.includes('--profile');
const RUNS = PROFILE ? 1 : Number(opt('runs', 5));
const LABEL = opt('label', 'run');
const NAME = 'bench-stream';
const ROOT = join(tmpdir(), `helm-verify-${NAME}`);
const VIEWPORT = { width: 1440, height: 940 }, SCALE = 2, SETTLE_MS = 1000;
const SPAN_MS = (W1_DELTAS.length - 1) * DELTA_MS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const verify = (...a) => {
  const r = spawnSync(process.execPath, [join(REPO, 'scripts/verify-helm.mjs'), '--name', NAME, ...a], { cwd: REPO, encoding: 'utf8', timeout: 180_000 });
  if (r.status !== 0) throw new Error(`verify-helm ${a.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
};
const rpc = (method, params) => {
  for (let i = 0; ; i++) {
    try { return JSON.parse(verify('rpc', method, JSON.stringify(params))); } catch (e) {
      if (i >= 20 || !/not connected|unreachable/.test(e.message)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
};
const send = (id, data) => rpc('session.deliver', { id, messageId: randomBytes(16).toString('hex'), data });
async function settle(id) {
  for (let i = 0; i < 240; i++) {
    if (rpc('session.list', {}).sessions.find((s) => s.id === id)?.status === 'idle') return;
    await sleep(500);
  }
  throw new Error(`chat ${id} did not settle`);
}
/** A new chat with one short finished turn, like a chat the owner returns to. */
async function chat(title) {
  const id = rpc('session.start', { quick: true, profileId: 'bench-w1', title }).session.id;
  await sleep(500);
  send(id, 'hello');
  await settle(id);
  return id;
}

function addProfile() {
  const bin = join(ROOT, 'bin', 'devin-w1');
  mkdirSync(join(ROOT, 'bin'), { recursive: true });
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(HERE, 'agent.mjs'))} "$@"\n`);
  chmodSync(bin, 0o755);
  const f = join(ROOT, 'helm', 'profiles.json');
  const j = JSON.parse(readFileSync(f, 'utf8'));
  j.profiles.push({ id: 'bench-w1', label: 'bench-w1', engine: 'devin', cmd: bin, args: [], env: { FAKE_HOME: join(ROOT, 'bench-w1') }, source: 'custom' });
  writeFileSync(f, JSON.stringify(j, null, 2));
  rpc('profile.list', { refresh: true });
}

// Runs in the page before the app: note when the first and last pieces of the
// reply arrive. The direct link sends packed binary frames, so the hook sits
// where every message ends up, JSON.parse, and changes nothing it returns.
const HOOK = `(() => {
  const FIRST = ${JSON.stringify(W1_DELTAS[0].trim())}, LAST = ${JSON.stringify(SENTINEL)};
  window.__w1 = { firstAt: 0, lastAt: 0, frames: 0 };
  const parse = JSON.parse;
  JSON.parse = function (s, ...rest) {
    if (typeof s === 'string' && s.includes('item.delta')) {
      window.__w1.frames++;
      const now = performance.now();
      if (!window.__w1.firstAt && s.includes(FIRST)) window.__w1.firstAt = now;
      if (s.includes(LAST)) window.__w1.lastAt = now;
    }
    return parse.call(this, s, ...rest);
  };
})();`;

async function measure(base, key, id, idle) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true }).catch((e) => {
    const system = systemChromium();
    if (!system || !/Executable doesn't exist/.test(e.message)) throw e;
    return chromium.launch({ headless: true, executablePath: system });
  });
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
    await context.addInitScript(HOOK);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/#local=${encodeURIComponent(key)}`);
    await page.reload();
    await page.waitForLoadState('networkidle').catch(() => {});
    // The machine's id is in the list the app saves once it has signed in.
    const machine = await page.waitForFunction(() => {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k.startsWith('helm.workspace:')) continue;
        const self = JSON.parse(localStorage.getItem(k)).environments?.find((e) => e.self);
        if (self) return self.id;
      }
      return null;
    }, null, { timeout: 30_000 }).then((h) => h.jsonValue());
    await page.goto(`${base}/#open=${encodeURIComponent(machine)}/${id}`);
    await page.reload();
    await page.getByText('Ready for the stream.').first().waitFor({ timeout: 30_000 });
    await sleep(2000);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); return (await cdp.send('Runtime.getHeapUsage')).usedSize / 2 ** 20; };
    await page.evaluate(() => {
      window.__mutations = 0;
      new MutationObserver((list) => { window.__mutations += list.length; })
        .observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    });
    const heapBeforeMB = await heap(), m0 = await metrics();
    if (PROFILE && !idle) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
    const done = page.evaluate(async ({ sentinel, idle, span }) => {
      const t0 = performance.now();
      if (idle) { await new Promise((r) => setTimeout(r, span)); return { wallMs: Math.round(performance.now() - t0) }; }
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      while (!window.__w1.lastAt) {
        if (performance.now() - t0 > span + 60_000) throw new Error('the last piece never arrived');
        await new Promise((r) => setTimeout(r, 100));
      }
      const reply = () => [...document.querySelectorAll('.md.prose')].at(-1);
      while (!reply()?.textContent.includes(sentinel)) {
        if (performance.now() - window.__w1.lastAt > 30_000) throw new Error('final text never appeared');
        await frame();
      }
      await frame();
      const end = performance.now(), el = reply();
      return {
        wallMs: Math.round(end - window.__w1.firstAt), finalPaintMs: Math.round(end - window.__w1.lastAt),
        arrivalSpanMs: Math.round(window.__w1.lastAt - window.__w1.firstAt), socketFrames: window.__w1.frames,
        shownChars: el.textContent.length,
        elements: Object.fromEntries(['pre', 'table', 'li', 'h2', 'blockquote', 'a'].map((tag) => [tag, el.querySelectorAll(tag).length])),
      };
    }, { sentinel: SENTINEL, idle, span: SPAN_MS });
    if (!idle) send(id, 'w1');
    const run = await done;
    await sleep(SETTLE_MS);
    const m1 = await metrics(), heapAfterMB = await heap();
    if (PROFILE && !idle) top((await cdp.send('Profiler.stop')).profile);
    const ms = (k) => Math.round((m1[k] - m0[k]) * 1000);
    if (!idle) await settle(id);
    return {
      mode: idle ? 'idle' : 'w1', ...run,
      taskMs: ms('TaskDuration'), scriptMs: ms('ScriptDuration'), layoutMs: ms('LayoutDuration'), styleMs: ms('RecalcStyleDuration'),
      otherMs: ms('TaskDuration') - ms('ScriptDuration') - ms('LayoutDuration') - ms('RecalcStyleDuration'),
      heapBeforeMB: +heapBeforeMB.toFixed(1), heapAfterMB: +heapAfterMB.toFixed(1),
      mutationRecords: await page.evaluate(() => window.__mutations), pageErrors: errors, chrome: browser.version(),
    };
  } finally {
    await browser.close();
  }
}

/** Save the profile and print where the time went, by function, self and total. */
function top(profile) {
  mkdirSync(join(HERE, 'results'), { recursive: true });
  writeFileSync(join(HERE, 'results', `${LABEL}.cpuprofile`), JSON.stringify(profile));
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const dt = new Map();
  profile.samples.forEach((id, i) => dt.set(id, (dt.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const self = new Map(), total = new Map();
  const name = (n) => { const f = n.callFrame; return `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`; };
  for (const [id, ms] of dt) {
    const n = byId.get(id);
    self.set(name(n), (self.get(name(n)) ?? 0) + ms);
    const seen = new Set();
    for (let at = id; at !== undefined; at = parent.get(at)) {
      const k = name(byId.get(at));
      if (!seen.has(k)) { seen.add(k); total.set(k, (total.get(k) ?? 0) + ms); }
    }
  }
  const show = (m, label) => {
    console.log(`\n${label}`);
    for (const [k, v] of [...m].sort((a, b) => b[1] - a[1]).filter(([k]) => !/^\((idle|program|root)\)/.test(k)).slice(0, 30)) console.log(`  ${v.toFixed(0).padStart(6)} ms  ${k}`);
  };
  show(self, 'self time'); show(total, 'total time');
}

if (!argv.includes('--no-build')) {
  const r = spawnSync('npm', ['--workspace', '@helm/web', 'run', 'build', ...(PROFILE ? ['--', '--minify', 'false'] : [])], { cwd: REPO, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`web build failed: ${r.stderr || r.stdout}`);
}
try {
  verify('up');
  addProfile();
  const s = JSON.parse(readFileSync(join(ROOT, 'state.json'), 'utf8'));
  process.env.HELM_DIR = join(ROOT, 'helm');
  const { localKey } = await import('../../packages/protocol/network.js');
  const key = localKey();
  const runs = [];
  const idleChat = await chat('idle');
  for (let i = 0; i < RUNS; i++) {
    for (const idle of [false, true]) {
      const id = idle ? idleChat : await chat(`w1-${i + 1}`);
      const result = await measure(s.url, key, id, idle);
      if (!idle && result.shownChars < 40_000) throw new Error(`only ${result.shownChars} characters shown`);
      console.log(i + 1, result.mode, result.taskMs, 'ms task', result.scriptMs, 'ms script', result.wallMs, 'ms wall', result.finalPaintMs ?? '', 'ms final paint');
      runs.push({ run: i + 1, ...result });
    }
  }
  const sh = (cmd, args) => spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8' }).stdout.trim();
  const meta = {
    label: LABEL, date: new Date().toISOString(), commit: sh('git', ['rev-parse', 'HEAD']), dirty: sh('git', ['status', '--porcelain', '--', 'apps/web/src']) !== '',
    cpu: sh('sh', ['-c', "lscpu | sed -n 's/^Model name: *//p'"]), chrome: runs[0].chrome, runs: RUNS, viewport: VIEWPORT, deviceScaleFactor: SCALE,
  };
  mkdirSync(join(HERE, 'results'), { recursive: true });
  writeFileSync(join(HERE, 'results', `${LABEL}.json`), JSON.stringify({ ...meta, runs }, null, 1) + '\n');
  const median = (v) => { v = [...v].sort((a, b) => a - b); return v.length % 2 ? v[v.length >> 1] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2; };
  const keys = ['taskMs', 'scriptMs', 'layoutMs', 'styleMs', 'otherMs', 'wallMs', 'arrivalSpanMs', 'finalPaintMs', 'heapBeforeMB', 'heapAfterMB', 'mutationRecords', 'socketFrames'];
  for (const mode of ['w1', 'idle']) {
    const rows = runs.filter((r) => r.mode === mode);
    console.log(`\n${mode} (median of ${rows.length}, min-max)`);
    for (const k of keys) {
      const v = rows.map((r) => r[k]).filter((x) => typeof x === 'number');
      if (v.length) console.log(`  ${k.padEnd(16)} ${median(v)} (${Math.min(...v)}-${Math.max(...v)})`);
    }
  }
  const errs = runs.flatMap((r) => r.pageErrors);
  if (errs.length) console.log('page errors:', [...new Set(errs)]);
} finally {
  if (!argv.includes('--keep')) verify('down');
}
