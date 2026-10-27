import type { Change, Item } from './types';
import { isTodoItem, parseTodos } from './Todos';

/**
 * What a step did, in plain words. "Ran tests", "Read app.ts", "Edited
 * App.tsx" - never a raw shell line. Each step has two readings: the one
 * for while it runs ("Running tests") and the one for when it is over.
 */
export interface Words { now: string; past: string }

export const tryParse = (s?: string) => { if (!s) return undefined; try { return JSON.parse(s); } catch { return undefined; } };

/** The tool's input, parsed - or nothing while it is still arriving. */
export const inputOf = (it: Item): any => it.input && Object.keys(it.input).length ? it.input : tryParse(it.inputJson) ?? it.input;

/** One string field of a tool's input, even while the JSON is still streaming in. */
function field(it: Item, key: string): string {
  const v = inputOf(it)?.[key];
  if (typeof v === 'string') return v;
  const m = it.inputJson?.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`));
  return m ? m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"') : '';
}

export const baseName = (p = '') => p.replace(/\/+$/, '').split('/').pop() || p;
const clip = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const same = (w: string): Words => ({ now: w, past: w });

// Verbs Claude opens a command's description with, in both tenses.
const VERBS: Record<string, [string, string]> = {
  run: ['Running', 'Ran'], list: ['Listing', 'Listed'], check: ['Checking', 'Checked'], install: ['Installing', 'Installed'],
  build: ['Building', 'Built'], test: ['Testing', 'Tested'], search: ['Searching', 'Searched'], find: ['Finding', 'Found'],
  show: ['Showing', 'Showed'], read: ['Reading', 'Read'], print: ['Printing', 'Printed'], count: ['Counting', 'Counted'],
  create: ['Creating', 'Created'], delete: ['Deleting', 'Deleted'], remove: ['Removing', 'Removed'], move: ['Moving', 'Moved'],
  copy: ['Copying', 'Copied'], make: ['Making', 'Made'], start: ['Starting', 'Started'], stop: ['Stopping', 'Stopped'],
  kill: ['Stopping', 'Stopped'], restart: ['Restarting', 'Restarted'], commit: ['Committing', 'Committed'], push: ['Pushing', 'Pushed'],
  pull: ['Pulling', 'Pulled'], fetch: ['Loading', 'Loaded'], clone: ['Copying project', 'Copied project'], verify: ['Verifying', 'Verified'],
  lint: ['Checking code', 'Checked code'], format: ['Formatting', 'Formatted'], compile: ['Compiling', 'Compiled'], inspect: ['Inspecting', 'Inspected'],
  view: ['Viewing', 'Viewed'], open: ['Opening', 'Opened'], get: ['Getting', 'Got'], fix: ['Fixing', 'Fixed'],
  update: ['Updating', 'Updated'], add: ['Adding', 'Added'], write: ['Writing', 'Wrote'], edit: ['Editing', 'Edited'],
  look: ['Looking', 'Looked'], confirm: ['Confirming', 'Confirmed'], validate: ['Validating', 'Validated'], launch: ['Launching', 'Launched'],
  execute: ['Running', 'Ran'], apply: ['Applying', 'Applied'], revert: ['Reverting', 'Reverted'], reset: ['Resetting', 'Reset'],
  stage: ['Staging', 'Staged'], merge: ['Merging', 'Merged'], download: ['Downloading', 'Downloaded'], extract: ['Extracting', 'Extracted'],
  query: ['Searching', 'Searched'], ping: ['Pinging', 'Pinged'], diff: ['Comparing', 'Compared'], compare: ['Comparing', 'Compared'],
  clean: ['Cleaning', 'Cleaned'], rebuild: ['Rebuilding', 'Rebuilt'], rerun: ['Rerunning', 'Reran'], save: ['Saving', 'Saved'],
  generate: ['Generating', 'Generated'], display: ['Showing', 'Showed'], browse: ['Browsing', 'Browsed'], review: ['Reviewing', 'Reviewed'],
  try: ['Trying', 'Tried'], retry: ['Retrying', 'Retried'], wait: ['Waiting', 'Waited'], watch: ['Watching', 'Watched'],
};

/** "Run unit tests" -> running / ran. A description that does not start with a verb we know stays as written. */
function describe(text: string): Words {
  const m = /^([A-Za-z]+)\b([\s\S]*)$/.exec(text.trim());
  const v = m && VERBS[m[1].toLowerCase()];
  if (!m || !v) return same(clip(text.trim()));
  return { now: clip(v[0] + m[2]), past: clip(v[1] + m[2]) };
}

// ---------------------------------------------------------------- commands

/** `bash -lc 'cd x && npm test'` -> `npm test`: the part that says what it does. */
export function plainCommand(cmd = ''): string {
  let c = cmd.trim();
  for (let i = 0; i < 2; i += 1) {
    const w = /^(?:\S*\/)?(?:bash|sh|zsh|fish|dash)\s+(?:-[a-zA-Z]+\s+)*?-[a-zA-Z]*c\s+(['"])([\s\S]*)\1\s*$/.exec(c);
    if (w) c = w[2].trim();
  }
  c = c.replace(/^(?:cd\s+\S+\s*(?:&&|;)\s*)+/, '');
  c = c.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '');
  // Only the first part of a chain or pipe says what it is for.
  return c.split(/\s*(?:&&|\|\||;|\|)\s*/)[0].trim();
}

const unquote = (s = '') => s.replace(/^['"]|['"]$/g, '');
const SUB = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx', 'cargo', 'git', 'go', 'docker', 'make', 'pip', 'pip3', 'brew', 'gh', 'helm', 'deno', 'uv', 'kubectl', 'systemctl']);

/** A shell command, in words: "Read app.ts", "Searched for foo", "Ran npm test". */
export function commandWords(cmd = ''): Words {
  const c = plainCommand(cmd);
  const parts = c.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
  if (!parts.length) return same('Ran a command');
  const prog = baseName(parts[0]);
  const args = parts.slice(1);
  const plain = args.filter((a) => !a.startsWith('-'));
  const target = unquote(plain.at(-1) ?? '');
  switch (prog) {
    case 'ls': case 'tree': case 'dir': case 'exa': case 'eza': {
      const dir = unquote(plain[0] ?? '');
      const name = dir && dir !== '.' ? `${baseName(dir)}/` : 'files';
      return { now: `Listing ${name}`, past: `Listed ${name}` };
    }
    case 'cat': case 'head': case 'tail': case 'less': case 'bat': case 'nl': case 'sed': case 'awk':
      if (target && !/[=*]/.test(target) && (prog !== 'sed' && prog !== 'awk' || args.includes('-n') || prog === 'awk')) return { now: `Reading ${baseName(target)}`, past: `Read ${baseName(target)}` };
      break;
    case 'grep': case 'rg': case 'ag': case 'ack': {
      const q = unquote(plain[0] ?? '');
      if (q) return { now: `Searching for ${clip(q, 40)}`, past: `Searched for ${clip(q, 40)}` };
      break;
    }
    case 'find': case 'fd': return { now: 'Searching for files', past: 'Searched for files' };
    case 'pwd': return { now: 'Checking the folder', past: 'Checked the folder' };
    case 'echo': case 'printf': return same('Printed a message');
    case 'mkdir': return { now: 'Creating a folder', past: 'Created a folder' };
    case 'rm': return { now: 'Removing files', past: 'Removed files' };
    case 'mv': return { now: 'Moving files', past: 'Moved files' };
    case 'cp': return { now: 'Copying files', past: 'Copied files' };
    // A loop or a test is a small script, not a program called "for".
    case 'for': case 'while': case 'until': case 'if': case 'case': case '{': case '(':
      return { now: 'Running a script', past: 'Ran a script' };
    default:
  }
  let name = prog;
  if (SUB.has(prog) && plain[0]) {
    name = `${prog} ${unquote(plain[0])}`;
    if ((plain[0] === 'run' || plain[0] === 'exec') && plain[1]) name += ` ${unquote(plain[1])}`;
  } else if (/^(node|python3?|bun|deno|ruby|php|tsx|ts-node)$/.test(prog) && plain[0] && !/[=]/.test(plain[0])) {
    name = `${prog} ${baseName(unquote(plain[0]))}`;
  }
  name = clip(name, 40);
  return { now: `Running ${name}`, past: `Ran ${name}` };
}

type Action = NonNullable<Item['actions']>[number];

/** Codex tells us what a command does: reading a file, searching, listing. */
function actionWords(actions: Action[]): Words | undefined {
  const known = actions.filter((a) => ['read', 'search', 'listFiles', 'list_files'].includes(a.type));
  if (!known.length || known.length !== actions.length) return undefined;
  const type = known[0].type;
  if (known.some((a) => a.type !== type)) return undefined;
  if (type === 'read') {
    const names = [...new Set(known.map((a) => a.name || baseName(a.path)))].filter(Boolean);
    const one = names.length === 1 ? names[0] : `${names.length} files`;
    return names.length ? { now: `Reading ${one}`, past: `Read ${one}` } : undefined;
  }
  if (type === 'search') {
    const q = known[0].query;
    const where = known[0].path ? ` in ${baseName(known[0].path)}/` : '';
    const what = q ? `for ${clip(q, 40)}${where}` : `files${where}`;
    return { now: `Searching ${what}`, past: `Searched ${what}` };
  }
  const dir = known[0].path ? `${baseName(known[0].path)}/` : 'files';
  return { now: `Listing ${dir}`, past: `Listed ${dir}` };
}

// ------------------------------------------------------------------- edits

const lines = (s = '') => (s ? s.replace(/\n$/, '').split('\n') : []);
const block = (sign: string, s = '') => lines(s).map((l) => sign + l);

/**
 * Claude edits files with plain tool calls (Edit, Write, MultiEdit) that
 * carry the old and new text. Turn that into the same change a Codex edit
 * has, so both show an inline diff and count in "3 changed files".
 */
export function toolChanges(it: Item): Change[] {
  if (it.kind !== 'tool' || !it.name) return [];
  const input = inputOf(it);
  if (!input || typeof input !== 'object') return [];
  const path = input.file_path ?? input.notebook_path;
  if (typeof path !== 'string' || !path) return [];
  switch (it.name) {
    case 'Edit':
      if (typeof input.new_string !== 'string') return [];
      return [{ path, kind: 'update', diff: ['@@', ...block('-', input.old_string), ...block('+', input.new_string)].join('\n') }];
    case 'MultiEdit': {
      if (!Array.isArray(input.edits)) return [];
      const hunks = input.edits.flatMap((e: any) => ['@@', ...block('-', e?.old_string), ...block('+', e?.new_string)]);
      return [{ path, kind: 'update', diff: hunks.join('\n') }];
    }
    case 'Write':
      if (typeof input.content !== 'string') return [];
      return [{ path, kind: 'add', diff: ['@@', ...block('+', input.content)].join('\n') }];
    case 'NotebookEdit':
      if (typeof input.new_source !== 'string') return [];
      return [{ path, kind: 'update', diff: ['@@', ...block('+', input.new_source)].join('\n') }];
    default: return [];
  }
}

/** The changes a step made, whichever engine ran it. */
export const changesOf = (it: Item): Change[] => (it.kind === 'edit' ? it.changes ?? [] : toolChanges(it));

/** Codex sends an added file as its content, not a unified diff. */
export const unifiedDiff = (c: Change) => (/^(---|\+\+\+|@@|diff )/m.test(c.diff) ? c.diff
  : c.diff.split('\n').map((l) => (c.kind === 'delete' ? '-' : '+') + l).join('\n'));

export function diffCounts(diff = '') {
  let add = 0, del = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) add++;
    else if (l.startsWith('-') && !l.startsWith('---')) del++;
  }
  return { add, del };
}

export function changeStats(changes: Change[]) {
  let add = 0, del = 0;
  for (const c of changes) { const n = diffCounts(unifiedDiff(c)); add += n.add; del += n.del; }
  return { add, del };
}

const verbFor = (changes: Change[]) => (changes.every((c) => c.kind === 'add') ? ['Creating', 'Created']
  : changes.every((c) => c.kind === 'delete') ? ['Deleting', 'Deleted'] : ['Editing', 'Edited']);

function editWords(changes: Change[]): Words {
  const names = [...new Set(changes.map((c) => baseName(c.path)))].filter(Boolean);
  const [now, past] = verbFor(changes);
  const what = !names.length ? 'a file' : names.length <= 2 ? names.join(', ') : `${names.length} files`;
  return { now: `${now} ${what}`, past: `${past} ${what}` };
}

// ------------------------------------------------------------------- steps

/** The raw command a step ran, if it ran one. */
export const rawCommand = (it: Item): string | undefined =>
  it.kind === 'command' ? it.command : it.kind === 'tool' && it.name === 'Bash' ? field(it, 'command') || undefined : undefined;

/** The one line the old tool rows showed, from whatever input there is. */
export function toolSummary(item: Item): string {
  const input = inputOf(item);
  if (input && typeof input === 'object') {
    const v = input.command ?? input.file_path ?? input.path ?? input.notebook_path ?? input.pattern ?? input.query ?? input.url
      ?? input.questions?.[0]?.question ?? input.description ?? input.prompt ?? input.plan;
    if (typeof v === 'string') return v.length > 140 ? v.slice(0, 140) + '…' : v;
  }
  const m = item.inputJson?.match(/"(?:command|file_path|path|pattern|query|url|question|description)"\s*:\s*"((?:[^"\\]|\\.)*)/);
  return m ? m[1].slice(0, 140) : '';
}

const host = (u: string) => { try { return new URL(u).host; } catch { return u; } };
const prettyTool = (name = 'tool') => {
  const last = name.startsWith('mcp__') ? name.split('__').pop() ?? name : name;
  return last.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
};

/** "Updated the to-do list (2/5)". */
function todoWords(it: Item): Words {
  const todos = parseTodos(it);
  return same(todos ? `Updated the to-do list (${todos.filter((t) => t.state === 'completed').length}/${todos.length})` : 'Updating the to-do list');
}

/** The bold title a thinking note opens with, if it has one. */
export const thoughtTitle = (text?: string) => /^\s*\*\*([^*\n]{1,80})\*\*/.exec(text ?? '')?.[1].trim() || undefined;

/** A thinking note to read: the bold marks are for the title line, not the eye. */
export const thoughtBody = (text = '') => text.replace(/\*\*([^*\n]+)\*\*/g, '$1');

export function stepWords(it: Item): Words {
  if (it.kind === 'thinking') {
    // Codex heads each thinking note with a bold title, the way its own app shows it.
    const title = thoughtTitle(it.text);
    if (title) return same(title);
    const took = it.doneAt && it.startedAt ? it.doneAt - it.startedAt : 0;
    return { now: 'Thinking', past: took > 1500 ? `Thought for ${Math.round(took / 1000)}s` : 'Thought' };
  }
  if (isTodoItem(it)) return todoWords(it);
  if (it.kind === 'edit') return editWords(it.changes ?? []);
  if (it.kind === 'command') {
    const fromActions = it.actions?.length ? actionWords(it.actions) : undefined;
    return fromActions ?? commandWords(it.command);
  }
  switch (it.name) {
    case 'codexReview': {
      const action = field(it, 'action') || 'this step';
      const status = field(it, 'reviewStatus');
      const result = status === 'approved' ? 'Codex approved'
        : status === 'denied' ? 'Codex denied'
          : status === 'timedOut' ? 'Codex review timed out'
            : status === 'aborted' ? 'Codex review stopped'
              : status === 'warning' ? 'Codex review warning' : 'Codex is reviewing';
      return { now: `Codex is reviewing: ${action}`, past: `${result}: ${action}` };
    }
    case 'Bash': {
      const d = field(it, 'description').trim();
      return d ? describe(d) : commandWords(field(it, 'command'));
    }
    case 'Read': { const f = baseName(field(it, 'file_path')); return f ? { now: `Reading ${f}`, past: `Read ${f}` } : { now: 'Reading a file', past: 'Read a file' }; }
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': {
      const changes = toolChanges(it);
      if (changes.length) return editWords(changes);
      const f = baseName(field(it, 'file_path') || field(it, 'notebook_path'));
      const [now, past] = it.name === 'Write' ? ['Writing', 'Wrote'] : ['Editing', 'Edited'];
      return { now: `${now} ${f || 'a file'}`, past: `${past} ${f || 'a file'}` };
    }
    case 'Grep': { const q = field(it, 'pattern'); return q ? { now: `Searching for ${clip(q, 40)}`, past: `Searched for ${clip(q, 40)}` } : { now: 'Searching', past: 'Searched' }; }
    case 'Glob': { const q = field(it, 'pattern'); return q ? { now: `Looking for ${clip(q, 40)}`, past: `Looked for ${clip(q, 40)}` } : { now: 'Looking for files', past: 'Looked for files' }; }
    case 'LS': { const p = baseName(field(it, 'path')); return { now: `Listing ${p ? p + '/' : 'files'}`, past: `Listed ${p ? p + '/' : 'files'}` }; }
    case 'WebFetch': { const u = field(it, 'url'); return u ? { now: `Loading ${host(u)}`, past: `Loaded ${host(u)}` } : { now: 'Loading a page', past: 'Loaded a page' }; }
    case 'WebSearch': case 'webSearch': { const q = field(it, 'query'); return q ? { now: `Searching the web for ${clip(q, 40)}`, past: `Searched the web for ${clip(q, 40)}` } : { now: 'Searching the web', past: 'Searched the web' }; }
    case 'ToolSearch': return { now: 'Looking for a tool', past: 'Looked for a tool' };
    case 'ExitPlanMode': return { now: 'Writing a plan', past: 'Wrote a plan' };
    case 'AskUserQuestion': return { now: 'Asking a question', past: 'Asked a question' };
    case 'Skill': { const s = field(it, 'skill'); return { now: `Using ${s || 'a skill'}`, past: `Used ${s || 'a skill'}` }; }
    case 'compact': case 'contextCompaction': return { now: 'Summarizing the chat', past: 'Summarized the chat' };
    default: {
      const label = prettyTool(it.name);
      const sum = toolSummary(it);
      const tail = sum ? ` ${clip(sum, 60)}` : '';
      return { now: `Using ${label}${tail}`, past: `Used ${label}${tail}` };
    }
  }
}
