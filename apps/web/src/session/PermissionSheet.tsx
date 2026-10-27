import { useEffect, useRef, useState } from 'react';
import { Markdown } from '../Markdown';
import { ChangeList, Diff } from './Transcript';
import { useNow, waitingSince } from '../useNow';
import type { Decision, Permission, Question } from './types';
import { Icon } from '../Icon';

/**
 * The agent stopped to ask. This is the whole reason helm exists, so the
 * question gets the space it needs: what it wants to do, shown plainly, and
 * the answers as buttons. A question with options is rendered as those
 * options; a plan is rendered as the plan.
 */
/**
 * How a request is laid out. `sheet` is the old card that tucks behind the
 * composer (still used by the subagent panel); `banner` is the same content
 * as the top of the composer card, with the answer typed in the composer.
 */
export type AskVariant = 'sheet' | 'banner';

/** What the composer needs from a question banner, to send a typed answer. */
export interface QuestionHandle { submit: (text: string) => 'sent' | 'wait' }

/** Said the way people say it, whatever the CLI's own word was. */
const plainLabel = (label: string) => label === 'Allow' ? 'Approve' : label === 'Deny' ? 'Decline' : label;

/**
 * What a tool was given, as "name: value" lines a person can read; only a
 * nested value keeps its JSON. `{"command": "echo hi"}` reads "command: echo hi".
 */
export function plainDetail(detail: unknown): string {
  if (typeof detail === 'string') {
    // Every driver sends a tool's input already as JSON text (clipped when
    // long, which no longer parses and is shown as it came).
    if (!/^\s*\{/.test(detail)) return detail;
    try { return plainDetail(JSON.parse(detail)); } catch { return detail; }
  }
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return JSON.stringify(detail, null, 2) ?? '';
  return Object.entries(detail as Record<string, unknown>)
    .map(([name, value]) => `${name}: ${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`)
    .join('\n');
}

const ASK_LABEL: Record<Permission['kind'], string> = {
  command: 'Command approval', edit: 'File change approval', tool: 'Tool approval', plan: 'Plan approval', question: 'Question',
};

export function PermissionSheet({ permission: p, onAnswer, busy, variant = 'sheet', onHandle }: {
  permission: Permission; onAnswer: (d: Decision) => void; busy: boolean; variant?: AskVariant;
  /** Banner questions: hand the composer a way to answer with what it holds. */
  onHandle?: (handle: QuestionHandle | null) => void;
}) {
  const [note, setNote] = useState('');
  // "Edit it, then allow" - for the kinds the driver said take an updated
  // input (a command, a plan). The textarea starts on what the agent asked,
  // and the button says what actually happens: allow *this* version.
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState('');
  const [noting, setNoting] = useState(false);
  const now = useNow();
  const answer = (option: Decision['option'], updatedInput?: any) =>
    onAnswer({ option, message: note.trim() || undefined, ...(updatedInput ? { updatedInput } : {}) });

  const banner = variant === 'banner';
  if (p.kind === 'question') return <QuestionSheet permission={p} onAnswer={onAnswer} busy={busy} variant={variant} onHandle={onHandle} />;

  const allow = p.options.find((o) => o.role === 'allow');
  const always = p.options.find((o) => o.role === 'allow-always');
  const deny = p.options.find((o) => o.role === 'deny');
  const denyFirst = p.defaultTo === 'deny';

  // What an edit would change, in the driver's own shape: the CLI's tool
  // input with the one editable field swapped for what was typed.
  const editable = p.allowEdit && (p.kind === 'command' || p.kind === 'plan');
  const original = String(p.detail ?? '');
  const updatedInput = () => p.kind === 'command'
    ? { ...(typeof p.input === 'object' && p.input ? p.input : {}), command: edited }
    : { plan: edited };
  const changed = editing && edited.trim() !== original.trim();

  const allowButton = allow && (changed ? (
    <button className="primary" disabled={busy || !edited.trim()} onClick={() => answer('allow', updatedInput())}>
      {p.kind === 'plan' ? 'Approve edited plan' : 'Allow edited command'}
    </button>
  ) : <button className="primary" disabled={busy} onClick={() => answer('allow')}>{plainLabel(allow.label)}</button>);
  const alwaysButton = always && <button className="ghost" disabled={busy} onClick={() => answer('always')}>{plainLabel(always.label)}</button>;
  const denyButton = deny && <button className="ghost deny" disabled={busy} onClick={() => answer('deny')}>{plainLabel(deny.label)}</button>;

  return (
    <div className={`sheet ${p.kind}${banner ? ' banner' : ''}`}>
      {banner ? (
        // On the card: what kind of ask and how long it has waited, then
        // the title on a line of its own so a phone never cuts it short.
        // A command's tool tag ("Bash") says nothing the label does not.
        <>
          <div className="sheet-head">
            <i className="sdot blocked" />
            <span className="ask-kind">{ASK_LABEL[p.kind]}</span>
            {p.tool && p.kind !== 'plan' && p.kind !== 'command' && p.tool.toLowerCase() !== p.kind && <span className="tag">{p.tool}</span>}
            {p.parentId && <span className="tag">Helper</span>}
            {p.at && <span className="q-wait">{waitingSince(p.at, now)}</span>}
          </div>
          <div className="sheet-title">
            <b>{p.title}</b>
            {p.reason && <span className="sheet-reason">{p.reason}</span>}
          </div>
        </>
      ) : (
        <>
          <div className="sheet-head">
            <i className="sdot blocked" />
            <b>{p.title}</b>
            {p.tool && p.kind !== 'plan' && <span className="tag">{p.tool}</span>}
            {p.parentId && <span className="tag">Helper</span>}
            {p.at && <span className="tag waiting">waiting {waitingSince(p.at, now)}</span>}
          </div>
          {p.reason && <div className="sheet-reason">{p.reason}</div>}
        </>
      )}
      <div className="sheet-body">
        {p.kind === 'command' && !editing && <pre className="sheet-cmd">{banner ? '' : '❯ '}{original}</pre>}
        {p.kind === 'plan' && !editing && <Markdown text={original} className="prose plan" />}
        {editing && (
          <textarea
            className="sheet-edit" value={edited} autoFocus
            onChange={(e) => setEdited(e.target.value)}
            rows={Math.min(14, Math.max(3, edited.split('\n').length + 1))}
          />
        )}
        {p.kind === 'edit' && <EditDetail detail={p.detail} />}
        {p.kind === 'tool' && p.detail && <pre className="sheet-json">{plainDetail(p.detail)}</pre>}
      </div>
      {/* On the card the extras are one quiet row of links; the note box
          opens when asked for, since the composer below takes a reply too. */}
      {(editable || banner) && (
        <div className="sheet-links">
          {editable && !editing && (
            <button className="sheet-editlink" onClick={() => { setEdited(original); setEditing(true); }}>
              {p.kind === 'plan' ? 'Edit plan' : 'Edit command'}
            </button>
          )}
          {editing && (
            <button className="sheet-editlink" onClick={() => setEditing(false)}>Restore original</button>
          )}
          {banner && !noting && (
            <button className="sheet-editlink" onClick={() => setNoting(true)}>Add a note</button>
          )}
        </div>
      )}
      {/* "No, do it differently" is the most common answer to a permission
          prompt - every denial takes a reason, not only plans. */}
      {(!banner || noting) && (
        <input
          className="sheet-note" value={note} onChange={(e) => setNote(e.target.value)} autoFocus={banner}
          placeholder={p.kind === 'plan' ? 'What should change? (optional)' : 'Add a note (optional)'}
        />
      )}
      {note.trim() && <p className="note">Approve lets this step run before the agent reads your note. Decline to request a change.</p>}
      {/* Built in the order it is seen, so Tab walks the buttons the way the
          eye does. A prompt whose safe answer is "no" leads with Deny; it
          used to get there with row-reverse, which left Allow first in the
          Tab order of a sheet that was showing it last. */}
      <div className="sheet-actions">
        {denyFirst && denyButton}
        {denyFirst && alwaysButton}
        {allowButton}
        {!denyFirst && alwaysButton}
        {!denyFirst && denyButton}
      </div>
    </div>
  );
}

/**
 * Old text against new, as only the lines that differ.
 *
 * An edit is sent as the whole old string and the whole new one, so a
 * one-line addition arrived as "remove the line above, add it back, add the
 * new line" - and a trailing newline drew a lone `-` and `+` besides. The
 * lines both sides share at the top and bottom are not the change.
 */
function changedLines(before: unknown, after: unknown): string {
  const split = (v: unknown) => { const t = String(v ?? ''); return t === '' ? [] : t.replace(/\n$/, '').split('\n'); };
  const a = split(before), b = split(after);
  let top = 0;
  while (top < a.length && top < b.length && a[top] === b[top]) top += 1;
  let bottom = 0;
  while (bottom < a.length - top && bottom < b.length - top && a[a.length - 1 - bottom] === b[b.length - 1 - bottom]) bottom += 1;
  const gone = a.slice(top, a.length - bottom), came = b.slice(top, b.length - bottom);
  // Nothing differs, or nothing was left to trim: show what was sent.
  if (!gone.length && !came.length) return [...a.map((l) => '-' + l), ...b.map((l) => '+' + l)].join('\n');
  return [...gone.map((l) => '-' + l), ...came.map((l) => '+' + l)].join('\n');
}

/** A file change as the CLI described it: a diff, or new content, or old/new. */
function EditDetail({ detail }: { detail: any }) {
  if (!detail) return null;
  if (Array.isArray(detail.changes)) return <ChangeList changes={detail.changes} open />;
  if (detail.content != null) {
    return (
      <>
        <div className="sheet-path">{detail.path}</div>
        <Diff text={String(detail.content).split('\n').map((l: string) => '+' + l).join('\n')} />
      </>
    );
  }
  if (detail.old != null || detail.new != null) {
    const text = changedLines(detail.old, detail.new);
    return (
      <>
        <div className="sheet-path">{detail.path}{detail.all ? ' · every occurrence' : ''}</div>
        <Diff text={text} />
      </>
    );
  }
  if (Array.isArray(detail.edits)) {
    return (
      <>
        <div className="sheet-path">{detail.path} · {detail.edits.length} edits</div>
        {detail.edits.map((e: any, i: number) => (
          <Diff key={i} text={changedLines(e.old, e.new)} />
        ))}
      </>
    );
  }
  return <pre className="sheet-json">{plainDetail(detail)}</pre>;
}

// --------------------------------------------------------------- questions

/**
 * One question at a time, as plainly as it can be put: who is asking, the
 * question, and the answers as rows. Tapping a single answer is the answer -
 * it moves to the next question, or sends when it was the last one left.
 * Only picking several, or typing your own, needs a button. On a keyboard
 * 1-9 pick and Enter sends, whenever you are not typing somewhere.
 */
function QuestionSheet({ permission: p, onAnswer, busy, variant, onHandle }: {
  permission: Permission; onAnswer: (d: Decision) => void; busy: boolean; variant: AskVariant;
  onHandle?: (handle: QuestionHandle | null) => void;
}) {
  const questions = p.questions ?? [];
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const now = useNow();
  const key = (q: Question) => q.question;

  const answersWith = (pickedNow: Record<string, string[]>, otherNow: Record<string, string>) => {
    const out: Record<string, string[]> = {};
    for (const q of questions) {
      const chosen = pickedNow[key(q)] ?? [];
      const free = (otherNow[key(q)] ?? '').trim();
      const all = free ? [...chosen, free] : chosen;
      if (all.length) out[key(q)] = all;
    }
    return out;
  };
  const answers = answersWith(picked, other);
  const q = questions[Math.min(step, questions.length - 1)];

  /** Go on from a question that now has an answer: the next open one, or send. */
  const sent = useRef(false);
  const autoAdvance = useRef<ReturnType<typeof setTimeout>>();
  const cancelAdvance = () => clearTimeout(autoAdvance.current);
  useEffect(() => cancelAdvance, []);
  // A send that failed leaves the card up; it can be tried again.
  useEffect(() => { if (!busy) sent.current = false; }, [busy]);
  const advance = (now: Record<string, string[]>) => {
    if (busy || sent.current) return;
    const open = questions.findIndex((x) => !now[key(x)]);
    // Two quick taps must not answer twice.
    if (open < 0) {
      sent.current = true;
      onAnswer({ option: 'allow', answers: Object.fromEntries(Object.entries(now).map(([key, values]) => [key, values.join(', ')])), answerLists: now });
      return;
    }
    setStep(open);
  };

  const choose = (q: Question, label: string) => {
    if (busy || sent.current) return;
    cancelAdvance();
    if (q.multiSelect) {
      setPicked((all) => {
        const have = all[key(q)] ?? [];
        return { ...all, [key(q)]: have.includes(label) ? have.filter((x) => x !== label) : [...have, label] };
      });
      return;
    }
    // A single answer is either a listed one or what was typed, not both.
    const nextPicked = { ...picked, [key(q)]: [label] };
    const nextOther = { ...other, [key(q)]: '' };
    setPicked(nextPicked); setOther(nextOther);
    const now = answersWith(nextPicked, nextOther);
    autoAdvance.current = setTimeout(() => advance(now), 140);
  };
  const type = (q: Question, text: string) => {
    cancelAdvance();
    setOther({ ...other, [key(q)]: text });
    if (!q.multiSelect && text.trim()) setPicked({ ...picked, [key(q)]: [] });
  };
  const confirm = () => { cancelAdvance(); if (q && answers[key(q)]) advance(answers); };

  /** What was typed in the composer is the answer to the question being shown. */
  const submitText = (text: string): 'sent' | 'wait' => {
    if (!q || busy || sent.current) return 'wait';
    cancelAdvance();
    const nextOther = { ...other, [key(q)]: text };
    const nextPicked = q.multiSelect ? picked : { ...picked, [key(q)]: [] };
    setOther(nextOther); setPicked(nextPicked);
    advance(answersWith(nextPicked, nextOther));
    return 'sent';
  };

  // Ctrl/Cmd+Alt keeps answer keys separate from typing and browser tab keys.
  // A filled text box always keeps its keys.
  const keys = useRef({ q, confirm, choose, submitText });
  keys.current = { q, confirm, choose, submitText };
  useEffect(() => {
    if (!onHandle) return;
    onHandle({ submit: (text) => keys.current.submitText(text) });
    return () => onHandle(null);
  }, [onHandle]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const emptyComposer = el?.tagName === 'TEXTAREA' && el.hasAttribute('data-composer') && !(el as HTMLTextAreaElement).value;
      if (!emptyComposer && (/^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName ?? '') || el?.isContentEditable)) return;
      if (e.defaultPrevented || e.getModifierState('AltGraph') || !(e.ctrlKey || e.metaKey) || !e.altKey || e.shiftKey || e.repeat || e.isComposing || document.querySelector('[aria-modal="true"]')) return;
      const { q, confirm, choose } = keys.current;
      if (!q) return;
      const n = Number(/^Digit([1-9])$/.exec(e.code)?.[1] ?? e.key);
      if (n >= 1 && n <= q.options.length) { e.preventDefault(); choose(q, q.options[n - 1].label); }
      else if (e.key === 'Enter') { e.preventDefault(); confirm(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!q) return null;
  const chosen = picked[key(q)] ?? [];
  const free = other[key(q)] ?? '';
  const preview = q.options.find((o) => o.preview && chosen.includes(o.label))?.preview;
  // A button only when a tap cannot be the answer: several picked, or typed.
  const needsButton = q.multiSelect ? chosen.length > 0 || !!free.trim() : !!free.trim();
  const remaining = questions.filter((x) => x !== q && !answers[key(x)]).length;
  const banner = variant === 'banner';
  // The composer takes a typed answer, except a secret one: a password
  // should be typed into a password box.
  const typeInline = !banner || !onHandle || !!q.secret;

  return (
    <div className={`sheet question${banner ? ' banner' : ''}`}>
      <div className="q-head">
        <i className="sdot blocked" />
        {banner && <span className="ask-kind">Question</span>}
        <span className="q-who">{p.title}</span>
        {questions.length > 1 && (
          <span className="q-steps" role="tablist" aria-label="Questions">
            {questions.map((x, i) => (
              <button key={key(x)} role="tab" aria-selected={i === step} aria-label={x.header || `Question ${i + 1}`}
                title={x.header || `Question ${i + 1}`}
                className={`q-dot${i === step ? ' on' : ''}${answers[key(x)] ? ' done' : ''}`} onClick={() => { cancelAdvance(); setStep(i); }} />
            ))}
            <span className="q-count">{step + 1} of {questions.length}</span>
          </span>
        )}
        {p.at && <span className="q-wait">{waitingSince(p.at, now)}</span>}
      </div>
      <div className="sheet-body">
        <div className="q-text">{q.question}</div>
        {q.multiSelect && <div className="q-hint">Select all that apply</div>}
        <div className="q-options" role={q.multiSelect ? 'group' : 'radiogroup'} aria-label={q.question}>
          {q.options.map((o, i) => {
            const on = chosen.includes(o.label);
            return (
              <button key={o.label} role={q.multiSelect ? 'checkbox' : 'radio'} aria-checked={on} disabled={busy}
                className={`q-opt${on ? ' on' : ''}${q.multiSelect ? ' multi' : ''}`} onClick={() => choose(q, o.label)}>
                <kbd className="q-num" title={`Choose answer ${i + 1} (Ctrl/⌘ Alt ${i + 1})`}>{i + 1}</kbd>
                <span className="grow">
                  <span className="q-label">{o.label}</span>
                  {o.description && <span className="q-desc">{o.description}</span>}
                </span>
                {q.multiSelect
                  ? <span className="q-box">{on && <Icon name="check" size={11} />}</span>
                  : <span className="q-go" aria-hidden="true"><Icon name="forward" size={14} /></span>}
              </button>
            );
          })}
        </div>
        {typeInline && <div className={`q-free${free.trim() ? ' on' : ''}`}>
          <input
            type={q.secret ? 'password' : 'text'} value={free}
            placeholder={q.options.length ? 'Type another answer' : 'Type your answer'}
            aria-label="Your own answer"
            onChange={(e) => type(q, e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); confirm(); } }}
          />
        </div>}
        {preview && <pre className="q-preview">{preview}</pre>}
      </div>
      {(needsButton || busy) && (
        <div className="q-actions">
          <button className="primary" disabled={busy || !answers[key(q)]} onClick={confirm}>
            {busy ? 'Sending…' : remaining ? 'Next' : 'Send'}
          </button>
        </div>
      )}
    </div>
  );
}
