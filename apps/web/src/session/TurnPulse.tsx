import { createContext, useContext } from 'react';
import { useNow } from '../useNow';
import type { Item, Turn } from './types';
import { seconds } from '../format';
import { changeStats, changesOf, baseName, rawCommand } from './stepWords';
import { openInCanvas } from './Canvas';

/** Lets the changed-files card ask the transcript to open and show one step. */
export const Reveal = createContext<(id: string) => void>(() => {});

/** "Working for 42s": the one calm line that says the agent is busy. Its clock is the only thing that moves. */
export function WorkingLine({ turn, blocked = false }: { turn: Turn; blocked?: boolean }) {
  const now = useNow(1000);
  if (blocked) return <div className="working quiet">Waiting for you</div>;
  const start = Number.isFinite(turn.at) ? turn.at : turn.items[0]?.startedAt;
  const elapsed = start ? Math.max(0, Math.floor((now - start) / 1000)) : 0;
  return (
    <div className="working">
      <span className="pulse-dot" aria-hidden="true" />
      {start
        ? <span className="working-for">Working for <span className="working-time">{elapsed < 1 ? '0s' : seconds(elapsed * 1000)}</span></span>
        : <span className="working-for">Working</span>}
    </div>
  );
}

const TEST_RUN = /\b((npm|pnpm|yarn|bun)\s+(run\s+)?test|vitest|jest|pytest|go\s+test|cargo\s+test|node\s+(\S+\s+)*--test|mocha|playwright\s+test)\b/;

/** The last test run decides: an early failure that was then fixed is not news. */
export function testResult(items: Item[]): 'passed' | 'failed' | null {
  // A Codex command has an exit code; a Claude Bash call only says whether it failed.
  const ended = (it: Item) => (it.kind === 'command' ? it.exitCode != null : it.status === 'ok' || it.status === 'error');
  const last = items.filter((it) => { const c = rawCommand(it); return !!c && TEST_RUN.test(c) && ended(it); }).at(-1);
  if (!last) return null;
  return (last.kind === 'command' ? last.exitCode === 0 : last.status === 'ok') ? 'passed' : 'failed';
}

export interface FileChange { path: string; itemId: string; add: number; del: number }

/** Each distinct file the turn edited: the first step that touched it, and how many lines went in and out. */
export function changedFiles(items: Item[]): FileChange[] {
  const files = new Map<string, FileChange>();
  for (const it of items) {
    for (const c of changesOf(it)) {
      if (!c.path) continue;
      const { add, del } = changeStats([c]);
      const f = files.get(c.path);
      if (f) { f.add += add; f.del += del; } else files.set(c.path, { path: c.path, itemId: it.id, add, del });
    }
  }
  return [...files.values()];
}

const MAX_FILES = 6;

/** Two files called index.ts need their folder to tell them apart. */
const nameFor = (f: FileChange, all: FileChange[]) => {
  const name = baseName(f.path);
  if (all.filter((o) => baseName(o.path) === name).length < 2) return name;
  return f.path.split('/').slice(-2).join('/');
};

const Counts = ({ add, del }: { add: number; del: number }) => (
  <span className="tf-counts"><i className="add">+{add}</i> <i className="del">−{del}</i></span>
);

/** "3 changed files +29 −12", each file, and a way to open the diff. */
export function ChangedFiles({ files }: { files: FileChange[] }) {
  const reveal = useContext(Reveal);
  if (!files.length) return null;
  const add = files.reduce((n, f) => n + f.add, 0);
  const del = files.reduce((n, f) => n + f.del, 0);
  return (
    <div className="tf" role="group" aria-label="Changed files">
      <div className="tf-head">
        <span className="tf-title">{files.length} changed {files.length === 1 ? 'file' : 'files'}</span>
        <Counts add={add} del={del} />
        <button type="button" className="tf-open" onClick={() => reveal(files[0].itemId)}>Show changes</button>
      </div>
      <ul className="tf-list">
        {files.slice(0, MAX_FILES).map((f) => (
          <li key={f.path} title={f.path}>
            <button type="button" className="tf-name" title={`Open ${f.path} in the canvas`} onClick={() => openInCanvas(f.path)}>{nameFor(f, files)}</button>
            <Counts add={f.add} del={f.del} />
          </li>
        ))}
        {files.length > MAX_FILES && <li className="tf-more">+{files.length - MAX_FILES} more</li>}
      </ul>
    </div>
  );
}
