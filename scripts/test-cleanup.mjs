// A test run cleans up after itself, even when its tests do not.
//
// Each run gets its own temporary folder, handed to the tests as TMPDIR, so
// every mkdtemp, socket, fake home and browser profile a test makes lands in
// it. When the run ends, any program still running with that TMPDIR was
// started by a test and left behind: it is stopped, and the folder goes. A
// run that crashed before it could clean up is cleaned by the next one.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREFIX = 'ht-';
const LINUX = process.platform === 'linux';

/** A fresh folder for one run, named after the runner so a crash can be told apart. */
export function runFolder(base = tmpdir(), pid = process.pid) {
  return mkdtempSync(path.join(base, `${PREFIX}${pid}-`));
}

/** Programs of this user still running with this run's TMPDIR. Linux only: elsewhere, none are found. */
export function leftovers(folder, { proc = '/proc', self = process.pid } = {}) {
  if (!LINUX && proc === '/proc') return [];
  const mark = `TMPDIR=${folder}\0`;
  const found = [];
  let pids = [];
  try { pids = readdirSync(proc).filter((name) => /^\d+$/.test(name)); } catch { return found; }
  for (const pid of pids) {
    if (Number(pid) === self) continue;
    try {
      if (!`${readFileSync(path.join(proc, pid, 'environ'), 'latin1')}\0`.includes(mark)) continue;
      const command = readFileSync(path.join(proc, pid, 'cmdline'), 'utf8').split('\0').filter(Boolean).join(' ');
      found.push({ pid: Number(pid), command });
    } catch { /* gone, or another user's */ }
  }
  return found;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

/** Stop what the run left behind and remove its folder. Returns the programs that were still running. */
export async function sweep(folder, { proc, graceMs = 3000 } = {}) {
  const left = leftovers(folder, { proc });
  for (const { pid } of left) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  for (const until = Date.now() + graceMs; left.some(({ pid }) => alive(pid)) && Date.now() < until;) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const { pid } of left) { if (alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  for (const until = Date.now() + 1000; left.some(({ pid }) => alive(pid)) && Date.now() < until;) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return left;
}

/** Folders of earlier runs whose runner is gone: a crash or a killed terminal. */
export async function sweepCrashed(base = tmpdir(), options = {}) {
  let names = [];
  try { names = readdirSync(base); } catch { return []; }
  const cleaned = [];
  for (const name of names) {
    const m = new RegExp(`^${PREFIX}(\\d+)-`).exec(name);
    if (!m || alive(Number(m[1]))) continue;
    cleaned.push(...await sweep(path.join(base, name), options));
  }
  return cleaned;
}
