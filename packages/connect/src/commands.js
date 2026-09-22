import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expand } from './paths.js';
import { ENGINES } from './engines.js';

/**
 * What you can type after a `/`.
 *
 * What is real is three kinds of thing:
 *
 *   - helm's own actions, handled by the daemon before the text ever
 *     reaches a CLI (`sessions.js input`);
 *   - commands advertised by the live CLI/ACP session. This matters because
 *     the supported set changes with CLI versions, plugins and skills;
 *   - the commands the owner has written themselves, which do run headless -
 *     markdown files in the directory each CLI reads them from, either
 *     beside the project or in that account's config home.
 *
 * Anything missing is simply absent: a machine with no commands directory is
 * the normal case, not an error.
 */

/** Actions helm performs itself. These work in every engine. */
export const BUILT_IN = [
  { name: 'compact', description: 'Summarise the conversation into a fresh context', source: 'helm' },
];

const DEVIN_BUILT_IN = [
  { name: 'usage', description: 'Show account quota and usage', source: 'devin' },
];

/**
 * Where each engine reads the owner's own commands from. Each entry says
 * how its files look (`skills` marks Devin's one-directory-per-command
 * layout) and whose they are - `project` beats `yours` because it is read
 * first, which is also the order the CLIs themselves resolve a name in.
 */
function directories(engine, cwd, home) {
  const root = expand(home ?? ENGINES[engine]?.defaultHome ?? '~');
  const project = expand(cwd);
  switch (engine) {
    case 'claude':
      return [
        { dir: join(project, '.claude', 'commands'), source: 'project' },
        { dir: join(root, 'commands'), source: 'yours' },
      ];
    case 'codex':
      return [{ dir: join(root, 'prompts'), source: 'yours' }];
    case 'opencode':
      return [{ dir: join(root, 'opencode', 'command'), source: 'yours' }];
    case 'opencode2':
      return [
        { dir: join(project, '.opencode', 'commands'), source: 'project', separator: '/' },
        // V2 still discovers the singular V1 directory for compatibility.
        { dir: join(project, '.opencode', 'command'), source: 'project', separator: '/' },
        { dir: join(root, 'opencode', 'commands'), source: 'yours', separator: '/' },
        { dir: join(root, 'opencode', 'command'), source: 'yours', separator: '/' },
      ];
    case 'devin':
      // Devin's owner commands are skills: a named directory holding a
      // SKILL.md. `home` is devin's XDG_CONFIG_HOME, so the config copy of
      // the skills dir sits under it; ~/.agents is the real home, not XDG.
      return [
        { dir: join(project, '.devin', 'skills'), source: 'project', skills: true },
        { dir: join(project, '.agents', 'skills'), source: 'project', skills: true },
        { dir: join(root, 'devin', 'skills'), source: 'yours', skills: true },
        { dir: expand('~/.agents/skills'), source: 'yours', skills: true },
      ];
    default:
      return [];
  }
}

/** `description:` from the frontmatter, else the first line that says something. */
function summarise(text) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (front) {
    const described = /^description:\s*(.+)$/m.exec(front[1]);
    if (described) return described[1].trim().replace(/^["']|["']$/g, '').slice(0, 140);
  }
  const body = front ? text.slice(front[0].length) : text;
  for (const line of body.split('\n')) {
    const clean = line.replace(/^#+\s*/, '').trim();
    if (clean) return clean.slice(0, 140);
  }
  return '';
}

function read(dir, source, prefix = '', depth = 0, separator = ':') {
  let entries;
  try { entries = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    let info;
    try { info = statSync(full); } catch { continue; }
    // One level of nesting, spelled the way the CLIs namespace them.
    if (info.isDirectory() && depth === 0) {
      out.push(...read(full, source, `${prefix}${entry}${separator}`, 1, separator));
      continue;
    }
    if (!entry.endsWith('.md')) continue;
    let text = '';
    try { text = readFileSync(full, 'utf8'); } catch { continue; }
    out.push({
      name: `${prefix}${entry.slice(0, -3)}`,
      description: summarise(text),
      source,
    });
  }
  return out;
}

/**
 * Devin's skills layout: one directory per command, named for the command,
 * holding a SKILL.md. The palette name is the directory's, not a file's;
 * a directory without a SKILL.md is not a command at all.
 */
function readSkills(dir, source) {
  let entries;
  try { entries = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const entry of entries) {
    let text = '';
    try { text = readFileSync(join(dir, entry, 'SKILL.md'), 'utf8'); } catch { continue; }
    out.push({ name: entry, description: summarise(text), source });
  }
  return out;
}

/**
 * The palette for one session. First definition of a name wins, so helm's
 * own actions cannot be shadowed by a file - they are intercepted before the
 * CLI sees them either way, and a palette entry that lies about where the
 * text goes would be the worst of both.
 */
export function listCommands({ engine, cwd, home, available = [] }) {
  const seen = new Map();
  const out = [];
  const take = (list) => {
    for (const c of list) {
      if (!c.name) continue;
      const existing = seen.get(c.name);
      if (existing) {
        // A file often has the useful description while the CLI only sends
        // a name. Keep the winning source, but enrich an otherwise bare row.
        if (!existing.description && c.description) existing.description = c.description;
        continue;
      }
      seen.set(c.name, c);
      out.push(c);
    }
  };
  take(BUILT_IN);
  if (engine === 'devin') take(DEVIN_BUILT_IN);
  // Codex built-ins are implemented by Helm because app-server does not
  // advertise or expand the TUI's slash commands. They must keep precedence
  // over a prompt file with the same name, just as they do in Codex's TUI.
  if (engine === 'codex') take(available);
  for (const d of directories(engine, cwd ?? '~', home)) {
    take(d.skills ? readSkills(d.dir, d.source) : read(d.dir, d.source, '', 0, d.separator));
  }
  if (engine !== 'codex') take(available);
  return out;
}
