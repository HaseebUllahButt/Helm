#!/usr/bin/env node
// See Helm working for real, without touching the owner's Helm.
//
//   node scripts/verify-helm.mjs up [--real]   private Helm + free fake agents (--real: your real logins too)
//   node scripts/verify-helm.mjs open [#hash] [--desktop]   hidden browser (390×844 phone), signed in
//   node scripts/verify-helm.mjs click <text> | type <text> | key <key> | wait <text> [ms]
//   node scripts/verify-helm.mjs text | shot [file.png] [--full] | errors [--clear] | logs [n] | size <w> <h>
//   node scripts/verify-helm.mjs eval <js> | rpc <method> [json] | upload <file>...
//   node scripts/verify-helm.mjs status | down [--keep]
//
// Each chat gets its own copy (named from HELM_SESSION_ID, or --name /
// HELM_VERIFY), so two agents never share one. Everything lives under
// /tmp/helm-verify-<name>; the real ~/.helm, its sockets and its systemd
// units are never used, and `down` stops only processes this copy started.
// The skill in .agents/skills/verify-helm says when and how to use it.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
  ];
  writeFileSync(join(dir, 'helm', 'profiles.json'), JSON.stringify({ version: 1, profiles: fake }, null, 2), { mode: 0o600 });
}

async function up() {
  const s = state();
  if (s && alive(s.daemon)) return say(`already up: ${s.url}  (copy "${name}")`);
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
  save({ name, root: ROOT, url, port, daemon: child.pid });
  // Real logins only on request: a real chat costs money and lands in that
  // account's history.
  if (real) await rpc('profile.list', { refresh: true });
  say(`up: ${url}  (copy "${name}", files in ${ROOT})`);
  say(`accounts: "fake" (answers in 0.8 s) and "fake-ask" (asks permission first)${real ? ', plus your real logins' : ''}.`);
  say(`work folder for test chats: ${join(ROOT, 'work')}`);
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
  // the machine's Chromium does the same job.
  const system = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => existsSync(p));
  const context = await chromium.launchPersistentContext(join(s.root, 'browser'), options).catch((e) => {
    if (!system || !/Executable doesn't exist/.test(e.message)) throw e;
    return chromium.launchPersistentContext(join(s.root, 'browser'), { ...options, executablePath: system });
  });
  const page = context.pages()[0] ?? await context.newPage();
  const errors = join(s.root, 'errors.log');
  const note = (line) => writeFileSync(errors, `${new Date().toISOString().slice(11, 19)} ${line}\n`, { flag: 'a' });
  page.on('pageerror', (e) => note(`page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') note(`console: ${m.text()}`); });
  // `size` writes viewport.json; apply it here, where the override lasts.
  const sizeFile = join(s.root, 'viewport.json');
  setInterval(async () => {
    if (!existsSync(sizeFile)) return;
    const v = JSON.parse(readFileSync(sizeFile, 'utf8'));
    rmSync(sizeFile);
    await page.setViewportSize(v).catch((e) => note(`size: ${e.message}`));
  }, 200);
  process.on('SIGTERM', () => context.close().finally(() => process.exit(0)));
}

async function open(hash = '') {
  const s = state() ?? die('not up; run: node scripts/verify-helm.mjs up');
  if (!s.browser || !alive(s.browser.pid)) {
    s.browser = { cdp: await freePort(), desktop: has('desktop') };
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
  const s = state();
  const keep = has('keep');
  const killed = [];
  const stop = (pid, group) => { try { process.kill(group ? -pid : pid, 'SIGTERM'); killed.push(pid); } catch { /* gone */ } };
  if (s?.browser) stop(s.browser.pid, true);
  if (s?.daemon) stop(s.daemon, true);
  // Terminal and agent hosts start as their own session leaders, and the
  // browser may outlive its holder. They are found by this copy's HELM_DIR
  // or folder, never by name: a name match can be the real laptop's host
  // (and pkill -f matches the shell running it).
  const mine = `HELM_DIR=${join(ROOT, 'helm')}`;
  await sleep(300);
  for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p)).map(Number)) {
    if (pid === process.pid) continue;
    try {
      const ours = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(mine)
        || readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(ROOT + '/');
      if (ours) stop(pid, false);
    } catch { /* not ours */ }
  }
  await sleep(500);
  if (!keep) rmSync(ROOT, { recursive: true, force: true });
  say(`down: stopped ${killed.length} process${killed.length === 1 ? '' : 'es'}${keep ? `, kept ${ROOT}` : ', files removed'}.`);
}

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
  case 'down': await down(); break;
  default:
    say(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 9).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exitCode = cmd ? 1 : 0;
}
