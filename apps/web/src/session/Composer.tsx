import { useEffect, useRef, useState } from 'react';
import { IMAGE_ACCEPT, looksLikeImage } from './image';

export const QUICK: { label: string; key: string }[] = [
  { label: 'yes', key: 'y' }, { label: 'no', key: 'n' },
  { label: 'enter', key: 'Enter' }, { label: 'esc', key: 'Escape' },
  { label: '↑', key: 'Up' }, { label: '↓', key: 'Down' },
  { label: 'tab', key: 'Tab' }, { label: '^C', key: 'C-c' },
];

/**
 * Where you type. `keys` (the raw-key strip) only makes sense for a
 * terminal-backed session; a headless agent takes messages, and an
 * interrupt, instead.
 */
export function Composer({ draft, setDraft, onSend, onKey, onStop, waiting, working, engine, keys: withKeys = true, foot, danger, children, onAttach, attachments, onRemoveAttachment, canAttach = true, preparing = false, onAttachUnsupported, commands }: {
  draft: string; setDraft: (v: string) => void; onSend: () => void;
  onKey?: (k: string) => void; onStop?: () => void;
  waiting?: boolean; working?: boolean; engine: string; keys?: boolean;
  foot?: React.ReactNode; danger?: boolean;
  children?: React.ReactNode;
  onAttach?: (files: FileList) => void;
  attachments?: { name: string; url: string }[];
  onRemoveAttachment?: (i: number) => void;
  /** False when the running model cannot see images: no clip, no paste. */
  canAttach?: boolean;
  /** True while selected images are being compressed in the browser. */
  preparing?: boolean;
  /** Called when images arrive but this agent cannot see them. */
  onAttachUnsupported?: () => void;
  /** What `/` offers here: helm's own actions plus the owner's own commands. */
  commands?: { name: string; description?: string; source?: string }[];
}) {
  const [keys, setKeys] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [pick, setPick] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  /**
   * The palette opens while the whole message is still just a command being
   * typed - `/re`, not `/review the thing`. Once there is an argument you
   * have chosen your command, and a list covering the composer is in the way.
   */
  const typing = /^\/(\S*)$/.exec(draft);
  const matches = (!dismissed && typing && commands?.length)
    ? commands.filter((c) => c.name.toLowerCase().startsWith(typing[1].toLowerCase())).slice(0, 8)
    : [];
  const open = matches.length > 0;
  const chosen = matches[Math.min(pick, matches.length - 1)];
  const complete = (name: string) => {
    setDraft(`/${name} `);
    setDismissed(true);
    ref.current?.focus();
  };

  // A fresh set of matches starts at the top, and a cleared draft re-arms
  // the palette for the next `/`.
  useEffect(() => { setPick(0); }, [draft]);
  useEffect(() => { if (!draft.startsWith('/')) setDismissed(false); }, [draft]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /**
   * Images arriving by paste or drop. Both routes land here so they cannot
   * drift apart, and both say something when the agent cannot take images -
   * a screenshot pasted into a session that silently ignores it is the
   * worst version of this feature.
   */
  const take = (list: FileList | File[] | undefined | null) => {
    const images = Array.from(list ?? []).filter(looksLikeImage);
    if (!images.length) return false;
    if (!canAttach || !onAttach) { onAttachUnsupported?.(); return true; }
    const dt = new DataTransfer();
    images.forEach((f) => dt.items.add(f));
    onAttach(dt.files);
    return true;
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  }, [draft]);

  return (
    <div className="composer-wrap">
      <div className="composer-col">
        {children}
        {waiting && withKeys && onKey && (
          <div className="docked warn">
            <span className="docked-text"><i className="sdot blocked" />Waiting on you</span>
            <span className="docked-actions">
              {QUICK.slice(0, 4).map((q) => <button key={q.key} onClick={() => onKey(q.key)}>{q.label}</button>)}
            </span>
          </div>
        )}
        <div
          className={`slab${danger ? ' danger' : ''}${dragging ? ' dropping' : ''}`}
          onDragOver={(e) => { if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) { e.preventDefault(); setDragging(true); } }}
          onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
          onDrop={(e) => { setDragging(false); if (take(e.dataTransfer?.files)) e.preventDefault(); }}
        >
          {open && (
            <div className="palette" role="listbox">
              {matches.map((c, i) => (
                <button
                  key={c.name}
                  role="option"
                  aria-selected={c === chosen}
                  className={c === chosen ? 'on' : ''}
                  onMouseEnter={() => setPick(i)}
                  onClick={() => complete(c.name)}
                >
                  <span className="pname">/{c.name}</span>
                  {c.description && <span className="pdesc">{c.description}</span>}
                  <span className="psrc">{c.source}</span>
                </button>
              ))}
            </div>
          )}
          {attachments && attachments.length > 0 && (
            <div className="attach-previews">
              {attachments.map((a, i) => (
                <span key={i} className="attach-preview" title={a.name}>
                  <img src={a.url} alt={a.name} />
                  <button onClick={() => onRemoveAttachment?.(i)} title={`remove ${a.name}`} aria-label={`remove ${a.name}`}>×</button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={ref} rows={1} value={draft}
            placeholder={waiting ? 'Reply to the agent…' : `Message ${engine}…`}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => { if (take(e.clipboardData?.files)) e.preventDefault(); }}
            onKeyDown={(e) => {
              if (open) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setPick((p) => (p + 1) % matches.length); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); setPick((p) => (p - 1 + matches.length) % matches.length); return; }
                if (e.key === 'Escape') { e.preventDefault(); setDismissed(true); return; }
                // Tab and Enter both complete rather than send: the message
                // is still only the command's name, so sending it now would
                // be sending a half-typed one.
                if (e.key === 'Tab' || e.key === 'Enter') {
                  e.preventDefault();
                  if (chosen) complete(chosen.name);
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
            }}
          />
          {foot && <div className="slab-controls">{foot}</div>}
          <div className="slab-foot">
            {onAttach && canAttach && (
              <>
                <input ref={fileRef} type="file" accept={IMAGE_ACCEPT} multiple style={{ display: 'none' }} onChange={(e) => { if (e.target.files?.length) onAttach(e.target.files); e.target.value = ''; }} />
                <button className="ctl" onClick={() => fileRef.current?.click()} title="attach image">📎</button>
              </>
            )}
            {withKeys && onKey && <button className={`ctl${keys ? ' on' : ''}`} onClick={() => setKeys((v) => !v)}>⌨ keys</button>}
            {preparing && <span className="attach-status">compressing…</span>}
            <span className="spacer" />
            {working && onStop && (
              <button className="stop" onClick={onStop} title="stop the agent">
                <svg width="12" height="12" viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" rx="2" fill="currentColor" /></svg>
              </button>
            )}
            <button className="send" onClick={onSend} disabled={preparing || (!draft.trim() && !attachments?.length)} title="send">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </div>
          {keys && withKeys && onKey && (
            <div className="keys">
              {QUICK.map((q) => <button key={q.key} onClick={() => onKey(q.key)}>{q.label}</button>)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
