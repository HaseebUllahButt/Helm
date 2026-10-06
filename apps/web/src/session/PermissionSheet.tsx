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
export function PermissionSheet({ permission: p, onAnswer, busy }: {
  permission: Permission; onAnswer: (d: Decision) => void; busy: boolean;
}) {
  const [note, setNote] = useState('');
  // "Edit it, then allow" - for the kinds the driver said take an updated
  // input (a command, a plan). The textarea starts on what the agent asked,
  // and the button says what actually happens: allow *this* version.
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState('');
  const now = useNow();
  const answer = (option: Decision['option'], updatedInput?: any) =>
    onAnswer({ option, message: note.trim() || undefined, ...(updatedInput ? { updatedInput } : {}) });

  if (p.kind === 'question') return <QuestionSheet permission={p} onAnswer={onAnswer} busy={busy} />;

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
  ) : <button className="primary" disabled={busy} onClick={() => answer('allow')}>{allow.label}</button>);
  const alwaysButton = always && <button className="ghost" disabled={busy} onClick={() => answer('always')}>{always.label}</button>;
  const denyButton = deny && <button className="ghost deny" disabled={busy} onClick={() => answer('deny')}>{deny.label}</button>;

  return (
    <div className={`sheet ${p.kind}`}>
      <div className="sheet-head">
        <i className="sdot blocked" />
        <b>{p.title}</b>
        {p.tool && p.kind !== 'plan' && <span className="tag">{p.tool}</span>}
        {p.parentId && <span className="tag">subagent</span>}
        {p.at && <span className="tag waiting">waiting {waitingSince(p.at, now)}</span>}
      </div>
      {p.reason && <div className="sheet-reason">{p.reason}</div>}
      <div className="sheet-body">
        {p.kind === 'command' && !editing && <pre className="sheet-cmd">❯ {original}</pre>}
        {p.kind === 'plan' && !editing && <Markdown text={original} className="prose plan" />}
        {editing && (
          <textarea
            className="sheet-edit" value={edited} autoFocus
            onChange={(e) => setEdited(e.target.value)}
            rows={Math.min(14, Math.max(3, edited.split('\n').length + 1))}
          />
        )}
        {p.kind === 'edit' && <EditDetail detail={p.detail} />}
        {p.kind === 'tool' && p.detail && <pre className="sheet-json">{typeof p.detail === 'string' ? p.detail : JSON.stringify(p.detail, null, 2)}</pre>}
      </div>
      {editable && !editing && (
        <button className="sheet-editlink" onClick={() => { setEdited(original); setEditing(true); }}>
          edit before {p.kind === 'plan' ? 'approving' : 'allowing'}
        </button>
      )}
      {editing && (
        <button className="sheet-editlink" onClick={() => setEditing(false)}>back to the original</button>
      )}
      {/* "No, do it differently" is the most common answer to a permission
          prompt - every denial takes a reason, not only plans. */}
      <input
        className="sheet-note" value={note} onChange={(e) => setNote(e.target.value)}
        placeholder={p.kind === 'plan' ? 'What should change? (optional)' : 'Add a note (optional)'}
      />
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
  return <pre className="sheet-json">{JSON.stringify(detail, null, 2)}</pre>;
}

// --------------------------------------------------------------- questions

/**
 * One question at a time. Several questions stacked in one scrolling card
 * hid the second one below the fold, and the only button stayed grey until
 * you found it. Now each question has the whole card, a tab says which are
 * done, and picking a single answer moves on by itself. On a keyboard 1-9
 * pick and Enter moves on, whenever you are not typing somewhere.
 */
function QuestionSheet({ permission: p, onAnswer, busy }: {
  permission: Permission; onAnswer: (d: Decision) => void; busy: boolean;
}) {
  const questions = p.questions ?? [];
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const now = useNow();
  const key = (q: Question) => q.question;

  const answers: Record<string, string> = {};
  for (const q of questions) {
    const chosen = picked[key(q)] ?? [];
    const free = (other[key(q)] ?? '').trim();
    const all = free ? [...chosen, free] : chosen;
    if (all.length) answers[key(q)] = all.join(', ');
  }
  const complete = questions.every((q) => answers[key(q)]);
  const q = questions[Math.min(step, questions.length - 1)];
  const last = step >= questions.length - 1;
  const firstOpen = questions.findIndex((x) => !answers[key(x)]);

  const choose = (q: Question, label: string) => {
    const have = picked[key(q)] ?? [];
    if (q.multiSelect) {
      setPicked({ ...picked, [key(q)]: have.includes(label) ? have.filter((x) => x !== label) : [...have, label] });
      return;
    }
    // A single answer is either a listed one or what was typed, not both.
    setPicked({ ...picked, [key(q)]: [label] });
    setOther({ ...other, [key(q)]: '' });
    const at = questions.indexOf(q);
    if (at < questions.length - 1) setTimeout(() => setStep((s) => (s === at ? at + 1 : s)), 180);
  };
  const type = (q: Question, text: string) => {
    setOther({ ...other, [key(q)]: text });
    if (!q.multiSelect && text.trim()) setPicked({ ...picked, [key(q)]: [] });
  };
  const send = () => { if (complete && !busy) onAnswer({ option: 'allow', answers }); };
  const next = () => {
    if (busy || !answers[key(q)]) return;
    if (!last) setStep(step + 1);
    else if (complete) send();
    else if (firstOpen >= 0) setStep(firstOpen);
  };

  // Digits and Enter, for whoever is at a keyboard - never while a text box
  // has the cursor, where they are just typing.
  const keys = useRef({ q, next, choose });
  keys.current = { q, next, choose };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName ?? '') || el?.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('[aria-modal="true"]')) return;
      const { q, next, choose } = keys.current;
      if (!q) return;
      const n = Number(e.key);
      if (n >= 1 && n <= q.options.length) { e.preventDefault(); choose(q, q.options[n - 1].label); }
      else if (e.key === 'Enter') { e.preventDefault(); next(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!q) return null;
  const chosen = picked[key(q)] ?? [];
  const preview = q.options.find((o) => o.preview && chosen.includes(o.label))?.preview;
  const action = !last ? 'Next' : complete ? (questions.length > 1 ? 'Send answers' : 'Send answer') : 'Answer the rest';

  return (
    <div className="sheet question">
      <div className="sheet-head">
        <i className="sdot blocked" /><b>{p.title}</b>
        {p.at && <span className="sheet-wait">waiting {waitingSince(p.at, now)}</span>}
      </div>
      {questions.length > 1 && (
        <div className="q-steps" role="tablist" aria-label="Questions">
          {questions.map((x, i) => (
            <button key={key(x)} role="tab" aria-selected={i === step}
              className={`q-step${i === step ? ' on' : ''}${answers[key(x)] ? ' done' : ''}`} onClick={() => setStep(i)}>
              <span className="q-step-n">{answers[key(x)] ? <Icon name="check" size={11} /> : i + 1}</span>
              <span className="q-step-t">{x.header || `Question ${i + 1}`}</span>
            </button>
          ))}
        </div>
      )}
      <div className="sheet-body">
        <div className="q-text">{q.question}</div>
        {q.multiSelect && <div className="q-hint">Pick any that apply</div>}
        <div className="q-options" role={q.multiSelect ? 'group' : 'radiogroup'} aria-label={q.question}>
          {q.options.map((o, i) => {
            const on = chosen.includes(o.label);
            return (
              <button key={o.label} role={q.multiSelect ? 'checkbox' : 'radio'} aria-checked={on}
                className={`q-opt${on ? ' on' : ''}`} onClick={() => choose(q, o.label)}>
                <span className={`q-key${q.multiSelect ? ' box' : ''}`}>{on ? <Icon name="check" size={12} /> : i + 1}</span>
                <span className="grow">
                  <span className="q-label">{o.label}</span>
                  {o.description && <span className="q-desc">{o.description}</span>}
                </span>
              </button>
            );
          })}
          <label className={`q-opt q-free${(other[key(q)] ?? '').trim() ? ' on' : ''}`}>
            <span className="q-key"><Icon name="edit" size={12} /></span>
            <input
              type={q.secret ? 'password' : 'text'} value={other[key(q)] ?? ''}
              placeholder={q.options.length ? 'Something else…' : 'Type your answer…'}
              aria-label="Your own answer"
              onChange={(e) => type(q, e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); next(); } }}
            />
          </label>
        </div>
        {preview && <pre className="q-preview">{preview}</pre>}
      </div>
      <div className="sheet-actions q-actions">
        {step > 0 && <button className="ghost" onClick={() => setStep(step - 1)}>Back</button>}
        <button className="primary" disabled={busy || !answers[key(q)]} onClick={next}>
          {busy ? 'Sending…' : action}
        </button>
      </div>
    </div>
  );
}
