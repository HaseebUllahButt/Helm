#!/usr/bin/env node
// Counts how often each React component renders in the Helm web app, in four
// moments, at phone size (390x844) and desktop size (1280x800):
//   A  another chat (not the open one) streams a reply
//   B  the open chat streams a reply
//   C  30 characters are typed in the composer
//   D  switching to another chat and back
//
//   node scripts/render-count.mjs [--label before] [--window 5000] [--out file.json] [--keep]
//
// It only ever talks to a private verify-helm copy (its own folder, port and
// home under /tmp/helm-verify-<name>); the owner's ~/.helm is never used. The
// web app is built without minification into apps/web/dist of THIS checkout
// (which is where the copy serves it from) so component names survive, and
// scripts/render-count-hook.js is installed before the app loads. Streams come
// from scripts/render-count-agent.mjs. Rebuild is automatic; run it again
// after a fix to get comparable numbers.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const keep = argv.includes('--keep');
const label = opt('label', 'run');
const WINDOW = Number(opt('window', 5000));
const name = opt('name', 'render-count').replace(/[^a-zA-Z0-9-]/g, '');
const ROOT = join(tmpdir(), `helm-verify-${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STREAM_MS = 18000;

const verify = (...a) => {
  const r = spawnSync(process.execPath, [join(REPO, 'scripts/verify-helm.mjs'), '--name', name, ...a], { cwd: REPO, encoding: 'utf8', timeout: 180_000 });
  if (r.status !== 0) throw new Error(`verify-helm ${a.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
};
// The machine needs a moment after `up` before it answers, so retry.
const rpc = (method, params) => {
  for (let i = 0; ; i++) {
    try { return JSON.parse(verify('rpc', method, JSON.stringify(params))); } catch (e) {
      if (i >= 20 || !/not connected|unreachable/.test(e.message)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
};
// Send a message the way `helm say` does, aimed at the copy and never the real Helm.
const say = (id, text) => {
  const env = { ...process.env, HELM_DIR: join(ROOT, 'helm') };
  for (const k of ['HELM_SESSION_ID', 'HELM_NATIVE_SESSION', 'CODEX_THREAD_ID']) delete env[k];
  const r = spawnSync(process.execPath, [join(REPO, 'packages/connect/bin/helm.js'), 'say', id, text], { cwd: REPO, env, encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw new Error(`say failed: ${r.stderr || r.stdout}`);
};

function build() {
  // Unminified so component names are readable; gitignored output.
  const r = spawnSync('npx', ['vite', 'build', '--minify', 'false'], { cwd: join(REPO, 'apps/web'), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`web build failed: ${r.stderr || r.stdout}`);
}

function addProfiles() {
  const bin = (file) => {
    const p = join(ROOT, 'bin', file);
    writeFileSync(p, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(REPO, 'scripts/render-count-agent.mjs'))} "$@"\n`);
    chmodSync(p, 0o755);
    return p;
  };
  const f = join(ROOT, 'helm', 'profiles.json');
  const j = JSON.parse(readFileSync(f, 'utf8'));
  const cmd = bin('devin-stream');
  for (const [id, ms] of [['fake-stream', STREAM_MS], ['fake-short', 1500]]) {
    j.profiles.push({ id, label: id, engine: 'devin', cmd, args: [], env: { FAKE_STREAM_MS: String(ms), FAKE_HOME: join(ROOT, id) }, source: 'custom' });
  }
  writeFileSync(f, JSON.stringify(j, null, 2));
  rpc('profile.list', { refresh: true });
}

const start = (profileId, title) => rpc('session.start', { quick: true, profileId, title }).session.id;

/** Wait until the chat has finished replying. */
async function settle(ids) {
  for (let i = 0; i < 120; i++) {
    const { sessions } = rpc('session.list', {});
    if (ids.every((id) => sessions.find((s) => s.id === id)?.status === 'idle')) return;
    await sleep(500);
  }
  throw new Error('chats did not settle');
}

async function drive(desktop, ids) {
  verify('open', desktop ? '--desktop' : '--phone', '--init', join(REPO, 'scripts/render-count-hook.js'));
  const state = JSON.parse(readFileSync(join(ROOT, 'state.json'), 'utf8'));
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${state.browser.cdp}`);
  const page = browser.contexts()[0].pages()[0];
  const read = () => page.evaluate(() => window.__renders.read());
  const reset = () => page.evaluate(() => window.__renders.reset());
  const fresh = async () => {
    await page.goto(`${state.url}/`);
    await page.reload();
    await page.waitForLoadState('networkidle').catch(() => {});
    await sleep(1500);
  };
  // A chat row is on the sidebar (desktop) or the home list (phone: press Back first).
  const openChat = async (title) => {
    const row = () => page.getByText(title, { exact: true }).filter({ visible: true }).first();
    if (!await row().isVisible().catch(() => false)) await page.getByRole('button', { name: 'Back' }).filter({ visible: true }).first().click().catch(() => {});
    await row().click({ timeout: 10_000 });
    await sleep(1200);
  };
  const summary = async () => {
    const { commits, counts } = await read();
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15);
    return { commits, total, top };
  };
  const out = {};

  // A: another chat streams while short-one is open.
  await fresh();
  await openChat('short-one');
  say(ids.other, 'go');
  await sleep(1500);
  await reset();
  await sleep(WINDOW);
  out.A = await summary();
  await settle([ids.other]);

  // B: the open chat streams.
  await fresh();
  await openChat('chat-open');
  say(ids.open, 'go');
  await sleep(1500);
  await reset();
  await sleep(WINDOW);
  out.B = await summary();
  await settle([ids.open]);

  // C: typing 30 characters, everything idle.
  await fresh();
  await openChat('short-one');
  await page.getByPlaceholder(/Ask anything/).first().click();
  await sleep(300);
  await reset();
  await page.keyboard.type('abcdefghij abcdefghij abcdefghij', { delay: 60 });
  await sleep(500);
  out.C = await summary();

  // D: switch to another chat and back.
  await fresh();
  await openChat('short-one');
  await reset();
  await openChat('short-two');
  await openChat('short-one');
  out.D = await summary();

  const errors = verify('errors');
  await browser.close().catch(() => {});
  return { ...out, errors: /no page errors/.test(errors) ? null : errors };
}

let started = false;
const result = { label, window: WINDOW };
try {
  if (existsSync(join(ROOT, 'state.json'))) throw new Error(`copy "${name}" already exists; run: node scripts/verify-helm.mjs --name ${name} down, or pass --name`);
  build();
  verify('up'); started = true;
  addProfiles();
  const ids = { open: start('fake-stream', 'chat-open'), other: start('fake-stream', 'chat-other') };
  // Two settled chats (with a reply) to switch between.
  const one = start('fake-short', 'short-one'); const two = start('fake-short', 'short-two');
  say(one, 'hi'); say(two, 'hi');
  await sleep(1000);
  await settle([one, two]);
  for (const size of ['phone', 'desktop']) result[size] = await drive(size === 'desktop', ids);
} finally {
  if (started && !keep) verify('down');
}

const MOMENTS = { A: 'another chat streams', B: 'open chat streams', C: 'typing 30 characters', D: 'switch chat and back' };
for (const size of ['phone', 'desktop']) {
  console.log(`\n${size} (${size === 'phone' ? '390x844' : '1280x800'}), window ${WINDOW} ms for A/B`);
  console.log('| moment | commits | renders | top components |\n|---|---|---|---|');
  for (const m of 'ABCD') {
    const r = result[size][m];
    console.log(`| ${m} ${MOMENTS[m]} | ${r.commits} | ${r.total} | ${r.top.slice(0, 5).map(([n, c]) => `${n} ${c}`).join(', ')} |`);
  }
  if (result[size].errors) console.log(`page errors:\n${result[size].errors}`);
}
const file = resolve(opt('out', join(tmpdir(), `render-count-${label}.json`)));
mkdirSync(join(file, '..'), { recursive: true });
writeFileSync(file, JSON.stringify(result, null, 2));
console.log(`\nfull top-15 lists: ${file}`);
