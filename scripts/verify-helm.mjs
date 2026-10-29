#!/usr/bin/env node
// See Helm working for real, without touching the owner's Helm.
//
//   node scripts/verify-helm.mjs up [--real]   private Helm + free fake agents (--real: your real logins too)
//   node scripts/verify-helm.mjs open [#hash] [--desktop|--phone] [--init file.js]   hidden browser (390×844 phone), signed in
//   node scripts/verify-helm.mjs click <text> | type <text> | key <key> | wait <text> [ms]
//   node scripts/verify-helm.mjs text | shot [file.png] [--full] | errors [--clear] | logs [n] | size <w> <h>
//   node scripts/verify-helm.mjs eval <js> | rpc <method> [json] | upload <file>...
//   node scripts/verify-helm.mjs record start | record stop [clip.webp|clip.mp4]   a short clip of the app
//   node scripts/verify-helm.mjs compare <before.png> <after.png> [out.png]   both side by side, labelled
//   node scripts/verify-helm.mjs restart | status | down [--keep]
//
// Each chat gets its own copy (named from HELM_SESSION_ID, or --name /
// HELM_VERIFY), so two agents never share one. Everything lives under
// /tmp/helm-verify-<name>; the real ~/.helm, its sockets and its systemd
// units are never used, and `down` stops only processes this copy started.
// The skill in .agents/skills/verify-helm says when and how to use it.
import { spawn } from 'node:child_process';
import { systemChromium } from '../packages/connect/src/browser-window.js';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, openSync, statSync, utimesSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i < 0 ? null : argv.splice(i, 2)[1] ?? ''; };
const has = (name) => { const i = argv.indexOf(`--${name}`); if (i >= 0) argv.splice(i, 1); return i >= 0; };
const name = (flag('name') ?? process.env.HELM_VERIFY ?? process.env.HELM_SESSION_ID?.slice(0, 8) ?? 'main')
  .replace(/[^a-zA-Z0-9-]/g, '').slice(0, 24) || 'main';
const ROOT = join(tmpdir(), `helm-verify-${name}`);
const STATE = join(ROOT, 'state.json');
// Read before the words are: `record stop --fps 5 clip.webp` keeps clip.webp as its file.
const media = { fps: flag('fps'), before: flag('before'), after: flag('after') };
const [cmd, ...args] = argv;

const say = (s) => console.log(s);
const die = (s) => { console.error(`verify-helm: ${s}`); process.exit(1); };
const state = () => existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null;
const save = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

/**
 * The daemon's environment: the owner's own variables minus anything that
 * would tie it to the real install or to the agent running this script.
 * CLAUDE_CONFIG_DIR / CODEX_HOME in particular once made a test write into
 * the real ~/.claude-personal.
 */
function sandboxEnv(dir, real) {
  const env = { ...process.env };
  // A home of its own unless real logins were asked for: Helm lists every
  // chat and terminal it can find under HOME, and the owner's real ones
  // must not show up (or be one click from deletion) in a test.
  if (!real) env.HOME = join(dir, 'home');
  for (const k of Object.keys(env)) if (/^(HELM_|CLAUDE|CODEX_|ANTHROPIC_|OPENAI_)/.test(k)) delete env[k];
  return {
    ...env,
    HELM_DIR: join(dir, 'helm'), HELM_SSH_DIR: join(dir, 'ssh'),
    // No services, no self-update, no shell launchers, and terminal hosts
    // as plain children: `systemd-run --unit=helm-terminals-<uid>` would
    // collide with the real laptop's host.
    HELM_NO_SERVICE: '1', HELM_NO_UPDATE: '1', HELM_NATIVE_BYPASS: '1', HELM_NO_SYSTEMD_RUN: '1',
  };
}

/** A no-cost account: test/fake-agent.mjs answers every prompt like a CLI. */
function writeFakeAccount(dir) {
  mkdirSync(join(dir, 'bin'), { recursive: true });
  const bin = join(dir, 'bin', 'devin');
  const q = (v) => `'${v.replaceAll("'", "'\\''")}'`;
  writeFileSync(bin, `#!/bin/sh\nexec ${q(process.execPath)} ${q(join(REPO, 'test/fake-agent.mjs'))} "$@"\n`, { mode: 0o755 });
  // FAKE_HOME only tells the two apart: Helm shows one row per login, and
  // a login is known by its home folder.
  const fake = [
    { id: 'fake', label: 'Fake agent', engine: 'devin', cmd: bin, args: [], env: { FAKE_TURN_MS: '800', FAKE_HOME: join(dir, 'fake') }, source: 'custom' },
    { id: 'fake-ask', label: 'Fake agent (asks)', engine: 'devin', cmd: bin, args: [], env: { FAKE_TURN_MS: '800', FAKE_ASK: '1', FAKE_HOME: join(dir, 'fake-ask') }, source: 'custom' },
    { id: 'fake-pics', label: 'Fake agent (sees pictures)', engine: 'devin', cmd: bin, args: [], env: { FAKE_TURN_MS: '800', FAKE_IMAGES: '1', FAKE_HOME: join(dir, 'fake-pics') }, source: 'custom' },
    { id: 'fake-slow', label: 'Fake agent (slow)', engine: 'devin', cmd: bin, args: [], env: { FAKE_TURN_MS: '120000', FAKE_HOME: join(dir, 'fake-slow') }, source: 'custom' },
    // The terminal button needs it; a real machine finds it on its own.
    { id: 'shell', label: 'Shell', engine: 'shell', cmd: process.env.SHELL || '/bin/sh', args: [], env: {}, source: 'builtin' },
  ];
  writeFileSync(join(dir, 'helm', 'profiles.json'), JSON.stringify({ version: 1, profiles: fake }, null, 2), { mode: 0o600 });
}

async function up() {
  const s = state();
  if (s && alive(s.daemon)) return say(`already up: ${s.url}  (copy "${name}")`);
  await sweepStale();
  rmSync(ROOT, { recursive: true, force: true });
  const real = has('real');
  for (const d of ['helm', 'ssh', 'work', 'home']) mkdirSync(join(ROOT, d), { recursive: true, mode: 0o700 });
  writeFakeAccount(ROOT);
  const port = await freePort();
  const log = openSync(join(ROOT, 'daemon.log'), 'a');
  const child = spawn(process.execPath, [join(REPO, 'packages/connect/bin/helm.js'), 'up',
    '--port', String(port), '--host', '127.0.0.1', '--name', `verify-${name}`],
  { cwd: REPO, env: sandboxEnv(ROOT, real), stdio: ['ignore', log, log], detached: true });
  child.unref();
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    if (!alive(child.pid)) die(`Helm stopped while starting; see ${join(ROOT, 'daemon.log')}`);
    if (await fetch(url).then((r) => r.ok, () => false)) break;
    await sleep(500);
  }
  save({ name, root: ROOT, url, port, daemon: child.pid, real });
  // Real logins only on request: a real chat costs money and lands in that
  // account's history.
  if (real) await rpc('profile.list', { refresh: true });
  say(`up: ${url}  (copy "${name}", files in ${ROOT})`);
  say(`accounts: "fake" (answers in 0.8 s), "fake-ask" (asks permission first), "fake-pics" (takes pictures) and "fake-slow" (works for 2 minutes)${real ? ', plus your real logins' : ''}.`);
  say(`work folder for test chats: ${join(ROOT, 'work')}`);
}

/** Replace only this private daemon; keep its hosts and agents running. */
async function restart() {
  const s = state() ?? die('not up');
  if (s.root !== ROOT || !alive(s.daemon)) die('private daemon is not running');
  process.kill(s.daemon, 'SIGTERM');
  for (let i = 0; i < 100 && alive(s.daemon); i++) await sleep(100);
  if (alive(s.daemon)) die('private daemon did not stop; agents were left running');
  const log = openSync(join(ROOT, 'daemon.log'), 'a');
  const child = spawn(process.execPath, [join(REPO, 'packages/connect/bin/helm.js'), 'up',
    '--port', String(s.port), '--host', '127.0.0.1', '--name', `verify-${name}`],
  { cwd: REPO, env: sandboxEnv(ROOT, !!s.real), stdio: ['ignore', log, log], detached: true });
  child.unref();
  save({ ...s, daemon: child.pid });
  for (let i = 0; i < 60; i++) {
    if (!alive(child.pid)) die('private replacement daemon stopped; see daemon.log');
    if (await fetch(s.url).then((r) => r.ok, () => false)) return say(`restarted private daemon ${s.daemon} → ${child.pid}`);
    await sleep(500);
  }
  die('private replacement daemon did not become ready');
}

/** Sign-in key for this copy, read with HELM_DIR pointing at it. */
async function localKey(s) {
  process.env.HELM_DIR = join(s.root, 'helm');
  const { localKey } = await import('../packages/protocol/network.js');
  return localKey();
}

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

/**
 * Holds the browser open between commands. A headless window cannot be
 * narrower than 500 px and a screen-size override ends with the connection
 * that set it, so this process keeps both - and writes every page error it
 * sees to errors.log, which no short-lived command could catch.
 */
async function hold() {
  const s = state();
  const { chromium } = await import('@playwright/test');
  const desktop = !!s.browser.desktop;
  const options = {
    headless: true, args: [`--remote-debugging-port=${s.browser.cdp}`],
    viewport: desktop ? DESKTOP : PHONE, isMobile: !desktop, hasTouch: !desktop, deviceScaleFactor: desktop ? 1 : 2,
  };
  // Playwright's own Chromium may not be downloaded (or downloadable here);
  // any Chromium-based browser Helm itself would use does the same job.
  const system = systemChromium();
  const context = await chromium.launchPersistentContext(join(s.root, 'browser'), options).catch((e) => {
    if (!system || !/Executable doesn't exist/.test(e.message)) throw e;
    return chromium.launchPersistentContext(join(s.root, 'browser'), { ...options, executablePath: system });
  });
  // `open --init <file>` saved a script to run in every page before the app does.
  const init = join(s.root, 'init.js');
  if (existsSync(init)) await context.addInitScript(readFileSync(init, 'utf8'));
  const page = context.pages()[0] ?? await context.newPage();
  const errors = join(s.root, 'errors.log');
  const note = (line) => writeFileSync(errors, `${new Date().toISOString().slice(11, 19)} ${line}\n`, { flag: 'a' });
  page.on('pageerror', (e) => note(`page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') note(`console: ${m.text()}`); });
  // `size` writes viewport.json; apply it here, where the override lasts.
  const sizeFile = join(s.root, 'viewport.json');
  const recording = recorder(context, page, join(s.root, 'record'), note);
  const recordFile = join(s.root, 'record.json');
  setInterval(async () => {
    if (existsSync(recordFile)) {
      const { action } = JSON.parse(readFileSync(recordFile, 'utf8'));
      rmSync(recordFile);
      await (action === 'start' ? recording.start() : recording.stop()).catch((e) => note(`record: ${e.message}`));
    }
    if (!existsSync(sizeFile)) return;
    const v = JSON.parse(readFileSync(sizeFile, 'utf8'));
    rmSync(sizeFile);
    await page.setViewportSize(v).catch((e) => note(`size: ${e.message}`));
  }, 200);
  process.on('SIGTERM', () => context.close().finally(() => process.exit(0)));
}

/**
 * A screencast of the held page. It lives in the holder, which keeps the
 * page; `record start|stop` ask through record.json and read the frames
 * from the record folder.
 */
function recorder(context, page, dir, note) {
  let cdp = null;
  let frames = [];
  return {
    async start() {
      if (cdp) await this.stop();
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      frames = [];
      cdp = await context.newCDPSession(page);
      cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
        const file = join(dir, `${String(frames.length).padStart(5, '0')}.jpg`);
        writeFileSync(file, Buffer.from(data, 'base64'));
        frames.push({ file, t: metadata?.timestamp ?? Date.now() / 1000 });
        cdp?.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      });
      const { width, height } = page.viewportSize() ?? { width: 1280, height: 800 };
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: width * 2, maxHeight: height * 2 });
      writeFileSync(join(dir, 'started.json'), JSON.stringify({ t: Date.now() / 1000 }));
    },
    async stop() {
      const end = Date.now() / 1000;
      if (cdp) {
        await cdp.send('Page.stopScreencast').catch((e) => note(`record: ${e.message}`));
        await cdp.detach().catch(() => {});
        cdp = null;
      }
      // A page that did not change sent no frame: show it as it is now.
      if (!frames.length) {
        const file = join(dir, '00000.jpg');
        mkdirSync(dir, { recursive: true });
        await page.screenshot({ path: file, type: 'jpeg', quality: 80 });
        frames.push({ file, t: end - MIN_CLIP_S });
      }
      writeFileSync(join(dir, 'frames.json'), JSON.stringify({ frames, end }));
    },
  };
}
const MIN_CLIP_S = 1;

/** Wait for a file the browser holder writes. */
async function waitFor(file, what, ms = 10_000) {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(100)) if (existsSync(file)) return;
  die(`${what} did not answer; see ${join(ROOT, 'errors.log')}`);
}

async function record(action, out) {
  const s = state() ?? die('not up; run: node scripts/verify-helm.mjs up');
  if (!s.browser || !alive(s.browser.pid)) die('no browser; run: node scripts/verify-helm.mjs open');
  const dir = join(ROOT, 'record');
  if (action === 'start') {
    rmSync(join(dir, 'started.json'), { force: true });
    writeFileSync(join(ROOT, 'record.json'), JSON.stringify({ action }));
    await waitFor(join(dir, 'started.json'), 'the recording');
    return say('recording. Do the steps, then run: record stop [clip.webp]');
  }
  if (action !== 'stop') die('use: record start | record stop [clip.webp|clip.mp4]');
  if (!existsSync(join(dir, 'started.json'))) die('no recording runs; run: record start');
  rmSync(join(dir, 'frames.json'), { force: true });
  writeFileSync(join(ROOT, 'record.json'), JSON.stringify({ action }));
  await waitFor(join(dir, 'frames.json'), 'the recording');
  const { frames, end } = JSON.parse(readFileSync(join(dir, 'frames.json'), 'utf8'));
  rmSync(join(dir, 'started.json'), { force: true });
  const file = resolve(out ?? join(ROOT, `clip-${Date.now()}.webp`));
  const { makeClip, RENDER_LIMIT } = await import('./proof-media.mjs');
  const fps = Number(media.fps ?? 10);
  const { seconds, bytes } = await makeClip(frames, end, file, { dir, fps, width: s.browser.desktop ? 1280 : 720 }).catch((e) => die(e.message));
  say(`${file} (${seconds.toFixed(1)} s, ${frames.length} frames, ${(bytes / 1024).toFixed(0)} KB)`);
  if (file.endsWith('.webp') && bytes > RENDER_LIMIT) say('Too big for helm render (2 MB). Record fewer steps, or use --fps 5.');
}

/** Two pictures side by side, labelled, in one file. */
async function compare(before, after, out) {
  if (!before || !after) die('use: compare <before.png> <after.png> [out.png]');
  for (const f of [before, after]) if (!existsSync(f)) die(`no such picture: ${f}`);
  const labels = { beforeLabel: media.before ?? 'Before', afterLabel: media.after ?? 'After' };
  const file = resolve(out ?? join(dirname(resolve(after)), 'before-after.png'));
  const { compareHtml } = await import('./proof-media.mjs');
  const { chromium } = await import('@playwright/test');
  const system = systemChromium();
  const browser = await chromium.launch({ headless: true }).catch((e) => {
    if (!system || !/Executable doesn't exist/.test(e.message)) throw e;
    return chromium.launch({ headless: true, executablePath: system });
  });
  try {
    const page = await browser.newPage({ viewport: { width: 2400, height: 1200 } });
    await page.setContent(compareHtml(resolve(before), resolve(after), labels));
    await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth));
    await page.locator('#pair').screenshot({ path: file });
  } finally {
    await browser.close();
  }
  say(file);
}

async function open(hash = '') {
  if (hash.startsWith('--')) hash = '';
  const s = state() ?? die('not up; run: node scripts/verify-helm.mjs up');
  // --init <file>: run this script in every page before the app starts (the
  // browser restarts if it was already open, since it is read at start).
  const initFile = flag('init');
  if (initFile !== null) { const i = args.indexOf('--init'); args.splice(i, 2); if (hash === '--init') hash = args[0] ?? ''; }
  if (initFile !== null) {
    const keep = existsSync(join(ROOT, 'init.js')) ? readFileSync(join(ROOT, 'init.js'), 'utf8') : null;
    const next = readFileSync(resolve(initFile), 'utf8');
    writeFileSync(join(ROOT, 'init.js'), next);
    if (keep !== next && s.browser && alive(s.browser.pid)) {
      try { process.kill(s.browser.pid, 'SIGTERM'); } catch { /* already gone */ }
      for (let i = 0; i < 50 && alive(s.browser.pid); i++) await sleep(100);
      s.browser = null;
      save(s);
    }
  }
  const wantDesktop = has('desktop'), wantPhone = has('phone');
  // Touch, scale and the phone frame are fixed when the browser starts, so
  // `size` alone cannot turn a phone into a laptop (hover rules never apply).
  // Asking for the other kind starts a fresh browser of that kind.
  if (s.browser && alive(s.browser.pid) && ((wantDesktop && !s.browser.desktop) || (wantPhone && s.browser.desktop))) {
    try { process.kill(s.browser.pid, 'SIGTERM'); } catch { /* already gone */ }
    for (let i = 0; i < 50 && alive(s.browser.pid); i++) await sleep(100);
    s.browser = null;
    save(s);
  }
  if (!s.browser || !alive(s.browser.pid)) {
    s.browser = { cdp: await freePort(), desktop: wantDesktop };
    save(s);
    const log = openSync(join(s.root, 'browser.log'), 'a');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '_hold', '--name', name],
      { stdio: ['ignore', log, log], detached: true });
    child.unref();
    s.browser.pid = child.pid;
    save(s);
    for (let i = 0; i < 60 && !(await fetch(`http://127.0.0.1:${s.browser.cdp}/json/version`).then((r) => r.ok, () => false)); i++) {
      if (!alive(child.pid)) die(`the browser did not start; see ${join(s.root, 'browser.log')}`);
      await sleep(250);
    }
  }
  const { page, done } = await connect(s);
  // A change of hash alone does not reload, and the app reads #open=<machine>/<chat>
  // only when it starts, so every open is a fresh load.
  await page.goto(`${s.url}/#local=${encodeURIComponent(await localKey(s))}`);
  await page.reload();
  await page.waitForLoadState('networkidle').catch(() => {});
  if (hash) {
    await page.goto(`${s.url}/#${hash.replace(/^#/, '')}`);
    await page.reload();
    await page.waitForLoadState('networkidle').catch(() => {});
  }
  await sleep(800);
  say(`open: ${page.url().replace(/#local=[^&]*/, '#local=…')} at ${await page.evaluate(() => `${innerWidth}×${innerHeight}`)}`);
  await done();
}

async function connect(s = state()) {
  if (!s?.browser || !alive(s.browser.pid)) die('no browser; run: node scripts/verify-helm.mjs open');
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${s.browser.cdp}`);
  const context = browser.contexts()[0];
  const page = context.pages().find((p) => p.url().startsWith(s.url)) ?? context.pages()[0];
  // Disconnecting is enough; close() over CDP would quit the shared browser.
  return { page, done: async () => { await browser.close().catch(() => {}); } };
}

/**
 * The first visible thing that matches, trying exact matches before partial
 * ones (so "fake" never lands on "fake-ask") and what a person would read
 * first before the rest.
 */
async function find(page, text) {
  const exact = [
    page.getByRole('button', { name: text, exact: true }), page.getByRole('link', { name: text, exact: true }),
    page.getByRole('menuitem', { name: text, exact: true }), page.getByRole('option', { name: text, exact: true }),
    page.getByRole('tab', { name: text, exact: true }), page.getByLabel(text, { exact: true }),
    page.getByPlaceholder(text, { exact: true }), page.getByText(text, { exact: true }),
  ];
  const partial = [
    page.getByRole('button', { name: text }), page.getByRole('menuitem', { name: text }), page.getByRole('option', { name: text }),
    page.getByRole('tab', { name: text }), page.getByPlaceholder(text), page.getByText(text),
  ];
  let covered = null;
  for (const t of [...exact, ...partial]) {
    for (const el of await t.all().catch(() => [])) {
      if (!await el.isVisible().catch(() => false)) continue;
      if (await onTop(el)) return el;
      covered ??= el;
    }
  }
  return covered;
}

/** Whether a click on its middle would reach it, not a sheet or menu above it. */
const onTop = (el) => el.evaluate((n) => {
  const r = n.getBoundingClientRect();
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return !!hit && (n.contains(hit) || hit.contains(n));
}).catch(() => false);

async function act(fn) {
  const { page, done } = await connect();
  try { await fn(page); } finally { await done(); }
}

const visibleText = (page) => page.evaluate(() => document.body.innerText.replace(/\n{3,}/g, '\n\n').trim());

/** Ask the private Helm directly, as the app would. */
async function rpc(method, params) {
  const s = state() ?? die('not up');
  process.env.HELM_DIR = join(s.root, 'helm');
  const { loadNetwork } = await import('../packages/protocol/network.js');
  const { hubRpc } = await import('../packages/connect/src/hub-client.js');
  const net = loadNetwork();
  return hubRpc(net, net.self, method, params, { timeout: 30_000 });
}

async function down() {
  const keep = has('keep');
  const killed = await stopCopy(ROOT, state(), { keep });
  say(`down: stopped ${killed.length} process${killed.length === 1 ? '' : 'es'}${keep ? `, kept ${ROOT}` : ', files removed'}.`);
}

/** Stop one copy's processes and, unless kept, remove its folder. Returns the processes stopped. */
async function stopCopy(ROOT, s, { keep = false } = {}) {
  const killed = [];
  const stop = (pid, group) => { try { process.kill(group ? -pid : pid, 'SIGTERM'); killed.push(pid); } catch { /* gone */ } };
  // A saved process number can belong to another program by now.
  const read = (pid, file) => { try { return readFileSync(`/proc/${pid}/${file}`, 'utf8'); } catch { return ''; } };
  const copyName = basename(ROOT).slice('helm-verify-'.length);
  if (s?.browser && read(s.browser.pid, 'cmdline').split('\0').join(' ').includes(`_hold --name ${copyName}`)) stop(s.browser.pid, true);
  if (s?.daemon && read(s.daemon, 'environ').split('\0').includes(`HELM_DIR=${join(ROOT, 'helm')}`)) stop(s.daemon, true);
  // Terminal and agent hosts start as their own session leaders, and the
  // browser may outlive its holder. They are found by this copy's HELM_DIR
  // or folder, never by name: a name match can be the real laptop's host
  // (and pkill -f matches the shell running it).
  const mine = `HELM_DIR=${join(ROOT, 'helm')}`;
  // A program run on this copy names it as an argument (`--user-data-dir=`).
  // A shell command that only mentions the folder, such as the one running
  // this, is not the copy's, and neither is anything that started us.
  const inside = (arg) => arg.startsWith(`${ROOT}/`) || new RegExp(`^--[\\w-]+=${ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`).test(arg);
  const callers = new Set();
  for (let pid = process.ppid; pid > 1 && !callers.has(pid);) {
    callers.add(pid);
    try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]); } catch { break; }
  }
  await sleep(300);
  for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p)).map(Number)) {
    if (pid === process.pid || callers.has(pid)) continue;
    try {
      const ours = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(mine)
        || readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').some(inside);
      if (ours) stop(pid, false);
    } catch { /* not ours */ }
  }
  await sleep(500);
  if (!keep) rmSync(ROOT, { recursive: true, force: true });
  return killed;
}

/**
 * Copies a chat forgot to take down: their Helm has stopped, or no command
 * has used them for STALE_MS. Each `up` clears them, so a forgotten copy
 * does not hold its daemon, browser and agents for days.
 */
const STALE_MS = 12 * 60 * 60_000;
async function sweepStale() {
  const base = dirname(ROOT);
  for (const entry of readdirSync(base)) {
    const root = join(base, entry);
    if (!entry.startsWith('helm-verify-') || root === ROOT) continue;
    let s = null, used = 0;
    try { s = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')); used = statSync(join(root, 'state.json')).mtimeMs; } catch { continue; }
    if (s?.daemon && alive(s.daemon) && Date.now() - used < STALE_MS) continue;
    const why = s?.daemon && alive(s.daemon) ? 'unused for 12 hours' : 'its Helm had stopped';
    const stopped = await stopCopy(root, s);
    say(`cleared copy "${entry.slice('helm-verify-'.length)}": ${why}${stopped.length ? `, stopped ${stopped.length} processes` : ''}.`);
  }
}

// Each command marks the copy as in use, so sweepStale leaves it alone.
if (cmd !== 'down' && existsSync(STATE)) { try { const now = new Date(); utimesSync(STATE, now, now); } catch { /* best effort */ } }

switch (cmd) {
  case 'up': await up(); break;
  case 'open': await open(args[0]); break;
  case 'click': await act(async (page) => {
    const el = await find(page, args.join(' ')) ?? die(`nothing visible matches "${args.join(' ')}"`);
    await el.click({ timeout: 5000 }).catch((e) => die(`"${args.join(' ')}" is there but cannot be clicked (disabled or covered): ${e.message.split('\n')[0]}`));
    await sleep(400);
    say(`clicked "${args.join(' ')}"`);
  }); break;
  case 'type': await act(async (page) => {
    const into = await page.evaluate(() => { const el = document.activeElement; return el && el !== document.body ? (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.tagName.toLowerCase()) : null; });
    if (!into) die('nothing has focus; click the text box first');
    await page.keyboard.type(args.join(' '));
    say(`typed into ${into}`);
  }); break;
  case 'upload': await act(async (page) => {
    // The clip button opens the system file picker; hand the files to its
    // hidden input instead, which is what picking them would do.
    const input = page.locator('input[type=file]').first();
    if (!await input.count()) die('no file input on this screen; open a chat first');
    await input.setInputFiles(args.map((f) => resolve(f)));
    await sleep(400);
    say(`attached ${args.length} file${args.length === 1 ? '' : 's'}`);
  }); break;
  case 'key': await act(async (page) => { await page.keyboard.press(args[0]); await sleep(300); say(`pressed ${args[0]}`); }); break;
  case 'wait': await act(async (page) => {
    const want = args[0];
    const ms = Number(args[1] ?? 15_000);
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if ((await visibleText(page)).includes(want)) return say(`saw "${want}"`);
      await sleep(250);
    }
    die(`did not see "${want}" within ${ms} ms`);
  }); break;
  case 'text': await act(async (page) => say((await visibleText(page)).slice(0, 8000))); break;
  case 'shot': await act(async (page) => {
    const file = resolve(args[0] ?? join(ROOT, `shot-${Date.now()}.png`));
    await page.screenshot({ path: file, fullPage: has('full') });
    say(file);
  }); break;
  case 'eval': await act(async (page) => say(JSON.stringify(await page.evaluate(args.join(' ')), null, 2))); break;
  case 'record': await record(args[0], args[1]); break;
  case 'compare': await compare(args[0], args[1], args[2]); break;
  case 'size': {
    writeFileSync(join(ROOT, 'viewport.json'), JSON.stringify({ width: Number(args[0]), height: Number(args[1]) }));
    await sleep(600);
    await act(async (page) => say(`size: ${await page.evaluate(() => `${innerWidth}×${innerHeight}`)}`));
    break;
  }
  case 'errors': {
    const log = join(ROOT, 'errors.log');
    say(existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').slice(-40).join('\n') : 'no page errors');
    if (has('clear')) rmSync(log, { force: true });
    break;
  }
  case '_hold': await hold(); break;
  case 'logs': say(readFileSync(join(ROOT, 'daemon.log'), 'utf8').split('\n').slice(-Number(args[0] ?? 40)).join('\n')); break;
  case 'rpc': say(JSON.stringify(await rpc(args[0], args[1] ? JSON.parse(args[1]) : {}), null, 2)); break;
  case 'status': {
    const s = state();
    say(!s ? `no copy "${name}"` : `copy "${name}": Helm ${alive(s.daemon) ? 'up' : 'stopped'} at ${s.url}, browser ${s.browser && alive(s.browser.pid) ? 'open' : 'closed'}, files in ${s.root}`);
    break;
  }
  case 'restart': await restart(); break;
  case 'down': await down(); break;
  default:
    say(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 11).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exitCode = cmd ? 1 : 0;
}
