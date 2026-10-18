#!/usr/bin/env node
// Keeps the docs from growing back into a pile nobody reads.
//
//   node scripts/check-docs.mjs
//
// Fails when a doc is over its word budget, a Markdown file appears outside
// the places docs live (reports, plans and notes do not belong in the repo),
// a link points at a missing file, a code path in backticks no longer exists,
// or a HANDOFF note is longer than 8 lines. Budgets are generous on purpose:
// hitting one means rewrite or cut, not raise the number.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter((f) => f && existsSync(path.join(root, f)));

// Where docs may live, and how long each may get (words).
const BUDGETS = [
  [/^README\.md$/, 3500],
  [/^AGENTS\.md$/, 1300],
  [/^HANDOFF\.md$/, 800],
  [/^SETUP\.md$/, 1000],
  [/^CLAUDE\.md$/, 50],
  [/^docs\/[^/]+\.md$/, 800],
  [/^docs\/features\/[^/]+\.md$/, 800],
  [/^\.agents\/skills\/[^/]+\/SKILL\.md$/, 900],
];

const problems = [];
const words = (text) => text.split(/\s+/).filter(Boolean).length;
const exists = (f) => ['', '.js', '.mjs', '.ts', '.tsx', '.test.mjs'].some((ext) => existsSync(f + ext));

for (const file of files) {
  const budget = BUDGETS.find(([re]) => re.test(file))?.[1];
  if (budget == null) { problems.push(`${file}: docs live in README, AGENTS, HANDOFF, SETUP, docs/ or a skill. Put the reason in a code comment or the commit message instead.`); continue }
  const text = readFileSync(path.join(root, file), 'utf8');
  const n = words(text);
  if (n > budget) problems.push(`${file}: ${n} words, budget ${budget}. Cut or rewrite; do not raise the budget.`);

  const dir = path.dirname(path.join(root, file));
  for (const [, target] of text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
    if (/^[a-z]+:/i.test(target)) continue;
    if (!existsSync(path.resolve(dir, target))) problems.push(`${file}: link to missing ${target}`);
  }
  // A path in backticks that is gone means the doc describes code that moved.
  for (const [, ref] of text.matchAll(/`((?:apps|packages|scripts|test)\/[\w./-]+)`/g)) {
    const clean = ref.replace(/[.,:]+$/, '');
    if (!exists(path.join(root, clean))) problems.push(`${file}: names \`${clean}\`, which no longer exists`);
  }
}

// HANDOFF notes are bullets under "## Open"; each stays short.
if (existsSync(path.join(root, 'HANDOFF.md'))) {
  let note = null;
  const flush = () => { if (note && note.lines > 8) problems.push(`HANDOFF.md: the note starting "${note.head}" is ${note.lines} lines; keep notes to 8.`) };
  for (const line of readFileSync(path.join(root, 'HANDOFF.md'), 'utf8').split('\n')) {
    if (/^- /.test(line) || /^#/.test(line) || !line.trim()) { flush(); note = /^- /.test(line) ? { head: line.slice(2, 50), lines: 1 } : null }
    else if (note) note.lines++;
  }
  flush();
}

if (problems.length) {
  console.error(`Docs check: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`Docs check: ${files.length} files OK.`);
