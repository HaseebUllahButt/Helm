import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * What a running program is: its command line, folder, start time, parent
 * and open files. Linux answers from /proc; macOS from ps and lsof, which
 * see the same things for the owner's own processes. Everything returns
 * null or empty rather than throwing, so an OS that hides something only
 * costs that one detail.
 */
// Tests run the macOS paths on Linux against stand-in ps and lsof.
const LINUX = (process.env.HELM_TEST_PLATFORM || process.platform) === 'linux';
const run = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }); }
  catch (err) { return typeof err?.stdout === 'string' ? err.stdout : ''; }
};

/** Every process this user can see, with its arguments. */
export function processList() {
  if (LINUX) {
    const list = [];
    let pids = [];
    try { pids = readdirSync('/proc').filter((x) => /^\d+$/.test(x)); } catch { return list; }
    for (const pid of pids) {
      const argv = processArgv(Number(pid));
      if (argv?.length) list.push({ pid: Number(pid), argv });
    }
    return list;
  }
  // ps cannot keep arguments apart; spaces split them, which is enough to
  // recognise a CLI by name and flags.
  return run('ps', ['-axww', '-o', 'pid=,command=']).split('\n').map((line) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    return m ? { pid: Number(m[1]), argv: m[2].trim().split(/\s+/) } : null;
  }).filter(Boolean);
}

export function processArgv(pid) {
  if (LINUX) {
    try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { return null; }
  }
  const line = run('ps', ['-ww', '-o', 'command=', '-p', String(pid)]).trim();
  return line ? line.split(/\s+/) : null;
}

export function processCwd(pid) {
  if (LINUX) { try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return null; } }
  return run('lsof', ['-a', '-n', '-P', '-w', '-p', String(pid), '-d', 'cwd', '-Fn'])
    .split('\n').find((l) => l.startsWith('n'))?.slice(1) ?? null;
}

/** The same value Claude Code records as `procStart`, to tell a reused pid apart. */
export function processStart(pid) {
  if (LINUX) {
    try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]; }
    catch { return null; }
  }
  return run('ps', ['-o', 'lstart=', '-p', String(pid)]).trim() || null;
}

export function parentOf(pid) {
  if (LINUX) {
    try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]); }
    catch { return null; }
  }
  return Number(run('ps', ['-o', 'ppid=', '-p', String(pid)]).trim()) || null;
}

/** Files a process has open, with whether each is open for writing. `want` skips the rest early. */
export function openFiles(pids, want = () => true) {
  const out = [];
  if (LINUX) {
    for (const pid of pids) {
      const dir = `/proc/${pid}/fd`;
      let fds = [];
      try { fds = readdirSync(dir); } catch { continue; }
      for (const fd of fds) {
        try {
          const path = readlinkSync(join(dir, fd));
          if (!path.startsWith('/') || !want(path)) continue;
          const flags = /^flags:\s+([0-7]+)/m.exec(readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8'));
          out.push({ pid, path, write: !!flags && (parseInt(flags[1], 8) & 3) !== 0 });
        } catch { /* closed meanwhile */ }
      }
    }
    return out;
  }
  if (!pids.length) return out;
  // -F pan: one p line per process, then an a (access) and n (name) per file.
  let pid = 0, access = '';
  for (const line of run('lsof', ['-n', '-P', '-w', '-F', 'pan', '-p', pids.join(',')]).split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('a')) access = line.slice(1);
    else if (line.startsWith('n') && line[1] === '/' && want(line.slice(1))) out.push({ pid, path: line.slice(1), write: access === 'w' || access === 'u' });
  }
  return out;
}

/** The terminal a process reads from, if it has one. */
export function processTty(pid) {
  if (LINUX) {
    try { const t = readlinkSync(`/proc/${pid}/fd/0`); return /^\/dev\/(pts\/\d+|tty\w*)$/.test(t) ? t : null; } catch { return null; }
  }
  const tty = run('ps', ['-o', 'tty=', '-p', String(pid)]).trim();
  return tty && tty !== '??' ? `/dev/${tty}` : null;
}
