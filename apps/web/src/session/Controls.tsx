import { useState } from 'react';
import type { Mode, ModelList, Session } from '../client';

/** One thing you can change while the agent is running. */
export interface Choice {
  id: string;
  label: string;
  hint?: string;
  danger?: boolean;
}

/**
 * The row of chips above the keyboard, and the sheet each one opens.
 *
 * Everything that used to be decided once on a start screen lives here
 * instead: the model, how hard it thinks, how much it may do without asking,
 * and - for codex - whether to spend plan usage on the fast tier. A session
 * is a place you are, not a form you filled in, so all of it changes
 * mid-conversation and the next message uses it.
 *
 * The sheet docks in the same slot a permission prompt uses, because that is
 * where your eyes already are.
 */
export function Controls({ options, session, busy, onPick }: {
  options: ModelList | null;
  session: Session;
  busy?: boolean;
  onPick: (kind: Kind, id: string) => void;
}) {
  const [open, setOpen] = useState<Kind | null>(null);
  const groups = groupsFor(options, session);
  const group = groups.find((g) => g.kind === open);

  return {
    chips: (
      <span className="chips">
        {groups.map((g) => (
          <button
            key={g.kind}
            className={`chip-pick${open === g.kind ? ' on' : ''}${g.danger ? ' danger' : ''}`}
            title={`${g.title}: ${g.currentLabel}`}
            onClick={() => setOpen(open === g.kind ? null : g.kind)}
          >
            {g.glyph && <i className={`cg ${g.kind}`}>{g.glyph}</i>}
            {g.currentLabel}
          </button>
        ))}
      </span>
    ),
    sheet: group ? (
      <ChoiceSheet
        title={group.title}
        note={group.note}
        choices={group.choices}
        more={group.more}
        current={group.current}
        busy={busy}
        onClose={() => setOpen(null)}
        onPick={(id) => { setOpen(null); onPick(group.kind, id); }}
      />
    ) : null,
  };
}

export type Kind = 'model' | 'effort' | 'mode' | 'speed';

interface Group {
  kind: Kind;
  title: string;
  glyph?: string;
  note?: string;
  choices: Choice[];
  /** The long tail the account's approved list hides - one tap away, not offered first. */
  more?: Choice[];
  current: string;
  currentLabel: string;
  danger?: boolean;
}

/** The short word a chip shows, so four of them fit on a phone. */
const shortModel = (slug: string, labels?: Record<string, string>, engine?: string) => {
  const name = labels?.[slug] ?? slug;
  // devin bakes the thinking tier into the model's name ("SWE-2 Max") and
  // opencode puts the provider first ("OpenCode Go/Kimi K2.7") - for both,
  // the last word is a tier or a suffix, not the model, so the chip is the
  // whole name minus a "provider/" prefix.
  if (engine === 'devin' || engine === 'opencode' || engine === 'opencode2') return name.replace(/^[^/]+\//, '');
  // "GPT-5.6-Luna" -> "Luna"; "claude-fable-5-1" -> "fable"
  const tail = name.split(/[-\s]/).filter(Boolean).pop() ?? name;
  return /^\d/.test(tail) ? name.replace(/^(gpt|claude)[-\s]?/i, '') : tail.toLowerCase();
};

function groupsFor(options: ModelList | null, session: Session): Group[] {
  const out: Group[] = [];
  if (!options) return out;
  // What is actually running: what the owner picked, else what the CLI said
  // it started with, else the account default. Only if all three are silent
  // does the chip have nothing to name.
  const model = session.model || session.engineModel || options.default || '';

  if (options.models.length || options.more?.length) {
    const choice = (m: string): Choice => ({
      id: m,
      label: options.labels?.[m] ?? m,
      hint: m === options.default ? 'the default' : undefined,
    });
    const choices = options.models.map(choice);
    const more = (options.more ?? []).map(choice);
    // A model the CLI reported but that is in neither list is still the one
    // in use, so it belongs in the list rather than being unselectable.
    if (model && !choices.some((c) => c.id === model) && !more.some((c) => c.id === model)) {
      choices.unshift({ id: model, label: options.labels?.[model] ?? model, hint: 'in use now' });
    }
    out.push({
      kind: 'model',
      title: 'model',
      glyph: '◆',
      choices,
      more,
      current: model,
      currentLabel: model ? shortModel(model, options.labels, session.engine) : 'default',
    });
  }

  // Only the levels this model actually offers.
  const efforts = options.effortsByModel?.[model] ?? options.efforts ?? [];
  if (efforts.length) {
    out.push({
      kind: 'effort',
      title: 'thinking',
      glyph: '◇',
      note: 'How long it reasons before answering. More is slower and costs more.',
      choices: efforts.map((e) => ({ id: e, label: e })),
      current: session.effort || session.engineEffort || options.effort || '',
      currentLabel: session.effort || session.engineEffort || options.effort || 'default',
    });
  }

  const modes = options.modes ?? [];
  if (modes.length) {
    const current = modes.find((m: Mode) => m.id === session.mode) ?? modes[0];
    out.push({
      kind: 'mode',
      title: 'permissions',
      glyph: '⦿',
      choices: modes.map((m) => ({ id: m.id, label: m.label, hint: m.hint, danger: m.danger })),
      current: current?.id ?? '',
      currentLabel: current?.short ?? current?.label ?? 'mode',
      danger: current?.danger,
    });
  }

  // codex's service tier: a plain on/off, because there is only ever one.
  const speeds = options.speedByModel?.[model] ?? options.speeds ?? [];
  if (speeds.length) {
    out.push({
      kind: 'speed',
      title: 'speed',
      glyph: '⚡',
      note: 'The fast tier answers sooner and uses more of your plan.',
      choices: [
        { id: '', label: 'Normal', hint: 'the usual tier' },
        ...speeds.map((s) => ({ id: s, label: cap(s), hint: 'sooner, more plan usage' })),
      ],
      current: session.speed || '',
      currentLabel: session.speed ? cap(session.speed) : 'normal',
    });
  }
  return out;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A dangerous choice arms on the first tap and commits on the second.
 *
 * `more` is the model sheet's overflow: an account can approve a short list
 * for everyday use, and the rest of what the CLI offers sits behind one row -
 * or one search - rather than being hidden entirely.
 */
function ChoiceSheet({ title, note, choices, more = [], current, busy, onPick, onClose }: {
  title: string; note?: string; choices: Choice[]; more?: Choice[]; current: string;
  busy?: boolean; onPick: (id: string) => void; onClose: () => void;
}) {
  const [arming, setArming] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const match = (c: Choice) =>
    !q || c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q);
  const main = choices.filter(match);
  const rest = more.filter(match);
  const choose = (c: Choice) => {
    if (c.id === current) return onClose();
    if (c.danger && arming !== c.id) return setArming(c.id);
    onPick(c.id);
  };
  const row = (c: Choice) => {
    const on = c.id === current;
    const armed = arming === c.id;
    return (
      <button
        key={c.id || 'default'} role="option" aria-selected={on} disabled={busy}
        className={`moderow${on ? ' on' : ''}${c.danger ? ' danger' : ''}${armed ? ' armed' : ''}`}
        onClick={() => choose(c)}
      >
        <span className="grow">
          <span className="rt"><span className="rt-text">{c.label}</span></span>
          {(armed || c.hint) && <span className="rm">{armed ? 'Tap again to confirm' : c.hint}</span>}
        </span>
        {on && <span className="check">✓</span>}
      </button>
    );
  };
  return (
    <div className="modesheet" role="listbox" aria-label={title}>
      <div className="modesheet-head">
        <span>{title}</span>
        <button className="x" onClick={onClose} aria-label="close">✕</button>
      </div>
      {note && <div className="modesheet-note">{note}</div>}
      {more.length > 0 && (
        <input
          className="sheetfilter" value={query} placeholder="search all models"
          autoCapitalize="off" autoCorrect="off" autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      {main.map(row)}
      {rest.length > 0 && (q || expanded ? rest.map(row) : (
        <button className="moderow more" onClick={() => setExpanded(true)}>
          <span className="grow">
            <span className="rt">{rest.length} more</span>
            <span className="rm">everything else the account offers</span>
          </span>
          <span className="chev">›</span>
        </button>
      ))}
      {q && !main.length && !rest.length && <div className="modesheet-note">no matches</div>}
    </div>
  );
}
