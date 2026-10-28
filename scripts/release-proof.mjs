#!/usr/bin/env node
// Exercise a private free agent. Never use the owner's network or accounts.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
const exec = promisify(execFile);
const args = process.argv.slice(2);
const option = key => args[args.indexOf(key) + 1];
const name = args.includes('--name') ? option('--name') : `release-proof-${process.pid}`;
if (!/^[a-zA-Z0-9-]{1,24}$/.test(name)) throw new Error('Choose a valid private check name.');
const root = join(tmpdir(), `helm-verify-${name}`);
const verify = fileURLToPath(new URL('./verify-helm.mjs', import.meta.url));
const run = async (...args) => (await exec(process.execPath, [verify, '--name', name, ...args],
  { timeout: 90000, maxBuffer: 2 << 20 })).stdout.trim();
const rpc = async (method, params = {}) => JSON.parse(await run('rpc', method, JSON.stringify(params)));
const ready = async () => {
  const until = Date.now() + 30000;
  for (;;) {
    try { return await rpc('env.info'); }
    catch (error) {
      if (Date.now() >= until) throw new Error('The private machine did not reconnect in time.', { cause: error });
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
};
let browser;
let cleaning;
const cleanup = () => cleaning ??= (async () => {
  await browser?.close().catch(() => {});
  await run('down');
})();
const terminate = () => { void cleanup().finally(() => process.exit(143)); };
process.once('SIGTERM', terminate);
process.once('SIGINT', terminate);
try {
  await run('up');
  const expected = args.includes('--tip') ? option('--tip')
    : (await exec('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(new URL('..', import.meta.url)) })).stdout.trim();
  const info = await ready();
  if (info.version?.full !== expected || info.web?.commit !== expected || info.version?.dirty || info.web?.dirty) {
    throw new Error('The private check must run clean source and an app built from the release being installed.');
  }
  const state = () => JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  const network = JSON.parse(readFileSync(join(root, 'helm', 'network.json'), 'utf8'));
  const { session } = await rpc('session.start', { quick: true, profileId: 'fake-ask', title: 'Check release recovery' });
  await rpc('session.deliver', { id: session.id, messageId: '1'.repeat(32), data: 'Check recovery' });
  await run('open', `#open=${network.self}/${session.id}`);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${state().browser.cdp}`);
  const page = browser.contexts()[0].pages().find(p => p.url().startsWith(state().url));
  if (!page) throw new Error('The private app did not open.');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const approve = page.getByRole('button', { name: 'Approve', exact: true });
  await approve.waitFor({ state: 'visible', timeout: 30000 });
  const before = await rpc('session.events', { id: session.id });
  const requestId = before.pending?.[0]?.requestId;
  if (typeof requestId !== 'string' || !requestId) throw new Error('The private chat has no approval to check.');
  await run('restart');
  await ready();
  await page.waitForFunction(() => !document.body.innerText.includes('Reconnecting'), undefined, { timeout: 30000 });
  const after = await rpc('session.events', { id: session.id });
  if (!after.pending?.some(p => p.requestId === requestId)) {
    throw new Error('The approval did not survive the restart.');
  }
  await approve.click();
  await page.getByText('working on it done.', { exact: false }).waitFor({ timeout: 30000 });
  const complete = await rpc('session.events', { id: session.id });
  if (complete.pending?.length) throw new Error('The approval did not finish.');
  const turns = complete.events.filter(e => e.type === 'turn.start' && !String(e.turnId).startsWith('local-'));
  if (turns.length !== 1 || complete.session?.prompts !== 1) throw new Error('The chat repeated its work.');
  if (errors.length) throw new Error('The private app reported a page error during recovery.');
  console.log('The private chat reconnects after restart. Its saved approval completes once.');
} finally {
  await cleanup();
  process.off('SIGTERM', terminate);
  process.off('SIGINT', terminate);
}
