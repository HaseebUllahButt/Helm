// Measures Helm's built-in browser: start time, memory, latency, frame rate, idle CPU.
// Usage: node scripts/browser-bench.mjs [all|start|memory|latency|rate|idle] [--runs N]
// Env: HELM_BENCH_VARIANT=default|shell|trim|shell-trim|<exe>  (which Chromium + flags to launch)
//      HELM_BENCH_MODES=low,balanced,full   (preview modes to test)
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { homedir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'helm-bench-'));
process.env.HELM_DIR = dir; process.env.HELM_NO_SERVICE = '1';
const { BrowserManager, BROWSER_PREVIEWS } = await import('../packages/connect/src/browser.js');
let previewApi = {}; try { previewApi = await import('../apps/web/src/session/browserPreview.ts'); } catch {}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const round = (n, d = 0) => Math.round(n * 10 ** d) / 10 ** d;
const variant = process.env.HELM_BENCH_VARIANT || 'default';
const modes = (process.env.HELM_BENCH_MODES || Object.keys(BROWSER_PREVIEWS).join(',')).split(',');
const runs = Number(process.argv.includes('--runs') ? process.argv[process.argv.indexOf('--runs') + 1] : 5);
const what = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'all';

const TRIM = ['--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--no-first-run', '--disable-sync', '--disable-features=Translate,MediaRouter,OptimizationHints,InterestFeedContentSuggestions,CertificateTransparencyComponentUpdater', '--disable-breakpad', '--disable-client-side-phishing-detection', '--metrics-recording-only', '--no-default-browser-check', '--mute-audio'];
const shellPath = () => { const root = join(homedir(), '.cache/ms-playwright'); const d = readdirSync(root).filter(n => n.startsWith('chromium_headless_shell-')).sort().at(-1); return join(root, d, 'chrome-headless-shell-linux64/chrome-headless-shell'); };
function customLaunch() {
  if (variant === 'default') return undefined;
  return async () => {
    const { chromium } = await import('playwright');
    const shell = variant.startsWith('shell'), trim = variant.endsWith('trim');
    return chromium.launch({ headless: true, executablePath: shell ? shellPath() : variant.startsWith('/') ? variant : '/usr/bin/chromium', args: ['--disable-gpu', '--disk-cache-size=33554432', ...(trim ? TRIM : [])], timeout: 15000 });
  };
}
const newManager = () => new BrowserManager({ directory: join(dir, 'b' + Math.random().toString(36).slice(2)), session: id => ({ id }), launch: customLaunch() });

// --- process tree helpers
const stat = pid => { try { const s = readFileSync(`/proc/${pid}/stat`, 'utf8'); const rest = s.slice(s.lastIndexOf(')') + 2).split(' '); return { ppid: Number(rest[1]), ticks: Number(rest[11]) + Number(rest[12]) }; } catch { return null; } };
function tree(root = process.pid) {
  const kids = new Map();
  for (const n of readdirSync('/proc')) if (/^\d+$/.test(n)) { const s = stat(n); if (s) (kids.get(s.ppid) || kids.set(s.ppid, []).get(s.ppid)).push(Number(n)); }
  const out = [], walk = p => { for (const c of kids.get(p) || []) { out.push(c); walk(c); } }; walk(root); return out;
}
function usage() {
  let rss = 0, pss = 0, ticks = 0; const pids = tree();
  for (const pid of pids) {
    try { const m = readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/); rss += m ? Number(m[1]) : 0; } catch {}
    try { const m = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').match(/Pss:\s+(\d+)/); pss += m ? Number(m[1]) : 0; } catch {}
    ticks += stat(pid)?.ticks || 0;
  }
  return { procs: pids.length, rssMB: round(rss / 1024), pssMB: round(pss / 1024), ticks };
}

// --- pages
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  if (req.url.startsWith('/anim')) res.end('<title>anim</title><body style="margin:0"><div id=b style="width:200px;height:200px;background:#4a6"></div><script>let n=0;function f(){n++;document.getElementById("b").style.transform=`translate(${n%600}px,${n%300}px)`;document.getElementById("b").style.background=`hsl(${n%360},60%,50%)`;requestAnimationFrame(f)}f()</script>');
  else if (req.url.startsWith('/click')) res.end('<title>click</title><body style="margin:0"><button id=b style="width:400px;height:300px;font-size:40px" onclick="this.style.background=`hsl(${Math.random()*360},70%,60%)`;this.textContent=Math.random()">press</button>');
  else res.end('<title>simple</title><body style="font:18px system-ui;padding:30px"><h1>Hello</h1><p>A plain page with some text, a list and a button.</p><ul><li>one<li>two<li>three</ul><button>Go</button>');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// --- simulated viewer: same pacing rules as BrowserPanel's frame loop
function viewerLoop(manager, sid, tabId, mode, { viewer = 'bench-viewer' } = {}) {
  let alive = true, since = -1, elapsed = 0, held = false, frames = 0, lastImageAt = 0, lastSeq = -1, wake;
  const state = { get frames() { return frames; }, get lastImageAt() { return lastImageAt; }, get lastSeq() { return lastSeq; }, onImage: null, poke: () => wake?.(), calls: 0 };
  const done = (async () => {
    while (alive) {
      const started = performance.now();
      state.calls++;
      const r = await manager.frame(sid, tabId, { viewer, since, preview: mode, leaseMs: 15000, ...(previewApi.previewWait ? { waitMs: previewApi.previewWait(mode) } : { waitMs: 0 }) }).catch(() => null);
      held = r?.waited !== undefined; elapsed = performance.now() - started - (r?.waited || 0);
      if (r) { since = r.sequence; if (r.image) { frames++; lastImageAt = performance.now(); lastSeq = r.sequence; state.onImage?.(r.sequence, lastImageAt); } }
      if (!alive) break;
      const wait = previewApi.previewDelay ? previewApi.previewDelay(mode, elapsed, held) : 250;
      await new Promise(res => { const t = setTimeout(res, wait); wake = () => { clearTimeout(t); res(); }; });
    }
  })();
  state.stop = async () => { alive = false; state.poke(); await done; await manager.unwatch(sid, tabId, viewer).catch(() => {}); };
  return state;
}
const firstImage = async (manager, sid, tabId, mode = 'full') => {
  const t0 = performance.now();
  for (let since = -1; ;) { const r = await manager.frame(sid, tabId, { viewer: 'first', since, preview: mode, waitMs: 1000 }); if (r.image) return { ms: performance.now() - t0, r }; since = r.sequence; await sleep(10); if (performance.now() - t0 > 20000) throw new Error('no frame'); }
};

const results = {};
const record = (k, v) => { results[k] = v; console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`); };
console.log(`variant=${variant} runs=${runs}`);

if (['all', 'start'].includes(what)) {
  console.log('cold start (open() -> first live frame, ms)');
  const open = [], first = [];
  for (let i = 0; i < runs; i++) {
    const m = newManager(); const t0 = performance.now();
    const o = await m.open('s', { url: `${base}/simple` }); open.push(performance.now() - t0);
    const f = await firstImage(m, 's', o.tab.id); first.push(performance.now() - t0);
    await m.stop();
  }
  record('open() done', `${round(median(open))} ms (all ${open.map(round)})`); record('first frame', `${round(median(first))} ms (all ${first.map(round)})`);
}

if (['all', 'memory'].includes(what)) {
  console.log('memory (whole Chromium tree, MB) after 3s settle');
  const scenes = [
    ['idle about:blank, no viewer', async m => { await m.open('a'); }],
    ['simple local page, no viewer', async m => { await m.open('a', { url: `${base}/simple` }); }],
    ['simple local page + viewer(full)', async m => { const o = await m.open('a', { url: `${base}/simple` }); await firstImage(m, 'a', o.tab.id); }],
    ['heavy real site (bbc.com/news)', async m => { try { await m.open('a', { url: 'https://www.bbc.com/news' }); await sleep(4000); } catch (e) { console.log('   (site failed: ' + e.message.slice(0, 80) + ')'); } }],
    ['three chats, one tab each', async m => { for (const s of ['a', 'b', 'c']) await m.open(s, { url: `${base}/simple` }); }],
  ];
  for (const [name, setup] of scenes) {
    const m = newManager(); await setup(m); await sleep(3000);
    const u = usage(); record(name, `rss ${u.rssMB} | pss ${u.pssMB} | procs ${u.procs}`);
    await m.stop();
  }
}

if (['all', 'latency'].includes(what)) {
  console.log('latency (ms)');
  const m = newManager(); const o = await m.open('l', { url: `${base}/click` }); const tabId = o.tab.id;
  const agent = []; for (let i = 0; i < 20; i++) { const t0 = performance.now(); await m.run('l', tabId, { kind: 'click', x: 100, y: 100 }); agent.push(performance.now() - t0); }
  record('agent click round trip (median)', `${round(median(agent), 1)} (min ${round(Math.min(...agent), 1)}, max ${round(Math.max(...agent), 1)})`);
  const look = []; for (let i = 0; i < 10; i++) { const t0 = performance.now(); await m.run('l', tabId, { kind: 'look' }); look.push(performance.now() - t0); }
  record('agent look (median)', round(median(look), 1));
  for (const mode of modes) {
    await m.control('l', tabId, 'owner', false); await m.control('l', tabId, 'owner', true);
    const v = viewerLoop(m, 'l', tabId, mode, { viewer: 'owner' }); await sleep(1500);
    const samples = [];
    for (let i = 0; i < 10; i++) {
      await sleep(300 + Math.random() * 700);
      const seq0 = v.lastSeq, t0 = performance.now();
      const got = new Promise(res => { v.onImage = (seq, at) => { if (seq > seq0) { v.onImage = null; res(at - t0); } }; });
      await m.run('l', tabId, { kind: 'click', x: 100, y: 100 }, 'owner');
      samples.push(await Promise.race([got, sleep(5000).then(() => NaN)]));
    }
    record(`owner click -> new frame, ${mode} (median)`, `${round(median(samples.filter(Number.isFinite)))} (all ${samples.map(round)})`);
    await v.stop();
  }
  await m.stop();
}

if (['all', 'rate'].includes(what)) {
  console.log('delivered frames/s to one viewer on an animating page (8s)');
  const m = newManager(); const o = await m.open('r', { url: `${base}/anim` });
  for (const mode of modes) {
    const v = viewerLoop(m, 'r', o.tab.id, mode); await sleep(1500); const f0 = v.frames, c0 = v.calls, t0 = performance.now();
    await sleep(8000); const secs = (performance.now() - t0) / 1000;
    record(`${mode}`, `${round((v.frames - f0) / secs, 1)} fps, ${round((v.calls - c0) / secs, 1)} calls/s`);
    await v.stop();
  }
  await m.stop();
}

if (['all', 'idle'].includes(what)) {
  console.log('idle CPU with a viewer on a static page (10s, % of one core)');
  const m = newManager(); const o = await m.open('i', { url: `${base}/simple` });
  await sleep(2000);
  const hz = 100;
  for (const label of ['no viewer', ...modes.map(x => 'viewer ' + x)]) {
    const v = label === 'no viewer' ? null : viewerLoop(m, 'i', o.tab.id, label.split(' ')[1]);
    await sleep(2000);
    const a = usage().ticks, n0 = process.cpuUsage(), t0 = performance.now(); await sleep(10000);
    const secs = (performance.now() - t0) / 1000, n = process.cpuUsage(n0);
    record(label, `chromium ${round((usage().ticks - a) / hz / secs * 100, 1)}% | helm node ${round((n.user + n.system) / 1e6 / secs * 100, 1)}%`);
    await v?.stop();
  }
  await m.stop();
}

server.close(); rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify(results));
process.exit(0);
