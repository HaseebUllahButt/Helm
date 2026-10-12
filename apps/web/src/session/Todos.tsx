import { useEffect, useRef, useState } from 'react';
import type { Item, Turn } from './types';

/**
 * The agent's to-do list as a checklist that ticks itself off, the way the
 * CLI shows it. Claude writes it with TodoWrite (the whole list every time);
 * the ACP CLIs send a "plan" whose output is one marked line per step.
 */
export type TodoState = 'pending' | 'in_progress' | 'completed';
/** `text` is what the row says; `id` is the step itself, which stays put when the wording turns to "-ing". */
export interface Todo { id: string; text: string; state: TodoState }

export const isTodoItem = (it: Item) => it.kind === 'tool' && (it.name === 'TodoWrite' || it.name === 'plan');

const STATES: Record<string, TodoState> = { '☑': 'completed', '▸': 'in_progress', '☐': 'pending' };

/** The list this item holds, or null while it is still arriving or unreadable. */
export function parseTodos(it: Item): Todo[] | null {
  if (it.name === 'plan') {
    const rows: Todo[] = [];
    for (const line of (it.output ?? '').split('\n')) {
      const state = STATES[line[0]];
      if (state && line.slice(1).trim()) rows.push({ id: line.slice(1).trim(), text: line.slice(1).trim(), state });
    }
    return rows.length ? rows : null;
  }
  let input = it.input;
  if (!input && it.inputJson) {
    try { input = JSON.parse(it.inputJson); } catch { return null; }
  }
  if (!Array.isArray(input?.todos)) return null;
  const rows: Todo[] = [];
  for (const t of input.todos) {
    const state: TodoState = t?.status === 'completed' || t?.status === 'in_progress' ? t.status : 'pending';
    // The "-ing" wording reads better on the row being worked on.
    const id = String(t?.content || t?.activeForm || '').trim();
    const text = String((state === 'in_progress' && t?.activeForm) || id).trim();
    if (id) rows.push({ id, text, state });
  }
  return rows.length ? rows : null;
}

/** Only the newest list is shown; an earlier one is the same list, older. */
export function latestTodoId(items: Item[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (isTodoItem(items[i]) && parseTodos(items[i])) return items[i].id;
  }
  return undefined;
}

const keyOf = (todos: Todo[]) => {
  const seen = new Map<string, number>();
  // The same words twice get their own keys, so ticking one ticks one.
  return todos.map((t) => { const n = seen.get(t.id) ?? 0; seen.set(t.id, n + 1); return `${t.id}\u0000${n}`; });
};

export function TodoCard({ item }: { item: Item }) {
  const todos = parseTodos(item) ?? [];
  const keys = keyOf(todos);
  // What each row was last time, so a row that just became done can tick in.
  // Nothing animates on the first paint: opening a chat is not news.
  const before = useRef<Map<string, TodoState> | null>(null);
  const prev = before.current;
  useEffect(() => { before.current = new Map(keys.map((k, i) => [k, todos[i].state])); });
  if (!todos.length) return null;
  const done = todos.filter((t) => t.state === 'completed').length;
  return (
    <div className="todos" role="group" aria-label="To-do list">
      <div className="todos-head">
        <span className="todos-title">To-do</span>
        <span className="todos-count">{done} of {todos.length} done</span>
      </div>
      <div className="todos-bar" role="progressbar" aria-valuemin={0} aria-valuemax={todos.length} aria-valuenow={done}>
        <i style={{ width: `${(done / todos.length) * 100}%` }} />
      </div>
      <ul className="todos-list">
        {todos.map((t, i) => {
          const was = prev?.get(keys[i]);
          const ticked = t.state === 'completed' && !!was && was !== 'completed';
          return (
            <li key={keys[i]} className={`todo ${t.state}${ticked ? ' ticked' : ''}`} aria-current={t.state === 'in_progress' ? 'step' : undefined}>
              <span className="todo-box" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
              </span>
              <span className="todo-text">{t.text}</span>
              <span className="todo-sr">{t.state === 'completed' ? ' (done)' : t.state === 'in_progress' ? ' (in progress)' : ''}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The list the composer's task strip shows: the newest one in the latest
 * turn. Nothing once that turn is over and everything is ticked, and nothing
 * once a newer message has started (it becomes the latest turn, with none).
 * Steps a child agent wrote belong to that agent's card, not to this chat.
 */
export function stripTodos(turns: Turn[]): Todo[] | null {
  const turn = turns.at(-1);
  if (!turn) return null;
  const items = turn.items.filter((it) => !it.parentId);
  const id = latestTodoId(items);
  const todos = id ? parseTodos(items.find((it) => it.id === id)!) : null;
  if (!todos) return null;
  if (turn.done && todos.every((t) => t.state === 'completed')) return null;
  return todos;
}

/** The step being worked on; failing that the next one waiting. */
const currentOf = (todos: Todo[]) => todos.find((t) => t.state === 'in_progress') ?? todos.find((t) => t.state === 'pending');

/**
 * "Tasks · Writing the fix · 2/5": a tab tucked behind the top edge of the
 * composer. Tap it to open the whole checklist.
 */
export function TodoStrip({ todos }: { todos: Todo[] }) {
  const [open, setOpen] = useState(false);
  const keys = keyOf(todos);
  const done = todos.filter((t) => t.state === 'completed').length;
  const current = currentOf(todos);
  return (
    <div className={`todo-strip${open ? ' open' : ''}`} role="group" aria-label="Tasks">
      <button className="todo-strip-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="todo-strip-label">Tasks</span>
        <span className="todo-strip-now">{current ? current.text : 'All done'}</span>
        <span className="todo-strip-count">{done}/{todos.length}</span>
        <svg className="todo-strip-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg>
      </button>
      <div className="todo-segs" role="progressbar" aria-label="Tasks done" aria-valuemin={0} aria-valuemax={todos.length} aria-valuenow={done}>
        {todos.map((t, i) => <i key={keys[i]} className={t.state} />)}
      </div>
      {open && (
        <ul className="todo-strip-list">
          {todos.map((t, i) => (
            <li key={keys[i]} className={`todo ${t.state}`} aria-current={t.state === 'in_progress' ? 'step' : undefined}>
              <span className="todo-box" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
              </span>
              <span className="todo-text">{t.text}</span>
              <span className="todo-sr">{t.state === 'completed' ? ' (done)' : t.state === 'in_progress' ? ' (in progress)' : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
