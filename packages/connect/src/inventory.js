import { readdir, stat, open } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HOME, expand, collapse } from './paths.js';
import { ENGINES } from './engines.js';

/**
 * Sessions that already exist on this machine, whether or not helm started
 * them.
 *
 * The point of the phone is to be a view onto all the work happening across
 * your machines - including the session you started by hand at the keyboard an
 * hour ago. Each CLI keeps its own history in its own format; this reads all of
 * them and presents one list.
 */

const PER_ENGINE = 40;

/**
 * Read the head of a file and hand back its first `wanted` lines.
 *
 * These histories run to megabytes, so we never read one whole. But a single
 * line can still be large - codex writes its entire system prompt into the
 * first record - so we grow the read until we have what we need.
 */
async function headLines(path, wanted = 1, cap = 1 << 20) {
  const fh = await open(path, 'r');
  try {
    let size = 64 << 10;
    let text = '';
    while (true) {
      const { buffer, bytesRead } = await fh.read(Buffer.alloc(size), 0, size, 0);
      text = buffer.subarray(0, bytesRead).toString('utf8');
      const lines = text.split('\n');
      // The final fragment is only complete if we stopped on a newline.
      if (lines.length > wanted || bytesRead < size || size >= cap) {
        return lines.slice(0, Math.max(wanted, lines.length - 1));
      }
      size = Math.min(size * 4, cap);
    }
  } finally {
    await fh.close();
  }
}

const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };

/** Newest files first, capped - we never want to stat an entire history. */
async function newest(dir, filter, limit) {
  const out = [];
  const walk = async (d, depth = 0) => {
    if (depth > 5) return;
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (filter(e.name)) {
        try { out.push({ path: full, mtime: (await stat(full)).mtimeMs }); } catch { /* vanished */ }
      }
    }
  };
  await walk(dir);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

// -------------------------------------------------------------------- codex

async function codex(home, account) {
  const root = join(expand(home), 'sessions');
  if (!existsSync(root)) return [];

  // The index carries human titles; the rollouts carry the working directory.
  const titles = new Map();
  const indexFile = join(expand(home), 'session_index.jsonl');
  if (existsSync(indexFile)) {
    try {
      const fh = await open(indexFile, 'r');
      const text = await fh.readFile('utf8');
      await fh.close();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line);
          if (r.id) titles.set(r.id, r.thread_name);
        } catch { /* partial write at the tail */ }
      }
    } catch { /* index is a nicety, not a requirement */ }
  }

  const files = await newest(root, (n) => n.endsWith('.jsonl'), PER_ENGINE);
  const out = [];
  for (const f of files) {
    try {
      const meta = parse((await headLines(f.path, 1))[0]);
      if (meta?.type !== 'session_meta') continue;
      const p = meta.payload ?? {};
      out.push({
        engine: 'codex',
        account,
        id: p.session_id ?? p.id,
        title: titles.get(p.session_id) || basename(p.cwd ?? '') || 'codex session',
        cwd: collapse(p.cwd ?? HOME),
        updatedAt: f.mtime,
      });
    } catch { /* not a rollout we understand */ }
  }
  return out;
}

// ------------------------------------------------------------------- claude

async function claude(home, account) {
  const root = join(expand(home), 'projects');
  if (!existsSync(root)) return [];

  const files = await newest(root, (n) => n.endsWith('.jsonl'), PER_ENGINE * 2);
  const out = [];
  for (const f of files) {
    let cwd = null;
    let title = '';
    let sidechain = false;

    // Claude records the working directory and the opening message on the
    // first real turn; the leading lines are session bookkeeping.
    for (const line of await headLines(f.path, 24)) {
      const r = parse(line);
      if (!r) continue;
      if (r.summary) title ||= String(r.summary);
      if (r.type !== 'user') continue;
      if (r.isSidechain) { sidechain = true; break; }
      cwd ??= r.cwd;
      const content = r.message?.content;
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.find((c) => c?.type === 'text')?.text ?? ''
          : '';
      if (text && !text.startsWith('<')) { title ||= text.trim(); break; }
    }
    // A sidechain file is a subagent's transcript, not a session you resume.
    if (sidechain || !cwd) continue;

    out.push({
      engine: 'claude',
      account,
      id: basename(f.path, '.jsonl'),
      title: title.replace(/\s+/g, ' ').slice(0, 90) || basename(cwd),
      cwd: collapse(cwd),
      updatedAt: f.mtime,
    });
    if (out.length >= PER_ENGINE) break;
  }
  return out;
}

// ----------------------------------------------------------------- opencode

function opencode(home, account) {
  // opencode keeps a real database, so this is the one engine where we get
  // titles, cost and model without parsing anything.
  const base = process.env.XDG_DATA_HOME || join(HOME, '.local', 'share');
  const candidates = [];
  try {
    for (const d of readdirSync(base)) {
      if (d.startsWith('opencode')) candidates.push(join(base, d, 'opencode.db'));
    }
  } catch { /* no XDG data dir here */ }

  const out = [];
  for (const db of candidates) {
    if (!existsSync(db)) continue;
    try {
      const conn = new DatabaseSync(db, { readOnly: true });
      const rows = conn.prepare(
        `SELECT id, title, directory, time_updated, agent, model
           FROM session ORDER BY time_updated DESC LIMIT ?`
      ).all(PER_ENGINE);
      for (const r of rows) {
        out.push({
          engine: 'opencode',
          account: `${account}:${basename(join(db, '..'))}`,
          id: r.id,
          title: r.title || 'opencode session',
          cwd: collapse(r.directory ?? HOME),
          updatedAt: Number(r.time_updated) || 0,
          model: r.model,
        });
      }
      conn.close();
    } catch { /* a locked or half-migrated db is not worth failing over */ }
  }
  return out;
}

// ---------------------------------------------------------------- public API

/**
 * Every past session this machine knows about, newest first.
 * @param {Array} profiles  so we scan each configured account, not just the default
 */
export async function inventory(profiles = []) {
  const seen = new Set();
  const jobs = [];

  for (const p of profiles) {
    const engine = ENGINES[p.engine];
    if (!engine || engine.plain) continue;

    const home = p.env?.[engine.homeEnv] ?? engine.defaultHome;
    const key = `${p.engine}:${home}`;
    if (seen.has(key)) continue; // two aliases onto the same account
    seen.add(key);

    if (p.engine === 'codex') jobs.push(codex(home, p.id));
    else if (p.engine === 'claude') jobs.push(claude(home, p.id));
    else if (p.engine === 'opencode') jobs.push(Promise.resolve(opencode(home, p.id)));
  }

  const all = (await Promise.all(jobs)).flat();
  return all
    .filter((s) => s.id)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
