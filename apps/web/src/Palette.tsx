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
  group: 'thread' | 'machine' | 'action';
  title: string;
  sub?: string;
  /** An engine, for a thread: its mark is drawn exactly as everywhere else. */
  engine?: string;
  /** Words that find it without being shown. */
  keywords?: string;
  /** Newest first when there is nothing typed. */
  at?: number;
  run: () => void;
}

const GROUP = { thread: 'Threads', machine: 'Machines', action: 'Actions' } as const;

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

export function Palette({ items, onClose, engineOf }: {
  items: PaletteItem[]; onClose: () => void; engineOf: (id?: string) => { cls: string };
}) {
  const dialog = useDialog(onClose);
  const listId = useId();
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => {
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
      .slice(0, 40)
      .map((x) => x.item);
  }, [items, q]);

  const selected = Math.max(0, Math.min(at, shown.length - 1));
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, shown]);

  const go = (item?: PaletteItem) => { if (!item) return; onClose(); item.run(); };

  return (
    <div className="modal-back palette-back" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette-box" role="dialog" aria-modal="true" aria-label="Command palette" ref={dialog} tabIndex={-1}>
        <div className="palette-heading"><span>Go anywhere</span><button className="iconbtn" onClick={onClose} aria-label="Close command palette" title="Close"><Icon name="close" size={16} /></button></div>
        <input
          className="palette-input" value={q} placeholder="Search threads, machines, actions"
          autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
          role="combobox" aria-label="Search threads, machines, actions"
          aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={shown.length ? `${listId}-${selected}` : undefined}
          onChange={(e) => { setQ(e.target.value); setAt(0); }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setAt(shown.length ? (selected + 1) % shown.length : 0); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setAt(shown.length ? (selected + shown.length - 1) % shown.length : 0); }
            else if (e.key === 'Enter') { e.preventDefault(); go(shown[selected]); }
          }}
        />
        <div className="palette-list" ref={list} role="listbox" id={listId} aria-label="Search results">
          {shown.length === 0 && <div className="empty quiet">No matches. Try a machine, folder, or thread name.</div>}
          {shown.map((item, i) => {
            const head = i === 0 || shown[i - 1].group !== item.group;
            return (
              <div key={item.id}>
                {head && <div className="palette-group">{GROUP[item.group]}</div>}
                <button
                  role="option" id={`${listId}-${i}`} tabIndex={-1} aria-selected={i === selected} className={`palette-row${i === selected ? ' on' : ''}`}
                  onMouseMove={() => setAt(i)} onClick={() => go(item)}
                >
                  {item.engine ? <EngineMark engine={engineOf(item.engine).cls} /> : <span className={`pglyph ${item.group}`}><Icon name={item.group === 'machine' ? 'machine' : 'forward'} size={15} /></span>}
                  <span className="grow">
                    <span className="palette-title">{item.title}</span>
                    {item.sub && <span className="palette-sub">{item.sub}</span>}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></div>
      </div>
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ['Ctrl/⌘ K', 'Command palette'],
  ['/', 'Search threads'],
  ['Ctrl/⌘ [', 'Back'],
  ['Ctrl/⌘ ]', 'Forward'],
  ['Enter', 'Send a message'],
  ['Shift Enter', 'New line in a message'],
  ['↑ ↓', 'Earlier messages, in the box'],
  ['Ctrl Shift Space', 'Dictate a message'],
  ['?', 'This list'],
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
          {SHORTCUTS.map(([keys, what]) => (
            <div key={keys}><kbd>{keys}</kbd><span>{what}</span></div>
          ))}
        </div>
      </div>
    </div>
  );
}
