import { useEffect, useState } from 'react';
import type { Client, Mode, ModelList, Session, NativeControl } from '../client';
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
export function Controls({ options, session, busy, onPick, onFavs, onEffortFavs, onDefault, onNativeControl }: {
  options: ModelList | null;
  onNativeControl?: (kind: NativeControl) => void;
  session: Session;
  busy?: boolean;
  onPick: (kind: Kind, id: string) => void;
  /** Save favorite models on the machine, so every device shows the same list. */
  onFavs?: (next: string[]) => void;
  /** Favorites for the current model's thinking levels. */
  onEffortFavs?: (model: string, next: string[]) => void;
  /** Make a choice what new chats on this account start with. */
  onDefault?: (kind: Kind, id: string) => Promise<void> | void;
}) {
  const [open, setOpen] = useState<Kind | null>(null);
  const groups = groupsFor(options, session);
  const group = groups.find((g) => g.kind === open);
  const model = session.model || session.engineModel || options?.default || '';
  const effortFavs = (options?.effortFavs ?? []).flatMap((entry) => {
    try { const [m, effort] = JSON.parse(entry); return m === model && typeof effort === 'string' ? [effort] : []; }
    catch { return []; }
  });

  return {
    chips: (
      <span className="chips">
        {groups.map((g) => (
          <button
            key={g.kind}
            className={`chip-pick${open === g.kind ? ' on' : ''}${g.danger ? ' danger' : ''}`}
            title={`${g.title}: ${g.currentLabel}`} aria-label={`${g.title}: ${g.currentLabel}`}
            onClick={() => setOpen(open === g.kind ? null : g.kind)}
          >
            {g.glyph && <i className={`cg ${g.kind}`}><Icon name={g.glyph} size={13} /></i>}
            <span className="chip-label">{g.currentLabel}</span>
          </button>
        ))}
        {(options?.nativeControls ?? []).map(kind => {
          const title = kind === 'effort' ? 'thinking' : kind === 'mode' ? 'permissions' : kind;
          const glyph: IconName = kind === 'model' ? 'model' : kind === 'effort' ? 'effort' : kind === 'mode' ? 'shield' : kind === 'speed' ? 'bolt' : 'terminal';
          return <button key={`native:${kind}`} className="chip-pick" disabled={busy}
            title={`Open ${title} in the CLI`} aria-label={`${title}: open CLI picker`}
            onClick={() => onNativeControl?.(kind)}><i className={`cg ${kind}`}><Icon name={glyph} size={13} /></i><span className="chip-label">{title}</span></button>;
        })}
      </span>
    ),
    sheet: group ? (
      <ChoiceSheet
        key={`${group.kind}:${session.engine}${group.kind === 'effort' ? `:${model}` : ''}`}
        title={group.title}
        note={group.note}
        choices={group.choices}
        more={group.more}
        current={group.current}
        saved={group.saved}
        busy={busy}
        favKey={group.kind === 'model' ? session.engine : group.kind === 'effort' ? `${session.engine}:effort:${model}` : undefined}
        favs={group.kind === 'model' ? options?.favs : group.kind === 'effort' && options?.effortFavs !== undefined ? effortFavs : undefined}
        onFavs={group.kind === 'model' ? onFavs : group.kind === 'effort' && onEffortFavs ? (next) => onEffortFavs(model, next) : undefined}
        onDefault={onDefault && group.saved !== undefined ? (id) => onDefault(group.kind, id) : undefined}
        onClose={() => setOpen(null)}
        onPick={(id) => { setOpen(null); onPick(group.kind, id); }}
      />
    ) : null,
  };
}

export type Kind = 'model' | 'effort' | 'mode' | 'speed';

/**
 * Favorites and new-chat defaults live on the machine, so a phone and a
 * laptop open the same picker - and every chat's tray, Helm's own or one
 * taken over from a terminal, saves them the same way. Older machines answer
 * without `favs`, and the sheet falls back to this browser's own favorites.
 */
export function trayPrefs({ client, env, engine, profileId, options, setOptions, setError }: {
  client: Client; env: string; engine: string; profileId?: string | null;
  options: ModelList | null;
  setOptions: (update: (now: ModelList | null) => ModelList | null) => void;
  setError: (message: string) => void;
}) {
  const onFavs = (next: string[]) => {
    setOptions((now) => now && { ...now, favs: next });
    client.rpc(env, 'picker.prefs', { favs: { [engine]: next } }, 15_000).catch((e) => setError(e.message));
  };
  const onEffortFavs = (model: string, next: string[]) => {
    const others = (options?.effortFavs ?? []).filter((entry) => {
      try { return JSON.parse(entry)[0] !== model; } catch { return false; }
    });
    const effortFavs = [...others, ...next.map((effort) => JSON.stringify([model, effort]))];
    setOptions((now) => now && { ...now, effortFavs });
    client.rpc(env, 'picker.prefs', { favs: { [`${engine}-effort`]: effortFavs } }, 15_000).catch((e) => setError(e.message));
  };
  const onDefault = profileId ? async (kind: Kind, value: string) => {
    if (!options) return;
    setError('');
    try {
      if (kind === 'model') {
        const r: any = await client.rpc(env, 'model.prefs', {
          profileId, default: value, approved: options.prefs?.approved ?? [],
        }, 15_000);
        setOptions((now) => now && { ...now, prefs: r.prefs });
      } else {
        const r: any = await client.rpc(env, 'profile.defaults', {
          profileId, ...(options.defaults ?? {}), [kind]: value,
        }, 15_000);
        setOptions((now) => now && { ...now, defaults: r.defaults });
      }
    } catch (e: any) { setError(e.message); throw e; }
  } : undefined;
  return { onFavs, onEffortFavs, onDefault };
}

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
      saved: options.prefs?.default ?? options.default ?? null,
    });
  }

  // Only the levels this model actually offers.
  const efforts = options.effortsByModel?.[model] ?? options.efforts ?? [];
  if (efforts.length) {
    const effort = [session.effort, session.engineEffort, options.effort].find((value) => value && efforts.includes(value)) || '';
    out.push({
      kind: 'effort',
      title: 'thinking',
      glyph: 'effort',
      note: session.nativeChat
        ? "How long it reasons before answering. Claude also saves this as the model's default for future chats."
        : 'How long it reasons before answering. More is slower and costs more.',
      choices: efforts.map((e) => ({ id: e, label: e })),
      current: effort,
      currentLabel: effort || 'think',
      saved: options.defaults?.effort ?? null,
    });
  }

  const modes = (options.modes ?? []).filter((m) => m.id !== 'plan');
  if (modes.length) {
    // A terminal Claude's mode is whatever it last said; until it says,
    // the chip does not guess.
    const current = modes.find((m: Mode) => m.id === session.mode)
      ?? (session.nativeCli || session.nativeChat ? undefined
        : modes.find((m) => m.id === options.defaultMode)
          ?? modes.find((m) => m.short === 'yolo') ?? modes[0]);
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
  /** Favorite models sit at the top, per engine. */
  favKey?: string;
  /** Machine favorites, falling back to this browser on older machines. */
  favs?: string[];
  onFavs?: (next: string[]) => void;
  onDefault?: (id: string) => Promise<void> | void;
}) {
  const machineFavs = shared !== undefined && !!onFavs;
  const [favs, setFavs] = useState<string[]>(() => (favKey ? (machineFavs ? shared! : favsOf(favKey)) : []));
  useEffect(() => {
    if (machineFavs) setFavs(shared!);
  }, [machineFavs, shared]);
  const toggleFav = (id: string) => {
    if (!favKey) return;
    const next = favs.includes(id) ? favs.filter((f) => f !== id) : [...favs, id];
    setFavs(next);
    if (machineFavs) onFavs!(next);
    else try { localStorage.setItem(`helm.favmodels:${favKey}`, JSON.stringify(next)); } catch { /* full */ }
  };
  const [saving, setSaving] = useState<string | null>(null);
  const [saveError, setSaveError] = useState('');
  const makeDefault = async (id: string) => {
    if (!onDefault || saving !== null || id === saved) return;
    setSaving(id);
    setSaveError('');
    try { await onDefault(id); }
    catch (e) { setSaveError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(null); }
  };
  const [arming, setArming] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const match = (c: Choice) =>
    !q || c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q);
  // A favorite model is lifted out of whichever list it was in, so it is one
  // tap away even when the account's long tail is folded.
  const favorites = favKey ? [...choices, ...more].filter((c) => favs.includes(c.id) && match(c)) : [];
  const main = choices.filter(match).filter((c) => !favorites.includes(c));
  const rest = more.filter(match).filter((c) => !favorites.includes(c));
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
          <span className="rt"><span className="rt-text">{c.label}</span></span>
          {(armed || c.hint) && <span className="rm">{armed ? 'Tap again to confirm' : c.hint}</span>}
        </span>
        {on && <span className="check"><Icon name="check" size={16} /></span>}
      </button>
    );
    if (!favKey && !onDefault) return button;
    const fav = favs.includes(c.id);
    const isDefault = c.id === saved;
    return (
      <div className="rowfav" key={c.id || 'normal'}>
        {button}
        {favKey && c.id && <label className={`favorite-toggle${fav ? ' on' : ''}`} title={fav ? 'Remove favorite' : 'Add favorite'} onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={fav}
            aria-label={`Favorite ${c.label}`} onChange={() => toggleFav(c.id)} />
          <Icon name={fav ? 'star-on' : 'star'} size={17} />
        </label>}
        {onDefault && <button
          className={`picker-default${isDefault ? ' on' : ''}`} aria-pressed={isDefault}
          aria-label={isDefault ? `${c.label} is the default for new chats` : `Use ${c.label} by default for new chats`}
          title={isDefault ? 'Default for new chats' : 'Set as default for new chats'}
          disabled={saving !== null}
          aria-busy={saving === c.id}
          onClick={(e) => { e.stopPropagation(); void makeDefault(c.id); }}
        >{isDefault ? 'Default' : 'Set default'}</button>}
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
      {onDefault && <div className="modesheet-legend">Defaults apply to new chats{favKey && <span><Icon name="star" size={13} /> favorites only</span>}</div>}
      {more.length > 0 && (
        <input
          className="sheetfilter" value={query} placeholder="search all models"
          autoCapitalize="off" autoCorrect="off" autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      {favorites.length > 0 && <div className="modesheet-label">favorites</div>}
      {favorites.map(row)}
      {favorites.length > 0 && main.length > 0 && <div className="modesheet-label">all</div>}
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
      {q && !favorites.length && !main.length && !rest.length && <div className="modesheet-note">no matches</div>}
      {saveError && <div className="error" role="alert">{saveError}</div>}
    </div>
  );
}
