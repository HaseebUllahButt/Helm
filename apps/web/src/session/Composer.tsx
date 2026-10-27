import { createPortal } from 'react-dom';
import { createContext, memo, useContext, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { useNow } from '../useNow';
import { looksLikeImage, clipboardFiles, isImageAttachment } from './image';
import { useDictation, type Transcribe } from './voice';
import type { Turn } from './types';
import { isBigPaste, stashPaste } from './pasteStore';
import { renumberImages, splitTags, wholeTagEdit } from './attachTags';
import { Icon } from '../Icon';

const fmtSeconds = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** A phone: no hardware keyboard to type into straight away, no Shift+Enter. */
const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/** A narrow screen: one line of placeholder is all the box has room for. */
function useNarrow() {
  const query = '(max-width: 599px)';
  const [narrow, setNarrow] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const list = matchMedia(query);
    const change = () => setNarrow(list.matches);
    list.addEventListener('change', change);
    return () => list.removeEventListener('change', change);
  }, []);
  return narrow;
}

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
const QUEUE_SHOWN = 4;

/** A finished-task report is long; the queue only needs to say which task it is. */
/** Since when, as "0:42": the bar counts while you look at it. */
function CompactingBar({ since }: { since?: number }) {
  const now = useNow(1000);
  const took = since ? Math.max(0, Math.round((now - since) / 1000)) : 0;
  return (
    <div className="docked compacting" role="status" aria-live="polite">
      <span className="docked-text"><span className="shine">Summarizing chat…</span></span>
      {since ? <span className="docked-meta">{fmtSeconds(took)}</span> : null}
      <i className="compact-progress" aria-hidden="true" />
    </div>
  );
}

function ComposerBody({ ask, compacting, draft, setDraft, onSend, onKey, onStop, stopping, waiting, working, engine, keys: withKeys = true, danger, onAttach, attachments, onRemoveAttachment, canAttach = true, preparing = false, onAttachUnsupported, commands, history = [], queued = [], helpers = [], onWithdrawQueued, pendingLabel = 'After this response', queueBusy, onTranscribe, onEditQueued, onRemoveQueued, onMoveQueued, onSendQueued, referenceOptions = [], references = [], onReference, onRemoveReference }: {
  draft: string; setDraft: (v: string) => void; onSend: () => void;
  /** The agent's pending question or approval, as the top of the card. */
  banner?: React.ReactNode;
  /** A tab tucked behind the card's top edge, such as the task list. */
  shoulder?: React.ReactNode;
  /** What is waiting on you, so the box can say what typing here would do. */
  ask?: 'question' | 'approval';
  onKey?: (k: string) => void; onStop?: () => void;
  /** Stop was pressed and the agent has not stopped yet. */
  stopping?: boolean;
  waiting?: boolean; working?: boolean; engine: string; keys?: boolean;
  foot?: React.ReactNode; statusLine?: React.ReactNode; danger?: boolean;
  /** The agent is compacting, since this time (or true when unknown). */
  compacting?: number | boolean;
  children?: React.ReactNode;
  /** Resolves to what was added, so each gets its "[Image #N]" or "[File: name]". */
  onAttach?: (files: FileList | File[]) => void | Promise<{ name: string; mime: string }[] | void>;
  attachments?: { name: string; mime: string; url: string }[];
  onRemoveAttachment?: (i: number) => void;
  /** False when the running model cannot see images; other files still go. */
  canAttach?: boolean;
  /** True while picked files are being compressed or read in the browser. */
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
  /**
   * Other agents' messages and helpers' reports waiting for this agent. They
   * are not the owner's to edit or reorder, so they get one quiet line.
   */
  helpers?: { id: string; from: string; text: string }[];
  /** Pull a queued message back into the draft before the agent sees it. */
  onWithdrawQueued?: (turn: Turn) => void;
  /**
   * When this CLI reads a waiting message, in words: Codex and Claude after
   * the tool step in flight, OpenCode at its next step, the rest once the
   * reply ends (`messageDelivery`). Send now works on all of them.
   */
  pendingLabel?: string;
  /** The queued turn id an action is in flight for, so it cannot run twice. */
  queueBusy?: string;
  /**
   * Turn a recording into text on a machine that holds a Groq key. Absent
   * when no machine in the network has one, and then there is no microphone:
   * a button that cannot work should not be drawn.
   */
  onTranscribe?: Transcribe;
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
  const [allQueued, setAllQueued] = useState(false);
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
  const narrow = useNarrow();
  const timing = (turn: Turn) => turn.delivery === 'queue' ? 'After this task' : turn.delivery === 'steer' ? 'Sending now' : pendingLabel;
  // Said once in the heading when every waiting message goes at one time.
  const sameTiming = queued.length > 0 && queued.every((item) => !item.delivered && timing(item.turn) === timing(queued[0].turn))
    ? timing(queued[0].turn).toLowerCase() : '';
  const hints = [onReference && referenceOptions.length ? (narrow ? '@ chats' : '@ to attach a chat') : '', commands?.length ? (narrow ? '/ commands' : '/ for commands') : ''].filter(Boolean);
  const canSendWaiting = !!onSendQueued && queued.some((item) => !item.delivered);
  const placeholder = ask === 'question' ? (narrow ? 'Answer above or type an answer' : 'Answer the question above or type an answer')
    : ask === 'approval' ? (narrow ? (canSendWaiting ? 'Replies wait, or use Send now' : 'Replies wait for approval') : `Select an answer above. Replies wait for approval${canSendWaiting ? ', or use Send now.' : '.'}`)
    : waiting ? 'Reply to the agent…'
    : ['Ask anything', ...hints].join(', ');
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
  const marksRef = useRef<HTMLDivElement>(null);
  const draftNow = useRef(draft);
  draftNow.current = draft;

  /**
   * "[Image #N]" goes where the cursor was, the way Claude Code and Codex
   * write it, so "compare [Image #1] with [Image #2]" says which is which.
   * The driver puts the same label before each picture it sends. Any other
   * file is "[File: name]", the label the agent is given with its path.
   */
  const attach = async (files: FileList | File[]) => {
    if (!onAttach) return;
    const el = ref.current;
    const at = el && document.activeElement === el ? el.selectionStart : draftNow.current.length;
    let images = (attachments ?? []).filter(isImageAttachment).length;
    const added = await onAttach(files);
    if (!added?.length) return;
    const tokens = added.map((a) => isImageAttachment(a) ? `[Image #${++images}]` : `[File: ${a.name}]`).join(' ');
    const now = draftNow.current;
    const pre = now.slice(0, Math.min(at, now.length)), post = now.slice(pre.length);
    setDraft(`${pre}${pre && !/\s$/.test(pre) ? ' ' : ''}${tokens}${/^\s/.test(post) ? '' : ' '}${post}`);
  };
  /** Its label leaves with it, and the ones after it move up a number. */
  const removeAttachment = (index: number) => {
    const item = attachments?.[index];
    if (item && !isImageAttachment(item)) {
      setDraft(draftNow.current.replace(`[File: ${item.name}] `, '').replace(`[File: ${item.name}]`, ''));
      onRemoveAttachment?.(index);
      return;
    }
    const gone = (attachments ?? []).slice(0, index + 1).filter(isImageAttachment).length;
    setDraft(draftNow.current
      .replace(new RegExp(`\\[Image #${gone}\\] ?`, 'g'), '')
      .replace(/\[Image #(\d+)\]/g, (label, n) => Number(n) > gone ? `[Image #${Number(n) - 1}]` : label));
    onRemoveAttachment?.(index);
  };
  /**
   * A delete that cuts into a tag takes the whole tag, and the attachment
   * behind it goes too. True when it handled the change.
   */
  /** A tag that stands for an attachment here; "[Image #9]" typed by hand is only letters. */
  const liveTag = (tag: string) => {
    const list = attachments ?? [];
    const n = /^\[Image #(\d+)\]$/.exec(tag)?.[1];
    if (n) return Number(n) >= 1 && Number(n) <= list.filter(isImageAttachment).length;
    const file = /^\[File: (.+)\]$/.exec(tag)?.[1];
    return file == null || list.some((a) => !isImageAttachment(a) && a.name === file);
  };
  const deleteTags = (el: HTMLTextAreaElement, value: string) => {
    const list = attachments ?? [];
    const images = list.filter(isImageAttachment);
    const edit = wholeTagEdit(draftNow.current, value, liveTag);
    if (!edit) return false;
    const gone = new Set<number>();
    const goneImages: number[] = [];
    for (const tag of edit.removed) {
      const n = /^\[Image #(\d+)\]$/.exec(tag)?.[1];
      const file = /^\[File: (.+)\]$/.exec(tag)?.[1];
      const index = n ? list.indexOf(images[Number(n) - 1])
        : file != null ? list.findIndex((a, i) => !gone.has(i) && !isImageAttachment(a) && a.name === file) : -1;
      if (index < 0 || gone.has(index)) continue;
      gone.add(index);
      if (n) goneImages.push(Number(n));
    }
    setDraft(renumberImages(edit.text, goneImages));
    // Highest first, so each index still points at the same attachment.
    [...gone].sort((a, b) => b - a).forEach((i) => onRemoveAttachment?.(i));
    requestAnimationFrame(() => el.setSelectionRange(edit.caret, edit.caret));
    return true;
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
   * Files arriving by paste or drop. Both routes land here so they cannot
   * drift apart, and both say something when the agent cannot take images -
   * a screenshot pasted into a session that silently ignores it is the
   * worst version of this feature. Documents go to any agent.
   */
  const take = (list: FileList | File[] | undefined | null) => {
    const all = Array.from(list ?? []);
    if (!all.length) return false;
    if (!onAttach) { onAttachUnsupported?.(); return true; }
    const usable = canAttach ? all : all.filter((f) => !looksLikeImage(f));
    if (usable.length < all.length) onAttachUnsupported?.();
    if (usable.length) void attach(usable);
    return true;
  };
  const takeNow = useRef(take);
  takeNow.current = take;

  /**
   * A file dropped anywhere on the chat lands in this box, not only on the
   * box itself - and the browser does not open it in place of Helm. The
   * terminals keep their own drops.
   */
  const slabRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!onAttach) return;
    const mine = (e: DragEvent) => {
      const target = e.target as Element | null;
      const area = slabRef.current?.closest('.main');
      return !!area && !!target?.closest && area.contains(target) && !target.closest('.xterm, .slab')
        && Array.from(e.dataTransfer?.types ?? []).includes('Files');
    };
    const over = (e: DragEvent) => {
      // The box handles its own drags; anywhere else outside the chat drops the cover.
      if (slabRef.current?.contains(e.target as Node)) return;
      if (!mine(e)) { setDragging(false); return; }
      e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; setDragging(true);
    };
    const leave = (e: DragEvent) => { if (!e.relatedTarget) setDragging(false); };
    const drop = (e: DragEvent) => { setDragging(false); if (!mine(e)) return; e.preventDefault(); takeNow.current(e.dataTransfer?.files); };
    const end = () => setDragging(false);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    window.addEventListener('dragend', end);
    return () => { window.removeEventListener('dragover', over); window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop); window.removeEventListener('dragend', end); };
  }, [!!onAttach]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  }, [draft]);

  // A drag over the chat covers it with one clear target, not only a
  // coloured border on the box. The cover lets the drop through to the
  // chat below, so it lands where it always did.
  const dropArea = dragging && onAttach ? slabRef.current?.closest('.main') : null;

  return (
    <div className="composer-wrap">
      {dropArea && createPortal(
        <div className="drop-cover" aria-hidden="true">
          <div className="drop-card">
            <span className="drop-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
              </svg>
            </span>
            <strong>Drop to attach</strong>
            <small>{canAttach ? 'Files and images go into your message.' : 'Files go into your message. This agent cannot read images.'}</small>
          </div>
        </div>, dropArea)}
      <div className="composer-col">
        <ComposerSlot name="children" />
        {!!compacting && !waiting && <CompactingBar since={typeof compacting === 'number' ? compacting : undefined} />}
        {waiting && withKeys && onKey && (
          <div className="docked warn">
            <span className="docked-text"><i className="sdot blocked" />Waiting for you</span>
            <span className="docked-actions">
              {QUICK.slice(0, 4).map((q) => <button key={q.key} onClick={() => onKey(q.key)}>{q.label}</button>)}
            </span>
          </div>
        )}
        <ComposerSlot name="shoulder" />
        <div
          ref={slabRef}
          className={`slab${danger ? ' danger' : ''}${dragging ? ' dropping' : ''}`}
          onDragOver={(e) => { if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragging(true); } }}
          onDragLeave={(e) => { if (!e.currentTarget.closest('.main')?.contains(e.relatedTarget as Node | null)) setDragging(false); }}
          onDrop={(e) => { setDragging(false); if (take(e.dataTransfer?.files)) e.preventDefault(); }}
        >
          <ComposerSlot name="banner" />
          {!!referenceMatches.length && <div className="palette" role="listbox" aria-label="Attach chat details">
            {referenceMatches.map((item, index) => <button key={item.id} role="option" aria-selected={index === referencePick} onClick={() => addReference(item.id)} onMouseEnter={() => setReferencePick(index)}><span>@{item.title}</span><small>Attach chat details</small></button>)}
          </div>}
          {!!references.length && <div className="thread-reference-chips">{references.map((item) => <button key={item.id} onClick={() => onRemoveReference?.(item.id)} aria-label={`Remove chat details: ${item.title}`}>@{item.title}<span aria-hidden="true"> ×</span></button>)}</div>}
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
          {helpers.length > 0 && (
            <details className="queued-panel helper-inbox">
              <summary className="queued-head">
                <b>{helpers.length === 1 ? '1 message from a helper' : `${helpers.length} messages from helpers`}</b>
                <span className="helper-from">{[...new Set(helpers.map((h) => h.from))].join(', ')}</span>
              </summary>
              {helpers.map((h) => (
                <div className="helper-row" key={h.id}><b>{h.from}</b> {h.text}</div>
              ))}
            </details>
          )}
          {queued.length > 0 && (
            <div className="queued-panel">
              <div className="queued-head">
                <b>{queued.length} waiting{sameTiming && ` · ${sameTiming}`}</b>
                {queued.length > QUEUE_SHOWN && <button onClick={() => setAllQueued(!allQueued)}>{allQueued ? 'Show fewer' : `Show all ${queued.length}`}</button>}
              </div>
              {queued.map((item, index) => ({ item, index })).filter(({ index }) => allQueued || index < QUEUE_SHOWN).map(({ item, index }) => {
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
                      {/* When it will be read: a held message waits for the
                          task; the rest follow the CLI's own timing. */}
                      {!item.delivered && !sameTiming && <span className="queued-timing">
                        {timing(item.turn)}
                      </span>}
                    </span>
                    {/* Once the CLI has it there is no taking it back -
                        no CLI can - so the buttons go. Edit covers
                        taking it back; arrows only when there is an order. */}
                    {item.delivered ? <span className="queued-sent">Sent to agent</span> : <div className="queue-actions">
                      {onEditQueued && !item.turn.text.trimStart().startsWith('/')
                        ? <button disabled={busy} aria-label={`Edit waiting message: ${name}`} onClick={() => onEditQueued(item.turn)}>Edit</button>
                        : onWithdrawQueued && <button disabled={busy} onClick={() => onWithdrawQueued(item.turn)} title={`Return to draft: ${name}`} aria-label={`Return waiting message to draft: ${name}`}>Return to draft</button>}
                      {onMoveQueued && queued.length > 1 && <><button disabled={busy || index === 0 || queued[index - 1]?.delivered} aria-label={`Move up: ${name}`} onClick={() => onMoveQueued(item.turn, -1)}>↑</button><button disabled={busy || index === queued.length - 1} aria-label={`Move down: ${name}`} onClick={() => onMoveQueued(item.turn, 1)}>↓</button></>}
                      {onSendQueued && <button disabled={busy} onClick={() => onSendQueued(item.turn)}>Send now</button>}
                      {onRemoveQueued && <button className="queue-remove" disabled={busy} title="Remove" aria-label={`Remove waiting message: ${name}`} onClick={() => onRemoveQueued(item.turn)}><Icon name="close" size={12} /></button>}
                    </div>}
                  </div>
                );
              })}
            </div>
          )}
          {attachments && attachments.length > 0 && (
            <div className="attach-previews">
              {attachments.map((a, i) => {
                const label = isImageAttachment(a) ? `Image #${attachments.slice(0, i + 1).filter(isImageAttachment).length}` : a.name;
                return (
                  <span key={i} className={`attach-preview${isImageAttachment(a) ? '' : ' file'}`} title={isImageAttachment(a) ? `[${label}] ${a.name}` : a.name}>
                    {isImageAttachment(a) ? <img src={a.url} alt={label} /> : <span className="attach-file">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" /><path d="M14 3v5h5" /></svg>
                      <span className="attach-file-name">{a.name}</span>
                    </span>}
                    <button onClick={() => removeAttachment(i)} title={`Remove ${label}`} aria-label={`Remove ${label}`}><Icon name="close" size={12} /></button>
                  </span>
                );
              })}
            </div>
          )}
          {/* The same text drawn behind the box, see-through except for a
              tint behind each tag, so "[Image #1]" reads as one piece. */}
          <div className="composer-field">
          <div ref={marksRef} className="composer-marks" aria-hidden="true">
            {splitTags(draft, liveTag).map((part, i) => part.tag ? <mark key={i}>{part.text}</mark> : part.text)}{'\n'}
          </div>
          <textarea
            ref={ref} rows={1} value={draft} autoFocus={!touch}
            onScroll={(e) => { if (marksRef.current) marksRef.current.scrollTop = e.currentTarget.scrollTop; }}
            enterKeyHint={touch ? 'enter' : 'send'}
            placeholder={placeholder} aria-label={`Message ${engine}`} data-composer=""
            onChange={(e) => {
              historyAt.current = null;
              if (!deleteTags(e.currentTarget, e.target.value)) setDraft(e.target.value);
            }}
            onPaste={(e) => {
              if (take(clipboardFiles(e.clipboardData))) { e.preventDefault(); return; }
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
          </div>
          <div className="slab-foot">
            {onAttach && (
              <>
                <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => { if (e.target.files?.length) void attach(e.target.files); e.target.value = ''; }} />
                {/* A paperclip drawn rather than an emoji: the emoji rendered in
                    the platform's own colour, which made it the only coloured
                    glyph in the chrome and the brightest thing in the composer. */}
                <button className="ctl icon" onClick={() => fileRef.current?.click()} title="Attach files or images" aria-label="Attach files or images">
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
                ref={dictation.meter}
                onClick={dictation.toggle}
                disabled={dictation.state === 'working'}
                title={dictation.state === 'recording' ? `Recording ${fmtSeconds(dictation.seconds)}. Select to stop.`
                  : dictation.state === 'working' ? 'Converting speech to text…' : 'Speak a message (ctrl+shift+space)'}
                aria-label={dictation.state === 'recording' ? `Stop recording, ${fmtSeconds(dictation.seconds)}`
                  : dictation.state === 'working' ? 'transcribing' : 'Speak a message'}
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
              <button className="attach-status bad" onClick={dictation.clearError} title="Dismiss">{dictation.error}</button>
            )}
            {withKeys && onKey && <button className={`ctl${keys ? ' on' : ''}`} onClick={() => setKeys((v) => !v)}>keys</button>}
            {preparing && <span className="attach-status">Making images smaller…</span>}
            {/* The pickers share the row the buttons are on: a second row of
                chips under the box cost a line of screen on every visit to
                say what never changes between messages. */}
            <ComposerSlot name="foot" />
            {/* Beside the pickers on a wide box, its own line inside it on a narrow
                one: a line under the card cost the chat a row on every screen. */}
            <ComposerSlot name="statusLine" />
            {working && onStop && (
              <button className={`stop${stopping ? ' stopping' : ''}`} onClick={onStop} disabled={stopping}
                title={stopping ? 'Stopping the agent' : 'stop the agent'} aria-label={stopping ? 'Stopping the agent' : 'stop the agent'}>
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

type SlotName = 'banner' | 'shoulder' | 'foot' | 'statusLine' | 'children';
const ComposerSlots = createContext<Partial<Record<SlotName, ReactNode>>>({});

/** Incoming status cards can change without redrawing the message editor. */
function ComposerSlot({ name }: { name: SlotName }) {
  const node = useContext(ComposerSlots)[name];
  if (name === 'foot') return node ? <div className="slab-controls">{node}</div> : <span className="spacer" />;
  if (name === 'statusLine') return node ? <div className="slab-status">{node}</div> : null;
  return <>{node}</>;
}

const MessageEditor = memo(ComposerBody);
export function Composer({ banner, shoulder, foot, statusLine, children, ...editor }: ComponentProps<typeof ComposerBody>) {
  return <ComposerSlots.Provider value={{ banner, shoulder, foot, statusLine, children }}>
    <MessageEditor {...editor} />
  </ComposerSlots.Provider>;
}
