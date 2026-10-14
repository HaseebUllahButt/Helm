import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Client, Mode, ModelList, ModelNote, Session, NativeControl } from '../client';
import { Icon, type IconName } from '../Icon';
import { modelRing, nextInRing } from './chatKeys';

/**
 * Mark a sideways-scrolling row while something is still out of sight past
 * its right edge, so the CSS can fade that edge instead of cutting a chip.
 */
const watchedRows = new WeakSet<HTMLElement>();
function fadeWhenCut(row: HTMLElement | null) {
  if (!row || watchedRows.has(row)) return;
  watchedRows.add(row);
  const check = () => row.toggleAttribute('data-more', row.scrollLeft + row.clientWidth < row.scrollWidth - 1);
  row.addEventListener('scroll', check, { passive: true });
  const watch = new ResizeObserver(check);
  watch.observe(row);
  new MutationObserver(check).observe(row, { childList: true, subtree: true, characterData: true });
  check();
}

/** One thing you can change while the agent is running. */
export interface Choice {
  id: string;
  label: string;
  hint?: string;
  danger?: boolean;
  /** A small picture before the label, such as an account's CLI logo. */
  icon?: ReactNode;
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
export function Controls({ options, session, busy, onPick, onFavs, onEffortFavs, onDefault, onNewsSeen, onNativeControl, defaultsFor = 'new chats' }: {
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
  /** The owner saw the "new model" note; it need not show again. */
  onNewsSeen?: () => void;
  defaultsFor?: string;
}) {
  const [open, setOpen] = useState<Kind | null>(null);
  const groups = groupsFor(options, session);
  const group = groups.find((g) => g.kind === open);
  const model = session.model || session.engineModel || options?.default || '';
  const effortFavs = (options?.effortFavs ?? []).flatMap((entry) => {
    try { const [m, effort] = JSON.parse(entry); return m === model && typeof effort === 'string' ? [effort] : []; }
    catch { return []; }
  });
  // The chat keys: one press, the next choice, applied exactly as a tap on
  // that row would be. A CLI that keeps the list to itself gets its own
  // picker opened instead, as its chip does.
  const step = (kind: 'model' | 'effort') => {
    if (busy) return;
    const g = groups.find((x) => x.kind === kind);
    if (!g) {
      if (options?.nativeControls?.includes(kind)) onNativeControl?.(kind);
      return;
    }
    const favs = options?.favs !== undefined && onFavs ? options.favs : favsOf(session.engine);
    const ring = kind === 'model'
      ? modelRing(g.choices.map((c) => c.id), (g.more ?? []).map((c) => c.id), favs)
      : g.choices.map((c) => c.id);
    const next = nextInRing(ring, g.current);
    if (next === undefined || next === g.current) return;
    setOpen(null);
    onPick(kind, next);
  };

  /**
   * Open a chip's sheet as if it were tapped - what typing `/model` does.
   * A CLI that keeps the list to itself gets its own picker. False when
   * this chat has no such control at all.
   */
  const show = (kind: Kind) => {
    if (groups.some((g) => g.kind === kind)) { setOpen(kind); return true; }
    if (options?.nativeControls?.includes(kind)) { onNativeControl?.(kind); return true; }
    return false;
  };

  return {
    step,
    show,
    /** Fold whatever sheet is open: another picker beside these took the slot. */
    close: () => setOpen(null),
    chips: (
      <span className="chips" ref={fadeWhenCut}>
        {groups.map((g) => (
          <button type="button"
            key={g.kind}
            className={`chip-pick${open === g.kind ? ' on' : ''}${g.danger ? ' danger' : ''}`}
            title={`${g.title}: ${g.currentLabel}`} aria-label={`${g.title}: ${g.currentLabel}`}
            onClick={() => setOpen(open === g.kind ? null : g.kind)}
          >
            {g.glyph && <i className={`cg ${g.kind}`}><Icon name={g.glyph} size={13} /></i>}
            <span className="chip-label">{g.currentLabel}</span>
          </button>
        ))}
        {(['model', 'effort', 'mode'] as const).filter(kind => !groups.some(g => g.kind === kind) && !options?.nativeControls?.includes(kind)).map(kind => {
          const value = kind === 'model' ? session.model || session.engineModel : kind === 'effort' ? session.effort || session.engineEffort : session.mode;
          if (!value) return null;
          const title = kind === 'effort' ? 'thinking' : kind === 'mode' ? 'permissions' : kind;
          const label = kind === 'model' ? shortModel(value, options?.labels, session.engine) : value;
          return <span key={`reported:${kind}`} className="chip-pick" title={`${title}: ${value} (reported by the CLI)`}><span className="chip-label">{label}</span></span>;
        })}
        {session.permissionControl === 'none' && <span className="chip-pick" title="This CLI has no built-in permission modes. Tool approvals belong to its extensions."><i className="cg mode"><Icon name="shield" size={13} /></i><span className="chip-label">extensions</span></span>}
        {(options?.nativeControls ?? []).filter(kind => !groups.some(g => g.kind === kind)).map(kind => {
          const title = kind === 'effort' ? 'thinking' : kind === 'mode' ? 'permissions' : kind;
          const glyph: IconName = kind === 'model' ? 'model' : kind === 'effort' ? 'effort' : kind === 'mode' ? 'shield' : kind === 'speed' ? 'bolt' : 'terminal';
          const value = kind === 'model' ? session.engineModel : kind === 'effort' ? session.engineEffort : kind === 'mode' ? session.mode : null;
          const label = kind === 'model' && value ? shortModel(value, options?.labels, session.engine) : value || title;
          return <button type="button" key={`native:${kind}`} className="chip-pick" disabled={busy}
            title={`Open ${title} in the CLI`} aria-label={`${title}: ${value ? `${label}; ` : ''}open CLI picker`}
            onClick={() => onNativeControl?.(kind)}><i className={`cg ${kind}`}><Icon name={glyph} size={13} /></i><span className="chip-label">{label}</span></button>;
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
        searchable={group.kind === 'model'}
        favKey={group.kind === 'model' ? session.engine : group.kind === 'effort' ? `${session.engine}:effort:${model}` : undefined}
        favs={group.kind === 'model' ? options?.favs : group.kind === 'effort' && options?.effortFavs !== undefined ? effortFavs : undefined}
        onFavs={group.kind === 'model' ? onFavs : group.kind === 'effort' && onEffortFavs ? (next) => onEffortFavs(model, next) : undefined}
        onDefault={onDefault && group.saved !== undefined ? (id) => onDefault(group.kind, id) : undefined}
        defaultsFor={defaultsFor}
        news={group.kind === 'model' ? options?.news : undefined}
        onNewsSeen={group.kind === 'model' ? onNewsSeen : undefined}
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
          // This copy of the list may be older than the machine's.
          keepApproved: true,
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
  // The note is for one look: gone from this screen now, from the machine in a moment.
  const onNewsSeen = profileId ? () => {
    setOptions((now) => now && { ...now, news: [] });
    client.rpc(env, 'model.news', { profileId }, 15_000).catch(() => { /* it shows once more, no harm */ });
  } : undefined;
  return { onFavs, onEffortFavs, onDefault, onNewsSeen };
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

  // Only concrete thinking levels. Some CLIs include a `default` reset
  // sentinel in their catalog; it is not another level to pick or favorite.
  const offeredEfforts = (options.effortsByModel?.[model] ?? options.efforts ?? []).filter((e) => e !== 'default');
  const reportedEffort = session.effort || session.engineEffort;
  const efforts = reportedEffort && reportedEffort !== 'default' && !offeredEfforts.includes(reportedEffort) ? [reportedEffort, ...offeredEfforts] : offeredEfforts;
  if (offeredEfforts.length) {
    const effort = [session.effort, session.engineEffort, options.effort].find((value) => value && efforts.includes(value)) || '';
    out.push({
      kind: 'effort',
      title: 'thinking',
      glyph: 'effort',
      note: session.nativeChat && session.engine === 'claude'
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
      saved: session.permissionControl === 'bash-guard' ? undefined : options.defaults?.mode ?? options.defaultMode ?? null,
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

export function ChoiceSheet({ title, note, choices, more = [], current, saved, busy, searchable, favKey, favs: shared, onFavs, onDefault, news, onNewsSeen, onPick, onClose, footer, defaultsFor = 'new chats' }: {
  title: string; note?: string; choices: Choice[]; more?: Choice[]; current: string;
  /** A long list gets a search box even when nothing is folded away. */
  searchable?: boolean;
  saved?: string | null;
  busy?: boolean; onPick: (id: string) => void; onClose: () => void;
  /** Favorite models sit at the top, per engine. */
  favKey?: string;
  /** Machine favorites, falling back to this browser on older machines. */
  favs?: string[];
  onFavs?: (next: string[]) => void;
  onDefault?: (id: string) => Promise<void> | void;
  news?: ModelNote[];
  onNewsSeen?: () => void;
  /** A quiet line under the rows, for an action that is not a choice. */
  footer?: ReactNode;
  defaultsFor?: string;
}) {
  // Seeing the sheet is seeing the note: closing it, any way, retires it.
  const latest = useRef({ news, onNewsSeen });
  latest.current = { news, onNewsSeen };
  useEffect(() => () => { if (latest.current.news?.length) latest.current.onNewsSeen?.(); }, []);
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
      <button type="button"
        key={c.id || 'default'} role="option" aria-selected={on} disabled={busy}
        className={`moderow${on ? ' on' : ''}${c.danger ? ' danger' : ''}${armed ? ' armed' : ''}`}
        onClick={() => choose(c)}
      >
        {c.icon}
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
        {onDefault && <button type="button"
          className={`picker-default${isDefault ? ' on' : ''}`} aria-pressed={isDefault}
          aria-label={isDefault ? `${c.label} is the default for ${defaultsFor}` : `Use ${c.label} by default for ${defaultsFor}`}
          title={isDefault ? `Default for ${defaultsFor}` : `Set as default for ${defaultsFor}`}
          disabled={saving !== null}
          aria-busy={saving === c.id}
          onClick={(e) => { e.stopPropagation(); void makeDefault(c.id); }}
        >{isDefault ? 'Default' : 'Set default'}</button>}
      </div>
    );
  };
  const search = more.length > 0 || (!!searchable && choices.length > 6);
  const sheet = useRef<HTMLDivElement>(null);
  const filter = useRef<HTMLInputElement>(null);
  // With a keyboard the sheet takes focus, so typing searches and the arrows
  // move; on a touch screen it does not, or the phone's keyboard would cover
  // the list it was opened to show.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
      const box = sheet.current;
      (filter.current ?? box?.querySelector<HTMLElement>('button.moderow[aria-selected="true"]') ?? box?.querySelector<HTMLElement>('button.moderow'))?.focus();
    }
    return () => {
      // Back to the composer (or the chip) once the sheet goes.
      const left = document.activeElement;
      if (opener?.isConnected && (!left || left === document.body || !left.isConnected)) opener.focus();
    };
  }, []);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const box = sheet.current;
    if (!box || e.nativeEvent.isComposing) return;
    const inFilter = e.target === filter.current;
    const rows = [...box.querySelectorAll<HTMLElement>('button.moderow:not(:disabled)')];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation(); onClose();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!rows.length) return;
      e.preventDefault(); e.stopPropagation();
      const down = e.key === 'ArrowDown';
      if (inFilter) rows[down ? 0 : rows.length - 1].focus();
      else if (!down && at === 0 && filter.current) filter.current.focus();
      else rows[at < 0 ? 0 : (at + (down ? 1 : rows.length - 1)) % rows.length].focus();
    } else if (e.key === 'Enter' && inFilter) {
      // The first match is the one the owner is looking at.
      e.preventDefault(); e.stopPropagation();
      rows[0]?.click();
    } else if (!inFilter && filter.current && e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // A letter typed on a row starts a search; the key lands in the box.
      e.stopPropagation();
      filter.current.focus();
    }
  };
  return (
    <div className="modesheet" role="listbox" aria-label={title} ref={sheet} onKeyDown={onKey}>
      <div className="modesheet-head">
        <span>{title}</span>
        <button type="button" className="x" onClick={onClose} aria-label="close"><Icon name="close" size={14} /></button>
      </div>
      {note && <div className="modesheet-note">{note}</div>}
      {!!news?.length && <ModelNews news={news} onSeen={onNewsSeen} />}
      {onDefault && <div className="modesheet-legend">Defaults apply to {defaultsFor}{favKey && <span><Icon name="star" size={13} /> favorites only</span>}</div>}
      {search && (
        <input
          ref={filter} aria-label={`Search ${title}`}
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
        <button type="button" className="moderow more" onClick={() => setExpanded(true)}>
          <span className="grow">
            <span className="rt">{rest.length} more</span>
            <span className="rm">everything else the account offers</span>
          </span>
          <span className="chev">›</span>
        </button>
      ))}
      {q && !favorites.length && !main.length && !rest.length && <div className="modesheet-note">no matches</div>}
      {saveError && <div className="error" role="alert">{saveError}</div>}
      {footer}
    </div>
  );
}

/** What joined by itself, in a few calm words: "New: Claude Opus 6 - now your default". */
export const newsLines = (news: ModelNote[]) => {
  const lines = news.slice(0, 3).map((n) => `New: ${n.label}${n.isDefault ? ' \u2014 now your default' : ''}`);
  return news.length > 3 ? [...lines, `and ${news.length - 3} more`] : lines;
};

function ModelNews({ news, onSeen }: { news: ModelNote[]; onSeen?: () => void }) {
  return (
    <div className="model-news" role="status">
      <span className="grow">{newsLines(news).map((l) => <span key={l}>{l}</span>)}</span>
      {onSeen && <button type="button" onClick={onSeen}>OK</button>}
    </div>
  );
}
