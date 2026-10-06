import { useEffect, useRef, useState } from 'react';
import { IMAGE_ACCEPT, looksLikeImage } from './image';
import { useDictation } from './voice';
import type { Turn } from './types';
import { isBigPaste, stashPaste } from './pasteStore';
import { Icon } from '../Icon';

const fmtSeconds = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** A phone: no hardware keyboard to type into straight away, no Shift+Enter. */
const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

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
export function Composer({ draft, setDraft, onSend, onKey, onStop, waiting, working, engine, keys: withKeys = true, foot, danger, children, onAttach, attachments, onRemoveAttachment, canAttach = true, preparing = false, onAttachUnsupported, commands, history = [], queued = [], onWithdrawQueued, steers = false, queueBusy, onTranscribe, onEditQueued, onRemoveQueued, onMoveQueued, onSendQueued, referenceOptions = [], references = [], onReference, onRemoveReference }: {
  draft: string; setDraft: (v: string) => void; onSend: () => void;
  onKey?: (k: string) => void; onStop?: () => void;
  waiting?: boolean; working?: boolean; engine: string; keys?: boolean;
  foot?: React.ReactNode; danger?: boolean;
  children?: React.ReactNode;
  /** Resolves to how many images were added, so each gets its "[Image #N]". */
  onAttach?: (files: FileList) => void | Promise<number | void>;
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
  /** Earlier prompts, oldest first, for shell-style Up/Down recall. */
  history?: string[];
  /**
   * Messages still in helm's outbox, oldest first: accepted but not yet
   * handed to the agent, so they sit here rather than in the transcript.
   */
  queued?: { turn: Turn; text: string; attachments: number; delivered?: boolean }[];
  /** Pull a queued message back into the draft before the agent sees it. */
  onWithdrawQueued?: (turn: Turn) => void;
  /**
   * The CLI takes a message mid-turn, after the step in flight (Claude,
   * Codex). Others read it only once the reply ends.
   */
  steers?: boolean;
  /** The queued turn id an action is in flight for, so it cannot run twice. */
  queueBusy?: string;
  /**
   * Turn a recording into text on a machine that holds a Groq key. Absent
   * when no machine in the network has one, and then there is no microphone:
   * a button that cannot work should not be drawn.
   */
  onTranscribe?: (audio: string, mime: string) => Promise<string>;
  onEditQueued?: (turn: Turn) => void;
  onRemoveQueued?: (turn: Turn) => void;
  onMoveQueued?: (turn: Turn, direction: -1 | 1) => void;
  onSendQueued?: (turn: Turn) => void;
  referenceOptions?: { id: string; title: string }[];
  references?: { id: string; title: string }[];
  onReference?: (id: string) => void;
  onRemoveReference?: (id: string) => void;
}) {
  const [keys, setKeys] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [pick, setPick] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [referencePick, setReferencePick] = useState(0);
  const referenceMatch = /(?:^|\s)@([^\n@]{0,80})$/.exec(draft);
  const referenceMatches = !dismissed && onReference && referenceMatch && references.length < 3
    ? referenceOptions.filter((item) => !references.some((ref) => ref.id === item.id) && item.title.toLowerCase().includes(referenceMatch[1].toLowerCase())).slice(0, 8) : [];
  const addReference = (id: string) => {
    onReference?.(id);
    setDraft(draft.replace(/@([^\n@]{0,80})$/, ''));
    setReferencePick(0);
    ref.current?.focus();
  };
  useEffect(() => { setReferencePick(0); }, [draft]);
  const historyAt = useRef<number | null>(null);
  const historyDraft = useRef('');
  const paletteRef = useRef<HTMLDivElement>(null);

  /**
   * The palette opens while the whole message is still just a command being
   * typed - `/re`, not `/review the thing`. Once there is an argument you
   * have chosen your command, and a list covering the composer is in the way.
   */
  const typing = /^\/(\S*)$/.exec(draft);
  const matches = (!dismissed && typing && commands?.length)
    ? commands.filter((c) => c.name.toLowerCase().startsWith(typing[1].toLowerCase()))
    : [];
  const open = matches.length > 0;
  const chosen = matches[Math.min(pick, matches.length - 1)];
  const complete = (name: string) => {
    historyAt.current = null;
    setDraft(`/${name} `);
    setDismissed(true);
    ref.current?.focus();
  };

  // A fresh set of matches starts at the top, and a cleared draft re-arms
  // the palette for the next `/`.
  useEffect(() => { setPick(0); }, [draft]);
  useEffect(() => { if (!draft.startsWith('/')) setDismissed(false); }, [draft]);
  // Keep keyboard navigation usable when a CLI exposes dozens (or hundreds)
  // of commands. The list owns its scroll; the page and composer stay put.
  useEffect(() => {
    paletteRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [pick, open]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const draftNow = useRef(draft);
  draftNow.current = draft;

  /**
   * "[Image #N]" goes where the cursor was, the way Claude Code and Codex
   * write it, so "compare [Image #1] with [Image #2]" says which is which.
   * The driver puts the same label before each picture it sends.
   */
  const attach = async (files: FileList) => {
    if (!onAttach) return;
    const el = ref.current;
    const at = el && document.activeElement === el ? el.selectionStart : draftNow.current.length;
    const before = attachments?.length ?? 0;
    const added = await onAttach(files);
    if (!added) return;
    const tokens = Array.from({ length: added }, (_, k) => `[Image #${before + k + 1}]`).join(' ');
    const now = draftNow.current;
    const pre = now.slice(0, Math.min(at, now.length)), post = now.slice(pre.length);
    setDraft(`${pre}${pre && !/\s$/.test(pre) ? ' ' : ''}${tokens}${/^\s/.test(post) ? '' : ' '}${post}`);
  };
  /** Its label leaves with it, and the ones after it move up a number. */
  const removeAttachment = (index: number) => {
    const gone = index + 1;
    setDraft(draftNow.current
      .replace(new RegExp(`\\[Image #${gone}\\] ?`, 'g'), '')
      .replace(/\[Image #(\d+)\]/g, (label, n) => Number(n) > gone ? `[Image #${Number(n) - 1}]` : label));
    onRemoveAttachment?.(index);
  };
  const fileRef = useRef<HTMLInputElement>(null);

  /**
   * Recall prompts without stealing arrow keys from a multi-line draft. Up
   * starts history only on the first line; Down advances only on the last.
   * The text being written before recall is restored after the newest item.
   */
  const recall = (direction: -1 | 1, el: HTMLTextAreaElement) => {
    const items = history.filter((item) => item.trim());
    if (!items.length || el.selectionStart !== el.selectionEnd) return false;
    const caret = el.selectionStart;
    if (direction < 0 && draft.slice(0, caret).includes('\n')) return false;
    if (direction > 0 && draft.slice(caret).includes('\n')) return false;

    let at = historyAt.current;
    let next: string;
    if (direction < 0) {
      if (at == null) {
        historyDraft.current = draft;
        at = items.length - 1;
      } else {
        at = Math.max(0, at - 1);
      }
      next = items[at];
      historyAt.current = at;
    } else {
      if (at == null) return false;
      if (at < items.length - 1) {
        at += 1;
        next = items[at];
        historyAt.current = at;
      } else {
        next = historyDraft.current;
        historyAt.current = null;
      }
    }
    setDraft(next);
    requestAnimationFrame(() => {
      const end = ref.current?.value.length ?? 0;
      ref.current?.focus();
      ref.current?.setSelectionRange(end, end);
    });
    return true;
  };

  const submit = () => {
    historyAt.current = null;
    historyDraft.current = '';
    onSend();
  };

  // Opening a conversation means typing into it. Focus after the composer is
  // mounted as well as marking the field autofocus, so restored chats and
  // browser-history navigation land in the same useful place. Not on a
  // phone: there focus is the keyboard, over the permission sheet you
  // opened the session to answer.
  useEffect(() => {
    if (touch) return;
    const frame = requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, []);

  /**
   * Speaking instead of typing. What comes back is appended to the draft
   * rather than sent: dictation mishears, and a prompt you cannot read before
   * it goes to an agent with edit rights is not a feature. It also means you
   * can say the hard half and type the path.
   */
  const dictation = useDictation({
    transcribe: onTranscribe ?? (async () => ''),
    onText: (text) => {
      setDraft(draftRef.current ? `${draftRef.current.replace(/\s*$/, '')} ${text}` : text);
      ref.current?.focus();
    },
  });
  // The hook's callback is made once; without this it would append to the
  // draft as it was when the microphone was opened, losing anything typed
  // while the words were coming back.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Super+D belongs to the compositor on this desktop (see `helm dictate`),
  // so the in-app shortcut is one a browser actually receives.
  useEffect(() => {
    if (!onTranscribe) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.code === 'Space') { e.preventDefault(); dictation.toggle(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onTranscribe, dictation]);

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
    void attach(dt.files);
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
          {!!referenceMatches.length && <div className="palette" role="listbox" aria-label="Attach thread context">
            {referenceMatches.map((item, index) => <button key={item.id} role="option" aria-selected={index === referencePick} onClick={() => addReference(item.id)} onMouseEnter={() => setReferencePick(index)}><span>@{item.title}</span><small>Attach context</small></button>)}
          </div>}
          {!!references.length && <div className="thread-reference-chips">{references.map((item) => <button key={item.id} onClick={() => onRemoveReference?.(item.id)} aria-label={`Remove context: ${item.title}`}>@{item.title}<span aria-hidden="true"> ×</span></button>)}</div>}
          {open && (
            <div className="palette" role="listbox" ref={paletteRef}>
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
          {queued.length > 0 && (
            <div className="queued-panel">
              <div className="queued-head">
                <b>{queued.length} waiting</b>
              </div>
              {queued.map((item, index) => {
                const label = item.text || (item.attachments === 1 ? 'Image' : `${item.attachments} images`);
                const name = label.length > 80 ? `${label.slice(0, 79)}…` : label;
                const busy = queueBusy === item.turn.id;
                return (
                  <div className="queued-row" key={item.turn.id}>
                    <span className="queued-text">
                      {label}
                      {!!item.text && item.attachments > 0 && (
                        <span className="queued-attachments">{item.attachments === 1 ? ' + image' : ` + ${item.attachments} images`}</span>
                      )}
                    </span>
                    {/* Once the CLI has it there is no taking it back -
                        neither CLI can - so the buttons go. Edit covers
                        taking it back; arrows only when there is an order. */}
                    {item.delivered ? <span className="queued-sent">sent</span> : <div className="queue-actions">
                      {onEditQueued
                        ? <button disabled={busy} aria-label={`Edit queued message: ${name}`} onClick={() => onEditQueued(item.turn)}>Edit</button>
                        : onWithdrawQueued && <button disabled={busy} onClick={() => onWithdrawQueued(item.turn)} title={`take back into the draft: ${name}`} aria-label={`withdraw queued message: ${name}`}>withdraw</button>}
                      {onMoveQueued && queued.length > 1 && <><button disabled={busy || index === 0 || queued[index - 1]?.delivered} aria-label={`Move up: ${name}`} onClick={() => onMoveQueued(item.turn, -1)}>↑</button><button disabled={busy || index === queued.length - 1} aria-label={`Move down: ${name}`} onClick={() => onMoveQueued(item.turn, 1)}>↓</button></>}
                      {onSendQueued && steers && <button disabled={busy} onClick={() => onSendQueued(item.turn)}>Send now</button>}
                      {onRemoveQueued && <button className="queue-remove" disabled={busy} title="Remove" aria-label={`Remove queued message: ${name}`} onClick={() => onRemoveQueued(item.turn)}><Icon name="close" size={12} /></button>}
                    </div>}
                  </div>
                );
              })}
            </div>
          )}
          {attachments && attachments.length > 0 && (
            <div className="attach-previews">
              {attachments.map((a, i) => (
                <span key={i} className="attach-preview" title={`[Image #${i + 1}] ${a.name}`}>
                  <img src={a.url} alt={`Image #${i + 1}`} />
                  <button onClick={() => removeAttachment(i)} title={`remove Image #${i + 1}`} aria-label={`remove Image #${i + 1}`}><Icon name="close" size={12} /></button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={ref} rows={1} value={draft} autoFocus={!touch}
            enterKeyHint={touch ? 'enter' : 'send'}
            placeholder={waiting ? 'Reply to the agent…' : `Message ${engine}…`}
            onChange={(e) => { historyAt.current = null; setDraft(e.target.value); }}
            onPaste={(e) => {
              if (take(e.clipboardData?.files)) { e.preventDefault(); return; }
              // A wall of text goes in as a token, not into the box.
              const text = e.clipboardData?.getData('text/plain') ?? '';
              if (text && isBigPaste(text)) {
                e.preventDefault();
                const el = e.currentTarget;
                const from = el.selectionStart, to = el.selectionEnd;
                const token = stashPaste(text);
                setDraft(draft.slice(0, from) + token + draft.slice(to));
                requestAnimationFrame(() => { const at = from + token.length; el.focus(); el.setSelectionRange(at, at); });
              }
            }}
            onKeyDown={(e) => {
              // Enter confirms an IME composition before it is a prompt.
              // Some browsers expose only isComposing, others report the
              // legacy 229 keyCode, so recognize both before palette/history
              // shortcuts can turn it into a send.
              if ((e as any).isComposing || e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (referenceMatches.length) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setReferencePick((current) => (current + (e.key === 'ArrowDown' ? 1 : referenceMatches.length - 1)) % referenceMatches.length); return; }
                if (e.key === 'Escape') { e.preventDefault(); setDismissed(true); return; }
                if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); addReference(referenceMatches[Math.min(referencePick, referenceMatches.length - 1)].id); return; }
              }
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
              if (!e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'ArrowUp' && recall(-1, e.currentTarget)) {
                e.preventDefault(); return;
              }
              if (!e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'ArrowDown' && recall(1, e.currentTarget)) {
                e.preventDefault(); return;
              }
              // A phone keyboard has no Shift+Enter, so there Return is a newline
              // and the send button sends.
              if (e.key === 'Enter' && !e.shiftKey && !touch) { e.preventDefault(); submit(); }
            }}
          />
          <div className="slab-foot">
            {onAttach && canAttach && (
              <>
                <input ref={fileRef} type="file" accept={IMAGE_ACCEPT} multiple style={{ display: 'none' }} onChange={(e) => { if (e.target.files?.length) void attach(e.target.files); e.target.value = ''; }} />
                {/* A paperclip drawn rather than an emoji: the emoji rendered in
                    the platform's own colour, which made it the only coloured
                    glyph in the chrome and the brightest thing in the composer. */}
                <button className="ctl icon" onClick={() => fileRef.current?.click()} title="attach image" aria-label="attach image">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
                  </svg>
                </button>
              </>
            )}
            {onTranscribe && dictation.state !== 'unsupported' && (
              // Recording never grows the bar: the mic itself turns red and
              // breathes with your voice; transcribing dims it under a spinner.
              <button
                className={`ctl icon mic${dictation.state === 'recording' ? ' rec' : ''}${dictation.state === 'working' ? ' busy' : ''}`}
                style={dictation.state === 'recording' ? { '--lvl': Math.min(1, dictation.level * 6) } as React.CSSProperties : undefined}
                onClick={dictation.toggle}
                disabled={dictation.state === 'working'}
                title={dictation.state === 'recording' ? `recording ${fmtSeconds(dictation.seconds)} · tap to stop`
                  : dictation.state === 'working' ? 'transcribing…' : 'speak a prompt (ctrl+shift+space)'}
                aria-label={dictation.state === 'recording' ? `stop recording, ${fmtSeconds(dictation.seconds)}`
                  : dictation.state === 'working' ? 'transcribing' : 'speak a prompt'}
                aria-pressed={dictation.state === 'recording'}
              >
                {dictation.state === 'recording' && <span className="mic-wave" aria-hidden="true" />}
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="9" y="2.5" width="6" height="11" rx="3" />
                  <path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21" />
                </svg>
              </button>
            )}
            {dictation.error && (
              <button className="attach-status bad" onClick={dictation.clearError} title="dismiss">{dictation.error}</button>
            )}
            {withKeys && onKey && <button className={`ctl${keys ? ' on' : ''}`} onClick={() => setKeys((v) => !v)}>keys</button>}
            {preparing && <span className="attach-status">compressing…</span>}
            {/* The pickers share the row the buttons are on: a second row of
                chips under the box cost a line of screen on every visit to
                say what never changes between messages. */}
            {foot ? <div className="slab-controls">{foot}</div> : <span className="spacer" />}
            {working && onStop && (
              <button className="stop" onClick={onStop} title="stop the agent" aria-label="stop the agent">
                <svg width="12" height="12" viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" rx="2" fill="currentColor" /></svg>
              </button>
            )}
            <button className="send" onClick={submit} disabled={preparing || (!draft.trim() && !attachments?.length)} title="send" aria-label="send">
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
