import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { HELM_DIR } from './paths.js';

/**
 * A record of every agent process that ended without Helm asking it to.
 *
 * On 2026-11-10 three Claude chats on the Laptop stopped at once (exit 143,
 * a SIGTERM) 20 s after a Helm restart, and nothing in Helm's log, the
 * system log or any chat said who sent it. A helper lost its work and its
 * lead started another. The process host writes one line here per stop:
 * the real time, the exit code, whether Helm itself asked for the stop,
 * whether a daemon was connected (none means Helm was restarting), and the
 * programs that started just before - the sender is often one of them.
 *
 * Local only, owner-readable only. Command lines can hold secrets, so the
 * file is 0600 and never leaves the machine.
 */
export const STOPS_FILE = () => join(HELM_DIR, 'agent-stops.jsonl');
const MAX_BYTES = 1024 * 1024;
const RECENT_S = 120;

/** Programs started in the last two minutes, and any that send signals. Linux only. */
export function recentPrograms({ seconds = RECENT_S, limit = 40 } = {}) {
  if (process.platform !== 'linux') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('ps', ['-eo', 'pid=,ppid=,etimes=,args=', '--sort=etimes'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve([]);
      const rows = [];
      for (const line of String(out).split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (!m) continue;
        const [, pid, ppid, age, args] = m;
        if (Number(pid) === process.pid) continue;
        if (Number(age) > seconds && !/\b(p?kill|killall|systemctl)\b/.test(args)) continue;
        rows.push({ pid: Number(pid), ppid: Number(ppid), age: Number(age), args: args.slice(0, 240) });
        if (rows.length >= limit) break;
      }
      resolve(rows);
    });
  });
}

/** Append one stop. Never throws: a full disk must not take the host down. */
export function recordStop(entry, file = STOPS_FILE()) {
  try {
    if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`);
    appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** The newest recorded stop of one agent, or null. */
export function lastStop(id, file = STOPS_FILE()) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const lines = text.trimEnd().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(`"${id}"`)) continue;
    try {
      const e = JSON.parse(lines[i]);
      if (e.id === id) return e;
    } catch { /* a torn line */ }
  }
  return null;
}

/** Plain words for a stop: when, how, and what Helm was doing. */
export function describeStop(e) {
  if (!e) return '';
  const d = new Date(e.at);
  const when = `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString('en-GB', { hour12: false })}`;
  if (e.memory) return `The memory guard stopped its process at ${when}, because the computer ran out of memory.`;
  const how = e.signal ? `signal ${e.signal}` : `code ${e.code}`;
  const why = e.askedByHelm ? 'Helm asked it to stop'
    : e.daemonConnected ? 'Helm did not ask it to stop'
      : 'Helm was restarting';
  return `Its process stopped at ${when} with ${how}. ${why}.`;
}

/** Stops since a time, oldest first, that Helm did not ask for. */
export function strayStops(since, file = STOPS_FILE()) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.at >= since && !e.askedByHelm) out.push(e);
    } catch { /* a torn line */ }
  }
  return out;
}
