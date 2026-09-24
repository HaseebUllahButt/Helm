import { useState } from 'react';
import { Markdown } from '../Markdown';
import { ChangeList, Diff } from './Transcript';
import { useNow, waitingSince } from '../useNow';
import type { Decision, Permission, Question } from './types';

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
        placeholder={p.kind === 'plan' ? 'What should change? (optional, sent with “Keep planning”)' : 'Say why, or what to do instead (optional, sent with deny)'}
      />
      <div className={`sheet-actions${denyFirst ? ' deny-first' : ''}`}>
        {allow && changed && (
          <button className="primary" disabled={busy || !edited.trim()} onClick={() => answer('allow', updatedInput())}>
            {p.kind === 'plan' ? 'Approve edited plan' : 'Allow edited command'}
          </button>
        )}
        {allow && !changed && <button className="primary" disabled={busy} onClick={() => answer('allow')}>{allow.label}</button>}
        {always && <button className="ghost" disabled={busy} onClick={() => answer('always')}>{always.label}</button>}
        {deny && <button className="ghost deny" disabled={busy} onClick={() => answer('deny')}>{deny.label}</button>}
      </div>
    </div>
  );
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
    const text = [...String(detail.old ?? '').split('\n').map((l: string) => '-' + l), ...String(detail.new ?? '').split('\n').map((l: string) => '+' + l)].join('\n');
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
          <Diff key={i} text={[...String(e.old ?? '').split('\n').map((l: string) => '-' + l), ...String(e.new ?? '').split('\n').map((l: string) => '+' + l)].join('\n')} />
        ))}
      </>
    );
  }
  return <pre className="sheet-json">{JSON.stringify(detail, null, 2)}</pre>;
}

// --------------------------------------------------------------- questions

function QuestionSheet({ permission: p, onAnswer, busy }: {
  permission: Permission; onAnswer: (d: Decision) => void; busy: boolean;
}) {
  const questions = p.questions ?? [];
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const now = useNow();
  const key = (q: Question) => q.question;

  const toggle = (q: Question, label: string) => {
    setPicked((cur) => {
      const have = cur[key(q)] ?? [];
      if (q.multiSelect) return { ...cur, [key(q)]: have.includes(label) ? have.filter((x) => x !== label) : [...have, label] };
      return { ...cur, [key(q)]: [label] };
    });
  };

  const answers: Record<string, string> = {};
  for (const q of questions) {
    const chosen = picked[key(q)] ?? [];
    const free = (other[key(q)] ?? '').trim();
    const all = free ? [...chosen, free] : chosen;
    if (all.length) answers[key(q)] = all.join(', ');
  }
  const complete = questions.every((q) => answers[key(q)]);

  return (
    <div className="sheet question">
      <div className="sheet-head">
        <i className="sdot blocked" /><b>{p.title}</b>
        {p.at && <span className="tag waiting">waiting {waitingSince(p.at, now)}</span>}
      </div>
      <div className="sheet-body">
        {questions.map((q) => (
          <div key={key(q)} className="q">
            {q.header && <span className="tag">{q.header}</span>}
            <div className="q-text">{q.question}</div>
            <div className="q-options">
              {q.options.map((o) => {
                const on = (picked[key(q)] ?? []).includes(o.label);
                return (
                  <button key={o.label} className={`q-opt${on ? ' on' : ''}`} onClick={() => toggle(q, o.label)}>
                    <span className={`q-mark${q.multiSelect ? ' box' : ''}`}>{on ? '✓' : ''}</span>
                    <span className="grow">
                      <span className="rt"><span className="rt-text">{o.label}</span></span>
                      {o.description && <span className="rm">{o.description}</span>}
                    </span>
                  </button>
                );
              })}
              <input
                className="q-other" type={q.secret ? 'password' : 'text'}
                value={other[key(q)] ?? ''} placeholder="Other…"
                onChange={(e) => setOther((cur) => ({ ...cur, [key(q)]: e.target.value }))}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="sheet-actions">
        <button className="primary" disabled={busy || !complete} onClick={() => onAnswer({ option: 'allow', answers })}>Answer</button>
      </div>
    </div>
  );
}
