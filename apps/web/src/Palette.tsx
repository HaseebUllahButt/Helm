import { useDialog } from './useDialog';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { EngineMark } from './EngineMark';
import { Icon } from './Icon';

/**
 * One box for everything: threads on every machine, the machines themselves,
 * and the actions that otherwise live three screens deep.
 *
 * It is a keyboard tool - Ctrl/Cmd+K opens it - so it is built for the keys:
 * type to narrow, arrows to move, Enter to go, Escape to leave. It matches
 * words rather than characters: "helm laptop" finds the helm thread on the
 * laptop whichever order they were typed in.
 */

export interface PaletteItem {
  id: string;
  group: 'thread' | 'machine' | 'action' | 'said';
  title: string;
  /** Another item's id this one stands for: a chat found by its words is not shown twice when its title matched too. */
  same?: string;
  sub?: string;
  /** An engine, for a thread: its mark is drawn exactly as everywhere else. */
  engine?: string;
  /** Words that find it without being shown. */
  keywords?: string;
  /** Newest first when there is nothing typed. */
  at?: number;
  run: () => void;
}

export interface PaletteSearchResults {
  items: PaletteItem[];
  failedMachines: string[];
}

const GROUP = { thread: 'Chats', machine: 'Machines', action: 'Actions', said: 'Said in chats' } as const;

/** Typing pauses this long before the machines are asked what was said. */
const SAID_AFTER_MS = 250;
const SAID_MIN_CHARS = 2;

/** 0 for no match; higher is better. Every word must match somewhere. */
function score(item: PaletteItem, q: string): number {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const title = item.title.toLowerCase();
  const rest = `${item.sub ?? ''} ${item.keywords ?? ''}`.toLowerCase();
  let total = 0;
  for (const w of words) {
    if (title.startsWith(w)) total += 6;
    else if (title.split(/[\s/._-]+/).some((t) => t.startsWith(w))) total += 4;
    else if (title.includes(w)) total += 3;
    else if (rest.includes(w)) total += 2;
    else return 0;
  }
  return total;
}

export function Palette({ items, onClose, engineOf, search, heading = 'Go anywhere', placeholder = 'Search chats, machines, and actions' }: {
  items: PaletteItem[]; onClose: () => void; engineOf: (id?: string) => { cls: string };
  /** Asks the machines which chats said these words; the answers are listed under "Said in chats". */
  search?: (query: string, onResults?: (results: PaletteSearchResults) => void) => Promise<PaletteSearchResults>;
  /** The same box, narrowed to one job (Ctrl+Shift+T: pick a device for a terminal). */
  heading?: string; placeholder?: string;
}) {
  const dialog = useDialog(onClose);
  const listId = useId();
  const [q, setQ] = useState('');
  const [selection, setSelection] = useState<{ id: string | null; at: number }>({ id: null, at: 0 });
  const [showAll, setShowAll] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // What the machines found for the words typed, and whether they are still looking.
  const [said, setSaid] = useState<PaletteSearchResults & { q: string; done: boolean }>({ q: '', items: [], failedMachines: [], done: true });
  const asking = !!search && q.trim().length >= SAID_MIN_CHARS && (said.q !== q.trim() || !said.done);
  const failedMachines = said.q === q.trim() ? said.failedMachines : [];

  useEffect(() => {
    const query = q.trim();
    if (!search || query.length < SAID_MIN_CHARS) return;
    let stale = false;
    setSaid({ q: query, items: [], failedMachines: [], done: false });
    const timer = setTimeout(() => {
      search(query, (found) => { if (!stale) setSaid({ ...found, q: query, done: false }); })
        .then((found) => { if (!stale) setSaid({ ...found, q: query, done: true }); })
        .catch(() => { if (!stale) setSaid({ q: query, items: [], failedMachines: [], done: true }); });
    }, SAID_AFTER_MS);
    return () => { stale = true; clearTimeout(timer); };
  }, [q, search, attempt]);

  const matched = useMemo(() => {
    if (!q.trim()) {
      // Nothing typed: the actions, then the newest threads - what you are
      // most likely to have opened the palette for.
      const actions = items.filter((i) => i.group === 'action');
      const machines = items.filter((i) => i.group === 'machine');
      const threads = items.filter((i) => i.group === 'thread').sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, 8);
      return [...threads, ...machines, ...actions];
    }
    return items
      .map((item) => ({ item, s: score(item, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || (b.item.at ?? 0) - (a.item.at ?? 0))
      .map((x) => x.item);
  }, [items, q]);
  const more = !!q.trim() && !showAll && matched.length > 40;
  const local = useMemo(() => more ? matched.slice(0, 40) : matched, [matched, more]);
  // Chats found by their words come after the title matches, once, newest first.
  const shown = useMemo(() => {
    if (!q.trim() || said.q !== q.trim() || !said.items.length) return local;
    const have = new Set(local.map((item) => item.id));
    return [...local, ...said.items.filter((item) => !item.same || !have.has(item.same))];
  }, [local, said, q]);

  const remembered = shown.findIndex((item) => item.id === selection.id);
  const selected = remembered >= 0 ? remembered : Math.max(0, Math.min(selection.at, shown.length - 1));
  const select = (at: number) => setSelection({ id: shown[at]?.id ?? null, at });
  useEffect(() => {
    const id = shown[selected]?.id ?? null;
    setSelection((current) => current.id === id && current.at === selected ? current : { id, at: selected });
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, shown]);

  const go = (item?: PaletteItem) => { if (!item) return; onClose(); item.run(); };

  return (
    <div className="modal-back palette-back" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette-box" role="dialog" aria-modal="true" aria-label="Search and actions" ref={dialog} tabIndex={-1}>
        <div className="palette-heading"><span>{heading}</span><button className="iconbtn" onClick={onClose} aria-label="Close search and actions" title="Close"><Icon name="close" size={16} /></button></div>
        <input
          ref={input} className="palette-input" value={q} placeholder={placeholder}
          autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
          role="combobox" aria-label={placeholder}
          aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={shown.length ? `${listId}-${selected}` : undefined}
          onChange={(e) => { setQ(e.target.value); setSelection({ id: null, at: 0 }); setShowAll(false); }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); select(shown.length ? (selected + 1) % shown.length : 0); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); select(shown.length ? (selected + shown.length - 1) % shown.length : 0); }
            else if (e.key === 'Enter') { e.preventDefault(); go(shown[selected]); }
          }}
        />
        {failedMachines.length > 0 && <div className="banner" role="status">Helm could not search chats on {failedMachines.join(', ')}.{' '}
          <button className="linkish" onClick={() => { setAttempt((value) => value + 1); input.current?.focus(); }}>Try again</button>
        </div>}
        <div className="palette-list" ref={list} role="listbox" id={listId} aria-label="Search results">
          {shown.length === 0 && (asking
            ? <div className="empty quiet" role="status">Helm is searching your chats.</div>
            : !failedMachines.length && <div className="empty quiet">No matches. Search for a machine, folder, chat name, or chat text.</div>)}
          {shown.map((item, i) => {
            const head = i === 0 || shown[i - 1].group !== item.group;
            return (
              <div key={item.id}>
                {head && <div className="palette-group">{GROUP[item.group]}</div>}
                <button
                  role="option" id={`${listId}-${i}`} tabIndex={-1} aria-selected={i === selected} className={`palette-row${i === selected ? ' on' : ''}`}
                  onMouseMove={() => select(i)} onClick={() => go(item)}
                >
                  {item.engine ? <EngineMark engine={engineOf(item.engine).cls} /> : <span className="pglyph"><Icon name={item.group === 'machine' ? 'machine' : 'forward'} size={15} /></span>}
                  <span className="grow">
                    <span className="palette-title">{item.title}</span>
                    {item.sub && <span className={`palette-sub${item.group === 'said' ? ' said' : ''}`}>{item.sub}</span>}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
        {more && <button className="palette-row" onClick={() => { setShowAll(true); input.current?.focus(); }}>Show more</button>}
      </div>
    </div>
  );
}

const SHORTCUTS: [string, [string, string][]][] = [
  ['Anywhere', [
    ['Ctrl/⌘ K', 'Search and actions'],
    ['/', 'Search chats'],
    ['Ctrl/⌘ N', 'New chat'],
    ['Ctrl/⌘ Shift N', 'Start a chat in the current or last folder'],
    ['Ctrl/⌘ Shift O', 'Start a chat in a browser tab'],
    ['Ctrl Tab', 'Next running chat'],
    ['Ctrl Shift Tab', 'Previous running chat'],
    ['Ctrl/⌘ B', 'Show or hide the sidebar'],
    ['Ctrl/⌘ Alt S', 'Open or close Settled'],
    ['Ctrl/⌘ [', 'Back'],
    ['Ctrl/⌘ ]', 'Forward'],
    ['Ctrl/⌘ Shift S', 'Settings'],
    ['Ctrl/⌘ Shift 4', 'Show usage, limits, and cost (the $ key)'],
    ['Ctrl/⌘ Shift E', 'Open a terminal in the chat folder. Press again to go back.'],
    ['Ctrl/⌘ Shift T', 'Pick a machine for a terminal'],
    ['Ctrl/⌘ Alt T', 'Open a terminal on the selected machine'],
    ['Ctrl/⌘ /', 'Show keyboard shortcuts'],
  ]],
  ['In a terminal (the Helm app window)', [
    ['Ctrl/⌘ T', 'New terminal'],
    ['Ctrl/⌘ W', 'Close this terminal'],
    ['Ctrl Tab', 'Next terminal'],
    ['Ctrl Shift Tab', 'Previous terminal'],
  ]],
  ['In the new-chat box', [
    ['Ctrl/⌘ Enter', 'Sketch, no folder'],
    ['Ctrl/⌘ Shift Enter', 'Create a folder with the typed name'],
    ['→ ←', 'Open or close a folder'],
  ]],
  ['In a chat', [
    ['Enter', 'Send a message'],
    ['Shift Enter', 'Add a line to a message'],
    ['↑ ↓', 'Show earlier messages in the box'],
    ['Ctrl Shift Space', 'Dictate a message'],
    ['Shift Tab', 'Select the next permission mode'],
    ['Ctrl/⌘ Shift Y', 'Select the next thinking level'],
    ['Ctrl/⌘ Shift M', 'Select the next model (favorites first)'],
    ['Ctrl/⌘ Shift A', 'Open or close agents'],
    ['Ctrl/⌘ Shift B', 'Open or close the browser'],
    ['Ctrl/⌘ Shift D', 'Open or close the canvas (notes and documents)'],
    ['↑ ↓ Enter', 'Move and pick in an open list'],
  ]],
];

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const dialog = useDialog(onClose);
  return (
    <div className="modal-back" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" ref={dialog} tabIndex={-1}>
        <div className="modal-head">
          <div className="modal-title">Keyboard shortcuts</div>
          <button className="iconbtn" onClick={onClose} aria-label="Close keyboard shortcuts" title="Close"><Icon name="close" size={16} /></button>
        </div>
        <div className="shortcuts">
          {SHORTCUTS.map(([group, keys]) => (
            <section key={group} aria-label={group}>
              <h3 className="palette-group">{group}</h3>
              {keys.map(([key, what]) => <div key={key}><kbd>{key}</kbd><span>{what}</span></div>)}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
