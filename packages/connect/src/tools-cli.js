import { accessSync, constants, fstatSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { M } from '@helm/protocol';
import { Tools, checkTool } from './tools.js';
import { runLocalWork, runRemoteCommand } from './execution-cli.js';
import { WORK_TIMEOUT_MS } from './work-command.js';

/**
 * `helm tools`: named local commands that every agent on every machine can
 * find and run. Each machine keeps its own tools; list asks every machine,
 * the way `helm schedule list` does.
 */
export const TOOLS_USAGE = 'helm tools list [--json] | show <name> | run <name> [args] | add <name> [--description <text>] [--machine <name>] [--cwd <path>] -- <command> | remove <name> [--machine <name>]';

const MAX_INPUT = 1024 * 1024;

/** One word for a shell: quoted only when it needs it. */
export const shellWord = (w) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`;
const when = (at) => new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

/** Pull `--flag value` pairs out of the words before the first plain word that ends them. */
function takeFlags(words, names, { stopAtWord = false } = {}) {
  const flags = {}, rest = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (stopAtWord && rest.length) { rest.push(...words.slice(i)); break; }
    if (names.includes(w)) {
      const value = words[++i];
      if (value == null || value.startsWith('--')) throw new Error(`Give a value after ${w}.`);
      flags[w.slice(2)] = value;
    } else if (w === '--json') flags.json = true;
    else if (w.startsWith('--')) throw new Error(`Unknown option ${w}.\n${TOOLS_USAGE}`);
    else rest.push(w);
  }
  return { flags, rest };
}

function onPath(cmd) {
  if (cmd.includes('/')) { try { accessSync(cmd, constants.X_OK); return true; } catch { return false; } }
  return String(process.env.PATH ?? '').split(delimiter).some((dir) => {
    try { accessSync(join(dir, cmd), constants.X_OK); return true; } catch { return false; }
  });
}

/**
 * All input that a pipe or file gives, for a tool on another machine. A
 * terminal or /dev/null gives none. A pipe that sends nothing at all in the
 * first second counts as no input, so an agent shell that keeps an empty
 * pipe open does not hang the run.
 */
export async function readInput(stdin = process.stdin, { firstByteMs = 1000, limit = MAX_INPUT } = {}) {
  if (stdin.isTTY) return null;
  try { if (fstatSync(stdin.fd ?? 0).isCharacterDevice()) return null; } catch { return null; }
  return new Promise((done, fail) => {
    const parts = []; let size = 0, finished = false;
    const finish = (value, error) => {
      if (finished) return; finished = true;
      clearTimeout(timer);
      stdin.off('data', onData); stdin.off('end', onEnd); stdin.off('error', onEnd);
      stdin.pause(); if (typeof stdin.unref === 'function') stdin.unref();
      if (error) fail(error); else done(value);
    };
    const onData = (chunk) => {
      clearTimeout(timer);
      size += chunk.length; parts.push(chunk);
      if (size > limit) finish(null, new Error('The input is larger than 1 MB. Save it to a file on that machine and give the path instead.'));
    };
    const onEnd = () => finish(size ? Buffer.concat(parts) : null);
    const timer = setTimeout(() => { if (!size) finish(null); }, firstByteMs);
    stdin.on('data', onData); stdin.once('end', onEnd); stdin.once('error', onEnd);
    stdin.resume();
  });
}

/**
 * @param {string[]} args  the words after `helm tools`
 * @param {object} deps    net, rpc(env, method, params, timeout), machineId(name), write, store,
 *                         runLocal(args), runRemote(options), input()
 */
export async function runToolsCommand(args, {
  net, rpc, machineId, write = console.log, store = new Tools(),
  runLocal = runLocalWork, runRemote = (options) => runRemoteCommand(options, { net, machineId: () => options.machineId }),
  input = readInput,
} = {}) {
  const verb = args[0] && !args[0].startsWith('--') ? args[0] : 'list';
  const words = args[0] === verb ? args.slice(1) : args;
  const machines = Object.values(net.machines ?? {}).filter((m) => !net.revoked?.[m.id]);
  const self = net.machines?.[net.self] ?? { id: net.self, name: 'this machine' };
  const byName = (name) => {
    const id = machineId(name);
    return net.machines?.[id] ?? { id, name };
  };

  /** One machine's tools. This machine reads its own file, so it works with Helm stopped. */
  const ask = async (m) => {
    if (m.id === net.self) return { machine: m, online: true, tools: store.list(), at: Date.now() };
    try {
      const r = await rpc(m.id, M.TOOL_LIST, { seen: true }, 5000);
      return { machine: m, online: true, tools: r.tools ?? [], at: r.at ?? Date.now(), seen: r.seen };
    } catch (error) {
      // The machine answered, but does not know tool.list: an older Helm.
      if (error.rpc && /unknown method/i.test(error.message)) return { machine: m, online: true, older: true, tools: [] };
      return { machine: m, online: false, tools: [] };
    }
  };

  /**
   * Every machine's tools. An offline machine shows what was last heard
   * from it, here or on any machine that answered.
   */
  const gather = async (only) => {
    const rows = await Promise.all((only ? [only] : machines).map(ask));
    const heard = {};
    for (const r of rows) {
      if (r.online && !r.older) heard[r.machine.id] = { tools: r.tools, at: r.at };
      for (const [id, entry] of Object.entries(r.seen ?? {})) if ((heard[id]?.at ?? 0) < (entry?.at ?? 0) && !rows.find((x) => x.machine.id === id && x.online)) heard[id] = entry;
    }
    let seen = {};
    try { seen = store.remember(heard, net.self); } catch { seen = store.seen(); }
    for (const r of rows) {
      if (r.online || !seen[r.machine.id]) continue;
      r.tools = seen[r.machine.id].tools; r.seenAt = seen[r.machine.id].at;
    }
    return rows;
  };

  /** The one tool with this name, or a plain error. Prefers this machine. */
  const find = async (name, on) => {
    if (!name) throw new Error(`Give the tool name: helm tools ${verb} <name>. Run helm tools list to see them.`);
    if (!on || machineId(on) === net.self) {
      const own = store.get(name);
      if (own) return { machine: self, online: true, tool: own };
      if (on) throw new Error(`${self.name} has no tool "${name}". Run helm tools list.`);
    }
    const rows = await gather(on ? byName(on) : undefined);
    const hits = rows.flatMap((r) => r.tools.filter((t) => t.name === name).map((tool) => ({ ...r, tool })));
    if (!hits.length) {
      const older = rows.filter((r) => r.older).map((r) => r.machine.name);
      throw new Error(`No tool "${name}" found.${older.length ? ` These machines run an older Helm with no tools: ${older.join(', ')}.` : ''} Run helm tools list.`);
    }
    if (hits.length > 1) {
      throw new Error(`"${name}" is on ${hits.length} machines: ${hits.map((h) => h.machine.name).join(', ')}. Add --machine <name> to pick one.`);
    }
    return hits[0];
  };

  if (verb === 'list' || verb === 'ls') {
    const { flags, rest } = takeFlags(words, []);
    if (rest.length) throw new Error(TOOLS_USAGE);
    const rows = await gather();
    if (flags.json) {
      write(JSON.stringify({
        tools: rows.flatMap((r) => r.tools.map((t) => ({
          name: t.name, machine: r.machine.name, machineId: r.machine.id, online: r.online,
          description: t.description ?? '', command: t.argv, ...(t.cwd ? { cwd: t.cwd } : {}),
          ...(r.seenAt ? { lastSeen: r.seenAt } : {}),
        }))),
        offline: rows.filter((r) => !r.online).map((r) => r.machine.name),
        olderHelm: rows.filter((r) => r.older).map((r) => r.machine.name),
      }));
      return 0;
    }
    if (!rows.some((r) => r.tools.length)) write('\n  No machine has tools. Add one with: helm tools add <name> -- <command>');
    for (const r of rows) {
      if (!r.tools.length) continue;
      const state = r.online ? 'online' : `offline${r.seenAt ? `, last seen ${when(r.seenAt)}` : ''}`;
      write(`\n  ${r.machine.name}  (${state})`);
      const width = Math.max(...r.tools.map((t) => t.name.length));
      for (const t of r.tools) write(`    ${t.name.padEnd(width)}  ${t.description || shellWord(t.argv[0])}`);
    }
    const unknown = rows.filter((r) => !r.online && !r.seenAt).map((r) => r.machine.name);
    if (unknown.length) write(`\n  Offline, tools not known: ${unknown.join(', ')}.`);
    const older = rows.filter((r) => r.older).map((r) => r.machine.name);
    if (older.length) write(`\n  Older Helm, no tools: ${older.join(', ')}.`);
    if (rows.some((r) => r.tools.length)) write('\n  Run one with: helm tools run <name> [args]. See one with: helm tools show <name>.');
    write('');
    return 0;
  }

  if (verb === 'show') {
    const { flags, rest } = takeFlags(words, ['--machine']);
    if (rest.length !== 1) throw new Error('Give one tool name: helm tools show <name> [--machine <name>].');
    const hit = await find(rest[0], flags.machine);
    const t = hit.tool;
    if (flags.json) { write(JSON.stringify({ machine: hit.machine.name, machineId: hit.machine.id, online: hit.online, tool: t })); return 0; }
    write(`\n  ${t.name}  (on ${hit.machine.name}, ${hit.online ? 'online' : 'offline'})`);
    if (t.description) write(`  What:     ${t.description}`);
    write(`  Command:  ${t.argv.map(shellWord).join(' ')}`);
    write(`  Folder:   ${t.cwd ?? 'the folder you run it from (the home folder on another machine)'}`);
    if (t.createdAt) write(`  Added:    ${when(t.createdAt)}`);
    write(`  Run it:   helm tools run ${t.name} [args]`);
    write(`  Remove:   helm tools remove ${t.name}${hit.machine.id === net.self ? '' : ` --machine ${hit.machine.name}`}\n`);
    return 0;
  }

  if (verb === 'add') {
    const end = words.indexOf('--');
    if (end < 0 || end === words.length - 1) throw new Error(`Give the command after --.\n${TOOLS_USAGE}`);
    const { flags, rest } = takeFlags(words.slice(0, end), ['--description', '--machine', '--cwd']);
    if (rest.length !== 1) throw new Error(`Give one tool name before --.\n${TOOLS_USAGE}`);
    const target = flags.machine ? byName(flags.machine) : self;
    const here = target.id === net.self;
    const argv = words.slice(end + 1);
    // ./script means the script in this folder, but only this machine has it.
    if (/^\.\.?\//.test(argv[0])) {
      if (!here) throw new Error(`Give the full path of the command on ${target.name}.`);
      argv[0] = resolve(argv[0]);
    }
    const cwd = flags.cwd && (isAbsolute(flags.cwd) || !here ? flags.cwd : resolve(flags.cwd));
    const tool = checkTool({ name: rest[0], argv, description: flags.description || undefined, cwd: cwd || undefined });
    let saved;
    if (here) saved = store.save(tool);
    else {
      try { saved = await rpc(target.id, M.TOOL_SAVE, tool, 15_000); }
      catch (error) {
        if (error.rpc && /unknown method/i.test(error.message)) throw new Error(`${target.name} runs an older Helm with no tools. Update Helm there first.`);
        throw new Error(`Could not reach ${target.name}: ${error.message}`);
      }
      await gather(target).catch(() => {});
    }
    write(`\n  ${saved.replaced ? 'Changed' : 'Added'} the tool "${tool.name}" on ${target.name}.`);
    if (here && !onPath(argv[0])) write(`  Note: ${argv[0]} is not a program here yet. The tool fails until it is.`);
    write(`  Every agent can run it with: helm tools run ${tool.name} [args]`);
    write(`  Remove it with: helm tools remove ${tool.name}${here ? '' : ` --machine ${target.name}`}\n`);
    return 0;
  }

  if (['remove', 'rm', 'delete'].includes(verb)) {
    const { flags, rest } = takeFlags(words, ['--machine']);
    if (rest.length !== 1) throw new Error('Give one tool name: helm tools remove <name> [--machine <name>].');
    const hit = await find(rest[0], flags.machine);
    if (hit.machine.id === net.self) store.remove(hit.tool.name);
    else {
      if (!hit.online) throw new Error(`${hit.machine.name} is offline. Remove the tool when it is online again.`);
      await rpc(hit.machine.id, M.TOOL_REMOVE, { name: hit.tool.name }, 15_000);
      await gather(hit.machine).catch(() => {});
    }
    write(`\n  Removed the tool "${hit.tool.name}" from ${hit.machine.name}.`);
    write(`  Add it again with: helm tools add ${hit.tool.name}${hit.machine.id === net.self ? '' : ` --machine ${hit.machine.name}`}${hit.tool.description ? ` --description ${shellWord(hit.tool.description)}` : ''} -- ${hit.tool.argv.map(shellWord).join(' ')}\n`);
    return 0;
  }

  if (verb === 'run') {
    // Options for helm come before the name. Every word after it goes to the tool.
    const { flags, rest } = takeFlags(words, ['--machine', '--timeout'], { stopAtWord: true });
    const [name, ...extra] = rest;
    if (extra[0] === '--') extra.shift();
    const timeout = flags.timeout ? Number(flags.timeout) : WORK_TIMEOUT_MS;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 24 * 60 * 60_000) throw new Error('--timeout is milliseconds, from 1 to 86400000.');
    const hit = await find(name, flags.machine);
    if (!hit.online) throw new Error(`${hit.machine.name} is offline, so "${name}" cannot run now. Try again when it is online.`);
    const argv = [...hit.tool.argv, ...extra];
    // On this machine the tool runs like helm run: it keeps this shell's
    // settings and reads its input as it comes.
    if (hit.machine.id === net.self) {
      return runLocal([...(hit.tool.cwd ? ['--cwd', hit.tool.cwd] : []), '--timeout', String(timeout), '--', ...argv]);
    }
    const stdin = await input();
    return runRemote({ machine: hit.machine.name, machineId: hit.machine.id, argv, ...(hit.tool.cwd ? { cwd: hit.tool.cwd } : {}),
      heavy: false, timeout, env: {}, ...(stdin ? { stdin } : {}) });
  }

  throw new Error(TOOLS_USAGE);
}
