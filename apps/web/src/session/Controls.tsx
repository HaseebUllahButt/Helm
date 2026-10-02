import { useState } from 'react';
import type { Mode, ModelList, Session } from '../client';
import { Icon, type IconName } from '../Icon';

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
export function Controls({ options, session, busy, onPick, onFavs, onDefault }: {
  options: ModelList | null;
  session: Session;
  busy?: boolean;
  onPick: (kind: Kind, id: string) => void;
  /** Save the starred models on the machine, so every device shows the same stars. */
  onFavs?: (next: string[]) => void;
  /** Make a choice what new chats on this account start with. */
  onDefault?: (kind: Kind, id: string) => Promise<void> | void;
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
            {g.glyph && <i className={`cg ${g.kind}`}><Icon name={g.glyph} size={13} /></i>}
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
        saved={group.saved}
        busy={busy}
        favKey={group.kind === 'model' ? session.engine : undefined}
        favs={group.kind === 'model' ? options?.favs : undefined}
        onFavs={onFavs}
        onDefault={onDefault && group.saved !== undefined ? (id) => onDefault(group.kind, id) : undefined}
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
  glyph?: IconName;
  note?: string;
  choices: Choice[];
  /** The long tail the account's approved list hides - one tap away, not offered first. */
  more?: Choice[];
  current: string;
  currentLabel: string;
  danger?: boolean;
  /** What new chats on this account start with; undefined when it cannot be set. */
  saved?: string | null;
}

/** The short word a chip shows, so four of them fit on a phone. */
const shortModel = (slug: string, labels?: Record<string, string>, engine?: string) => {
  const name = labels?.[slug] ?? slug;
  // devin bakes the thinking tier into the model's name ("SWE-2 Max") and
  // opencode puts the provider first ("OpenCode Go/Kimi K2.7") - pi, omp and
  // grok do the same with "provider/" selectors, and antigravity's labels
  // already carry their tier ("Gemini 3.8 Flash (High)") - so the chip is
  // the whole name minus a "provider/" prefix.
  if (['devin', 'opencode', 'opencode2', 'pi', 'omp', 'grok', 'antigravity'].includes(engine ?? '')) return name.replace(/^[^/]+\//, '');
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
      // A saved default is tagged "new chats" on its row instead.
      hint: m === options.default && !options.prefs?.default ? 'the default' : undefined,
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
      glyph: 'model',
      choices,
      more,
      current: model,
      currentLabel: model ? shortModel(model, options.labels, session.engine) : 'model',
      saved: options.prefs?.default ?? null,
    });
  }

  // Only the levels this model actually offers.
  const efforts = options.effortsByModel?.[model] ?? options.efforts ?? [];
  if (efforts.length) {
    out.push({
      kind: 'effort',
      title: 'thinking',
      glyph: 'effort',
      note: 'How long it reasons before answering. More is slower and costs more.',
      choices: efforts.map((e) => ({ id: e, label: e })),
      current: session.effort || session.engineEffort || options.effort || '',
      currentLabel: session.effort || session.engineEffort || options.effort || 'think',
      saved: options.defaults?.effort ?? null,
    });
  }

  const modes = (options.modes ?? []).filter((m) => m.id !== 'plan');
  if (modes.length) {
    const current = modes.find((m: Mode) => m.id === session.mode)
      ?? modes.find((m) => m.id === options.defaultMode)
      ?? modes.find((m) => m.short === 'yolo') ?? modes[0];
    out.push({
      kind: 'mode',
      title: 'permissions',
      glyph: 'shield',
      choices: modes.map((m) => ({ id: m.id, label: m.label, hint: m.hint, danger: m.danger })),
      current: current?.id ?? '',
      currentLabel: current?.short ?? current?.label ?? 'mode',
      danger: current?.danger,
      saved: options.defaults?.mode ?? options.defaultMode ?? null,
    });
  }

  // codex's service tier: a plain on/off, because there is only ever one.
  const speeds = options.speedByModel?.[model] ?? options.speeds ?? [];
  if (speeds.length) {
    out.push({
      kind: 'speed',
      title: 'speed',
      glyph: 'bolt',
      note: 'The fast tier answers sooner and uses more of your plan.',
      choices: [
        { id: '', label: 'Normal', hint: 'the usual tier' },
        ...speeds.map((s) => ({ id: s, label: cap(s), hint: 'sooner, more plan usage' })),
      ],
      current: session.speed || '',
      currentLabel: session.speed ? cap(session.speed) : 'normal',
      saved: options.defaults?.speed ?? '',
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
const favsOf = (key: string): string[] => { try { return JSON.parse(localStorage.getItem(`helm.favmodels:${key}`) || '[]'); } catch { return []; } };

function ChoiceSheet({ title, note, choices, more = [], current, saved, busy, favKey, favs: shared, onFavs, onDefault, onPick, onClose }: {
  title: string; note?: string; choices: Choice[]; more?: Choice[]; current: string;
  saved?: string | null;
  busy?: boolean; onPick: (id: string) => void; onClose: () => void;
  /** Models can be starred, per engine: the ones you use sit at the top. */
  favKey?: string;
  /** The machine's stars. Undefined from a machine too old to keep them: this browser's then. */
  favs?: string[];
  onFavs?: (next: string[]) => void;
  onDefault?: (id: string) => Promise<void> | void;
}) {
  const machineFavs = shared !== undefined && !!onFavs;
  const [favs, setFavs] = useState<string[]>(() => (favKey ? (machineFavs ? shared! : favsOf(favKey)) : []));
  const toggleFav = (id: string) => {
    if (!favKey) return;
    const next = favs.includes(id) ? favs.filter((f) => f !== id) : [...favs, id];
    setFavs(next);
    if (machineFavs) onFavs!(next);
    else try { localStorage.setItem(`helm.favmodels:${favKey}`, JSON.stringify(next)); } catch { /* full */ }
  };
  const [saving, setSaving] = useState(false);
  const makeDefault = async () => {
    if (!onDefault) return;
    setSaving(true);
    try { await onDefault(current); } finally { setSaving(false); }
  };
  const currentChoice = [...choices, ...more].find((c) => c.id === current);
  const [arming, setArming] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const match = (c: Choice) =>
    !q || c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q);
  // A starred model is lifted out of whichever list it was in, so it is one
  // tap away even when the account's long tail is folded.
  const starred = favKey ? [...choices, ...more].filter((c) => favs.includes(c.id) && match(c)) : [];
  const main = choices.filter(match).filter((c) => !starred.includes(c));
  const rest = more.filter(match).filter((c) => !starred.includes(c));
  const choose = (c: Choice) => {
    if (c.id === current) return onClose();
    if (c.danger && arming !== c.id) return setArming(c.id);
    onPick(c.id);
  };
  const row = (c: Choice) => {
    const on = c.id === current;
    const armed = arming === c.id;
    const button = (
      <button
        key={c.id || 'default'} role="option" aria-selected={on} disabled={busy}
        className={`moderow${on ? ' on' : ''}${c.danger ? ' danger' : ''}${armed ? ' armed' : ''}`}
        onClick={() => choose(c)}
      >
        <span className="grow">
          <span className="rt"><span className="rt-text">{c.label}</span>
            {saved !== undefined && saved !== null && c.id === saved && <span className="tag">new chats</span>}</span>
          {(armed || c.hint) && <span className="rm">{armed ? 'Tap again to confirm' : c.hint}</span>}
        </span>
        {on && <span className="check"><Icon name="check" size={16} /></span>}
      </button>
    );
    if (!favKey || !c.id) return button;
    const fav = favs.includes(c.id);
    return (
      <div className="rowfav" key={c.id}>
        {button}
        <button
          className={`star${fav ? ' on' : ''}`} aria-pressed={fav}
          aria-label={fav ? `remove ${c.label} from favourites` : `add ${c.label} to favourites`}
          onClick={() => toggleFav(c.id)}
        ><Icon name={fav ? 'star-on' : 'star'} size={17} /></button>
      </div>
    );
  };
  return (
    <div className="modesheet" role="listbox" aria-label={title}>
      <div className="modesheet-head">
        <span>{title}</span>
        <button className="x" onClick={onClose} aria-label="close"><Icon name="close" size={14} /></button>
      </div>
      {note && <div className="modesheet-note">{note}</div>}
      {more.length > 0 && (
        <input
          className="sheetfilter" value={query} placeholder="search all models"
          autoCapitalize="off" autoCorrect="off" autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      {starred.length > 0 && <div className="modesheet-label">favourites</div>}
      {starred.map(row)}
      {starred.length > 0 && main.length > 0 && <div className="modesheet-label">all</div>}
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
      {onDefault && currentChoice && current !== (saved ?? '') && (
        <button className="setdefault" disabled={saving || busy} onClick={() => void makeDefault()}>
          <Icon name="check" size={14} />
          {saving ? 'Saving…' : <>Start new chats with <b>{currentChoice.label}</b></>}
        </button>
      )}
    </div>
  );
}
