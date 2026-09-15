import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expand } from './paths.js';
import { ENGINES } from './engines.js';

/**
 * What you can type after a `/`.
 *
 * Deliberately **not** the CLI's built-ins. `/help` and `/status` through
 * `claude -p` come back `ok` in about 95ms having printed nothing: they are
 * TUI-local and do nothing headless. Offering them would be a palette of
 * things that quietly fail, which is worse than no palette.
 *
 * What is real is two kinds of thing:
 *
 *   - helm's own actions, handled by the daemon before the text ever
 *     reaches a CLI (`sessions.js #slash`);
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
  { name: 'usage', description: 'What this session has cost, and today\'s plan usage', source: 'helm' },
];

/** Where each engine reads the owner's own commands from. */
function directories(engine, cwd, home) {
  const root = expand(home ?? ENGINES[engine]?.defaultHome ?? '~');
  switch (engine) {
    case 'claude':
      // Project commands beat personal ones of the same name, which is the
      // order Claude Code itself resolves them in.
      return [join(expand(cwd), '.claude', 'commands'), join(root, 'commands')];
    case 'codex':
      return [join(root, 'prompts')];
    case 'opencode':
      return [join(root, 'opencode', 'command')];
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

function read(dir, source, prefix = '', depth = 0) {
  let entries;
  try { entries = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    let info;
    try { info = statSync(full); } catch { continue; }
    // One level of nesting, spelled the way the CLIs namespace them.
    if (info.isDirectory() && depth === 0) {
      out.push(...read(full, source, `${prefix}${entry}:`, 1));
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
 * The palette for one session. First definition of a name wins, so helm's
 * own actions cannot be shadowed by a file - they are intercepted before the
 * CLI sees them either way, and a palette entry that lies about where the
 * text goes would be the worst of both.
 */
export function listCommands({ engine, cwd, home }) {
  const seen = new Set();
  const out = [];
  const take = (list) => {
    for (const c of list) {
      if (!c.name || seen.has(c.name)) continue;
      seen.add(c.name);
      out.push(c);
    }
  };
  take(BUILT_IN);
  const dirs = directories(engine, cwd ?? '~', home);
  dirs.forEach((dir, i) => take(read(dir, i === 0 && engine === 'claude' ? 'project' : 'yours')));
  return out;
}
