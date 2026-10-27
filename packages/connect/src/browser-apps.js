import { readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const read = path => readFile(path, 'utf8').catch(() => '');
const link = path => readlink(path).catch(() => '');
const files = path => readdir(path).catch(() => []);
const inside = (folder, cwd) => { const part = relative(folder, cwd); return part === '' || (part !== '..' && !part.startsWith('../') && !isAbsolute(part)); };

// Inspect listening sockets only. Discovery sends no HTTP or TLS, even to
// owned sockets: an app can use a binary protocol, like an agent's helper.
export function procListeners(text) {
  return text.trim().split('\n').slice(1).flatMap(line => {
    const row = line.trim().split(/\s+/), [address, hex] = (row[1] || '').split(':');
    if (row[3] !== '0A' || !row[9]) return [];
    const local = address === '00000000' || address === '0100007F' || address === '00000000000000000000000000000000' || address === '00000000000000000000000001000000' || address === '0000000000000000FFFF00000100007F';
    const port = parseInt(hex, 16);
    return local && port > 0 ? [{ inode: row[9], port }] : [];
  });
}

export function internalApp(argv) {
  const names = argv.slice(0, 2).map(arg => basename(arg).toLowerCase());
  if (names.some(name => /^(helm(?:-.*)?(?:\.js)?|codex|claude|devin|opencode|pi|cursor-agent|agy|antigravity|grok|chromium|chrome|chrome_crashpad)(?:\.exe)?$/.test(name))) return true;
  return argv.some(arg => /(?:^|[/\\])(?:@anthropic-ai|@openai|@zed-industries)(?:[/\\])/.test(arg)
    || /(?:^|[/\\-])mcp(?:[/\\-]|$)|^app-server$|^--remote-debugging-|^run-server$/.test(arg));
}

/**
 * Chromium and some servers rewrite their command line into one string;
 * split it again so the program name is the first word.
 */
export const commandWords = (cmdline) => {
  const words = cmdline.split('\0').filter(Boolean);
  return words.length === 1 && /\s/.test(words[0]) ? words[0].split(/\s+/).filter(Boolean) : words;
};

/** The processes a chat started that are not Helm's or an agent's own. */
export function chatProcesses(processes, { roots = [], cwd = null } = {}) {
  const byPid = new Map(processes.map(p => [p.pid, p]));
  const rootSet = new Set(roots.filter(pid => Number.isInteger(pid) && pid > 0));
  const owned = p => {
    const seen = new Set();
    for (let parent = p; parent && !seen.has(parent.pid); parent = byPid.get(parent.ppid)) {
      if (rootSet.has(parent.pid)) return true;
      seen.add(parent.pid);
    }
    return !!(cwd && p.cwd && inside(cwd, p.cwd));
  };
  return processes.filter(p => owned(p) && !rootSet.has(p.pid) && !internalApp(p.argv));
}

export function appRows(processes, listeners, { roots = [], cwd = null } = {}) {
  const ports = new Map();
  for (const p of chatProcesses(processes, { roots, cwd })) {
    for (const socket of listeners.filter(socket => p.sockets.has(socket.inode))) {
      const name = p.argv.find(arg => /(?:^|[/\\])(?:vite|next|astro|webpack|http-server)(?:[/\\.]|$)/.test(arg));
      const app = { port: socket.port, name: name ? basename(name).replace(/\.(?:m?js|cjs)$/, '') : basename(p.argv[0] || p.name || 'App'), pid: p.pid };
      if (!ports.has(app.port)) ports.set(app.port, app);
    }
  }
  return [...ports.values()].sort((a, b) => a.port - b.port);
}

// Linux first. Read each process once per panel request; no background scan.
export async function discoverApps(session, { roots = [], proc = '/proc', platform = process.platform, home = homedir(), exec = run } = {}) {
  let cwd = null;
  if (session.cwd && !session.quick && session.cwd !== '~') {
    const project = session.cwd.startsWith('~/') ? resolve(home, session.cwd.slice(2)) : session.cwd;
    if (isAbsolute(project)) {
      const folder = await realpath(project).catch(() => null), homeFolder = await realpath(home).catch(() => home);
      if (folder && folder !== homeFolder && folder !== '/') cwd = folder;
    }
  }
  if (platform === 'linux') {
    const listeners = (await Promise.all(['tcp', 'tcp6'].map(file => read(`${proc}/net/${file}`)))).flatMap(procListeners);
    if (!listeners.length) return [];
    const processes = (await Promise.all((await files(proc)).filter(pid => /^\d+$/.test(pid)).map(async pid => {
      const [stat, cmd, folder, env] = await Promise.all([read(`${proc}/${pid}/stat`), read(`${proc}/${pid}/cmdline`), link(`${proc}/${pid}/cwd`), read(`${proc}/${pid}/environ`)]);
      if (!stat || !cmd) return null;
      const vars = new Map(env.split('\0').map(item => { const at = item.indexOf('='); return [item.slice(0, at), item.slice(at + 1)]; }));
      // A shared Codex app-server can serve several chats. Its environment
      // cannot tie all its children to the first chat. Use their folders.
      const argv = commandWords(cmd);
      if (vars.get('HELM_SESSION_ID') === session.id && internalApp(argv) && !argv.includes('app-server')) roots.push(Number(pid));
      return { pid: Number(pid), ppid: Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]), argv, cwd: folder, sockets: new Set() };
    }))).filter(Boolean);
    // Open files only for the chat's own processes: reading every program's
    // file list on each look cost most of the time.
    await Promise.all(chatProcesses(processes, { roots, cwd }).map(async p => {
      const descriptors = await files(`${proc}/${p.pid}/fd`);
      p.sockets = new Set((await Promise.all(descriptors.map(fd => link(`${proc}/${p.pid}/fd/${fd}`)))).flatMap(value => /^socket:\[(\d+)\]$/.exec(value)?.[1] || []));
    }));
    return appRows(processes, listeners, { roots, cwd });
  }
  if (platform !== 'darwin') return [];
  try {
    const [{ stdout: ps }, { stdout: output }] = await Promise.all([
      exec('ps', ['-axo', 'pid=,ppid=,args='], { maxBuffer: Infinity }),
      exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-FpcfnT'], { maxBuffer: Infinity }),
    ]);
    const processes = ps.trim().split('\n').flatMap(line => { const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line); return m ? [{ pid: +m[1], ppid: +m[2], argv: m[3].split(/\s+/), cwd: '', sockets: new Set() }] : []; });
    const listeners = [];
    let processRow, fd = '', address = '';
    for (const line of output.split('\n')) {
      const tag = line[0], value = line.slice(1);
      if (tag === 'p') processRow = processes.find(p => p.pid === +value);
      if (tag === 'f') { fd = value; address = ''; }
      if (!processRow) continue;
      if (tag === 'n' && fd === 'cwd') processRow.cwd = value;
      else if (tag === 'n') address = value;
      if (tag === 'T' && value === 'ST=LISTEN') {
        const match = /^(?:\*|localhost|127\.0\.0\.1|\[::1\]):(\d+)$/.exec(address);
        if (match) { const inode = `${processRow.pid}:${fd}`; processRow.sockets.add(inode); listeners.push({ inode, port: +match[1] }); }
      }
    }
    const withSockets = processes.filter(p => p.sockets.size);
    if (cwd && withSockets.length) {
      const { stdout } = await exec('lsof', ['-nP', '-a', '-p', withSockets.map(p => p.pid).join(','), '-d', 'cwd', '-Fpn'], { maxBuffer: Infinity });
      let row;
      for (const line of stdout.split('\n')) {
        if (line[0] === 'p') row = processes.find(p => p.pid === +line.slice(1));
        if (line[0] === 'n' && row) row.cwd = line.slice(1);
      }
    }
    return appRows(processes, listeners, { roots, cwd });
  } catch { return []; } // No lsof, no guess.
}
