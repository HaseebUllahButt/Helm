import { useDialog } from './useDialog';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { EngineMark } from './EngineMark';
import { Icon } from './Icon';
import type { Client, DirEntry, Environment, Project, Session } from './client';
import { accountsFrom, loadPrefs, recentFolders, rememberFolder, savePrefs, type Account, type PickerPrefs } from './accounts';

/**
 * A new chat without the mouse: machine, then folder, then CLI, in one box.
 *
 * Each step is a list you type into to narrow, move through with the arrows
 * and pick from with Enter. Backspace in an empty box steps back. The folder
 * step lists folders only - a new chat never continues an old one - and
 * opens the recent ones and the machine's projects first; typing searches
 * every folder on that machine, and → opens a folder to look inside it.
 */

type Step = 'machine' | 'folder' | 'cli';

interface Row {
  id: string;
  title: string;
  sub?: string;
  group?: string;
  engine?: string;
  icon?: 'machine' | 'folder' | 'repo';
  tag?: string;
  disabled?: boolean;
  /** A folder that can be opened with → to see what is inside. */
  into?: string;
  pick: () => void;
}

/** Every typed word has to be found somewhere in the row. */
const matches = (row: Row, q: string) => {
  const hay = `${row.title} ${row.sub ?? ''}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
};

const leaf = (p: string) => p.replace(/\/$/, '').split('/').pop() || p;
const parent = (p: string) => {
  const trimmed = p.replace(/\/$/, '');
  const i = trimmed.lastIndexOf('/');
  return i <= 0 ? (trimmed.startsWith('/') ? '/' : trimmed) : trimmed.slice(0, i);
};

export function NewChat({ client, envs, envId, near, onClose, onStarted, engineOf }: {
  client: Client;
  envs: Environment[];
  /** Start on this machine's folder step instead of asking which machine. */
  envId?: string | null;
  /** The machine on screen: asked about first, with the cursor already on it. */
  near?: string | null;
  onClose: () => void;
  onStarted: (envId: string, s: Session) => void;
  engineOf: (id?: string) => { label: string; cls: string };
}) {
  const dialog = useDialog(onClose);
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const startEnv = envId ? envs.find((e) => e.id === envId && e.online) : undefined;
  const [step, setStep] = useState<Step>(startEnv ? 'folder' : 'machine');
  const [machine, setMachine] = useState<Environment | null>(startEnv ?? null);
  const [folder, setFolder] = useState('');
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Folder step.
  const [projects, setProjects] = useState<Project[]>([]);
  const [home, setHome] = useState<DirEntry[] | null>(null);
  /** The folders opened with →, deepest last, each with what was typed
   * before opening it, so ⌫ returns to the same list. Empty is the suggestions. */
  const [trail, setTrail] = useState<{ path: string; q: string }[]>([]);
  const [inside, setInside] = useState<{ path: string; entries: DirEntry[] } | null>(null);
  const [hits, setHits] = useState<{ name: string; path: string; repo: boolean }[] | null>(null);

  // CLI step.
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [picker, setPicker] = useState<(PickerPrefs & { onMachine: boolean }) | null>(null);

  const go = (next: Step) => { setStep(next); setQ(''); setAt(0); setError(''); input.current?.focus(); };

  // What a machine offers is asked for the moment it is chosen, so the
  // folder list and the CLI list are usually there before they are needed.
  useEffect(() => {
    if (!machine) return;
    let stale = false;
    setProjects([]); setHome(null); setAccounts(null); setPicker(null); setTrail([]);
    client.rpc<{ projects: Project[] }>(machine.id, 'project.list', {}, 20_000)
      .then((r) => { if (!stale) setProjects(r.projects ?? []); }).catch(() => { /* recent folders still show */ });
    client.rpc<{ entries: DirEntry[] }>(machine.id, 'fs.list', { path: '~' })
      .then((r) => { if (!stale) setHome(r.entries); }).catch((e) => { if (!stale) { setHome([]); setError(e.message); } });
    client.rpc<any>(machine.id, 'profile.list')
      .then((r) => {
        if (stale) return;
        const local = loadPrefs()[machine.id];
        const prefs: PickerPrefs = r.picker ?? { hidden: local?.hidden ?? [], last: local?.account ?? null };
        setPicker({ ...prefs, onMachine: !!r.picker });
        setAccounts(accountsFrom(r.profiles));
      })
      .catch((e) => { if (!stale) { setAccounts([]); setError(e.message); } });
    return () => { stale = true; };
  }, [client, machine]);

  const here = trail.at(-1)?.path ?? null;
  useEffect(() => {
    if (!machine || !here) { setInside(null); return; }
    let stale = false;
    client.rpc<{ path: string; entries: DirEntry[] }>(machine.id, 'fs.list', { path: here })
      .then((r) => { if (!stale) setInside({ path: r.path, entries: r.entries }); })
      .catch((e) => { if (!stale) setError(e.message); });
    return () => { stale = true; };
  }, [client, machine, here]);

  // Typing in the suggestions searches the whole machine, from its index.
  const query = q.trim();
  const searching = step === 'folder' && !here && !!query;
  useEffect(() => {
    if (!searching || !machine) { setHits(null); return; }
    setHits(null);
    const t = setTimeout(() => {
      client.rpc<any>(machine.id, 'fs.search', { query }, 20_000)
        .then((r) => setHits(r.results ?? []))
        .catch((e) => { setHits([]); setError(e.message); });
    }, 200);
    return () => clearTimeout(t);
  }, [searching, query, client, machine]);

  const pickFolder = (path: string) => { setFolder(path); go('cli'); };

  const start = async (a: Account) => {
    if (!machine || busy) return;
    setBusy(true); setError('');
    rememberFolder(machine.id, folder);
    if (picker?.onMachine) client.rpc(machine.id, 'picker.prefs', { last: a.key }, 15_000).catch(() => { /* only a default */ });
    else {
      const prefs = loadPrefs();
      savePrefs({ ...prefs, [machine.id]: { ...prefs[machine.id], account: a.key } });
    }
    try {
      const r = await client.rpc<{ session: Session }>(machine.id, 'session.start', {
        cwd: folder, profileId: a.profile.id,
        model: a.prefs?.default || undefined,
        effort: a.defaults?.effort || undefined,
        mode: a.defaults?.mode && a.defaults.mode !== 'plan' ? a.defaults.mode : undefined,
        speed: a.defaults?.speed || undefined,
      }, 70_000);
      onClose();
      onStarted(machine.id, r.session);
    } catch (e: any) { setError(e.message); setBusy(false); }
  };

  const rows = useMemo((): Row[] => {
    if (step === 'machine') {
      const all = envs.map((e): Row => ({
        id: e.id, title: e.name, icon: 'machine', sub: e.online ? 'online' : 'offline', disabled: !e.online,
        pick: () => { if (machine?.id !== e.id) setMachine(e); go('folder'); },
      }));
      // Online first; offline ones stay visible so a missing machine is explained.
      return all.filter((r) => matches(r, query)).sort((a, b) => Number(!!a.disabled) - Number(!!b.disabled));
    }
    if (step === 'folder') {
      const folderRow = (path: string, group: string, repo = false, title = leaf(path)): Row => ({
        id: `${group}:${path}`, title, sub: path, group, icon: repo ? 'repo' : 'folder', into: path, pick: () => pickFolder(path),
      });
      if (here) {
        const at = inside?.path ?? here;
        const subs = (inside?.entries ?? []).filter((e) => !query || e.name.toLowerCase().includes(query.toLowerCase()));
        return [
          ...(query ? [] : [{ ...folderRow(at, 'this folder'), title: `Start in ${leaf(at)}`, into: undefined }]),
          ...subs.map((e) => folderRow(e.path, 'inside', e.isRepo, e.name)),
        ];
      }
      if (searching) return (hits ?? []).map((h) => folderRow(h.path, 'found', h.repo, h.name));
      const seen = new Set<string>();
      const once = (r: Row) => { if (seen.has(r.sub!)) return false; seen.add(r.sub!); return true; };
      return [
        ...recentFolders(machine?.id ?? '').slice(0, 5).map((p) => folderRow(p, 'recent')),
        ...projects.map((p) => folderRow(p.path, 'projects', true, p.title || leaf(p.path))),
        ...(home ?? []).map((e) => folderRow(e.path, 'home', e.isRepo, e.name)),
      ].filter(once);
    }
    const hidden = new Set(picker?.hidden ?? []);
    const shown = (accounts ?? []).filter((a) => !hidden.has(a.key));
    const twins = new Set(shown.map((a) => `${a.engine}|${a.account}`).filter((k, i, all) => all.indexOf(k) !== i));
    // The machine's chosen default first, then the last one used, so Enter
    // straight away starts what you would have picked.
    const first = shown.find((a) => a.key === picker?.agent) ?? shown.find((a) => a.key === picker?.last);
    const ordered = first ? [first, ...shown.filter((a) => a !== first)] : shown;
    return ordered.map((a): Row => ({
      id: a.key, engine: a.engine, title: engineOf(a.engine).label,
      sub: twins.has(`${a.engine}|${a.account}`) ? `${a.account} (${a.profile.id})` : a.account,
      tag: a.key === picker?.agent ? 'default' : a.key === picker?.last ? 'last used' : undefined,
      pick: () => void start(a),
    })).filter((r) => matches(r, query));
  }, [step, envs, machine, query, here, inside, searching, hits, projects, home, accounts, picker, folder, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  // On the machine step the one you are on is where the cursor starts.
  useEffect(() => {
    if (step !== 'machine' || query) return;
    const i = rows.findIndex((r) => r.id === (machine?.id ?? near) && !r.disabled);
    setAt(i >= 0 ? i : 0);
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = Math.max(0, Math.min(at, rows.length - 1));
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, rows]);

  const move = (by: number) => {
    if (!rows.length) return;
    let i = selected;
    for (let n = 0; n < rows.length; n++) {
      i = (i + by + rows.length) % rows.length;
      if (!rows[i].disabled) break;
    }
    setAt(i);
  };
  const open = (path: string) => { setTrail((t) => [...t, { path, q }]); setQ(''); setAt(0); };
  const back = () => {
    setError('');
    if (step === 'cli') go('folder');
    else if (step === 'folder' && trail.length) { setQ(trail.at(-1)!.q); setTrail((t) => t.slice(0, -1)); setAt(0); }
    else if (step === 'folder') go('machine');
  };

  const loading = step === 'folder'
    ? (here ? !inside : searching ? hits === null : home === null && !projects.length)
    : step === 'cli' ? accounts === null : false;
  const placeholder = step === 'machine' ? 'Which machine?'
    : step === 'folder' ? (here ? `Inside ${leaf(inside?.path ?? here)}` : `Which folder on ${machine?.name}?`)
    : 'Which CLI?';

  return (
    <div className="modal-back palette-back" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette-box newchat" role="dialog" aria-modal="true" aria-label="New chat" ref={dialog} tabIndex={-1}>
        <div className="palette-heading">
          <span className="newchat-steps">
            <span className={step === 'machine' ? 'on' : ''}>{machine?.name ?? 'Machine'}</span>
            <Icon name="forward" size={12} />
            <span className={step === 'folder' ? 'on' : ''}>{step === 'cli' ? leaf(folder) : 'Folder'}</span>
            <Icon name="forward" size={12} />
            <span className={step === 'cli' ? 'on' : ''}>CLI</span>
          </span>
          <button className="iconbtn" onClick={onClose} aria-label="Close new chat" title="Close"><Icon name="close" size={16} /></button>
        </div>
        <input
          ref={input} className="palette-input" value={q} placeholder={placeholder} disabled={busy}
          autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
          role="combobox" aria-label={placeholder}
          aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={rows.length ? `${listId}-${selected}` : undefined}
          onChange={(e) => { setQ(e.target.value); setAt(0); }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            const row = rows[selected];
            const atEnd = e.currentTarget.selectionStart === q.length;
            if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
            else if (e.key === 'Enter') { e.preventDefault(); if (row && !row.disabled) row.pick(); }
            else if (e.key === 'ArrowRight' && atEnd && row?.into) { e.preventDefault(); open(row.into); }
            else if ((e.key === 'Backspace' || e.key === 'ArrowLeft') && !q) { e.preventDefault(); back(); }
          }}
        />
        <div className="palette-list" ref={list} role="listbox" id={listId} aria-label={placeholder}>
          {busy && <div className="empty quiet">Starting {rows[selected]?.title} in {leaf(folder)}…</div>}
          {!busy && loading && !rows.length && <div className="empty quiet">{step === 'cli' ? 'looking for CLIs…' : 'looking…'}</div>}
          {!busy && !loading && !rows.length && (
            <div className="empty quiet">
              {step === 'machine' ? 'No machine matches.' : step === 'folder' ? (here ? 'No folders inside.' : 'No folder matches.') : 'No CLI matches.'}
            </div>
          )}
          {!busy && rows.map((row, i) => {
            const head = row.group && (i === 0 || rows[i - 1].group !== row.group);
            return (
              <div key={row.id}>
                {head && <div className="palette-group">{row.group}</div>}
                <div className="newchat-row">
                  <button
                    role="option" id={`${listId}-${i}`} tabIndex={-1} aria-selected={i === selected}
                    aria-disabled={row.disabled || undefined} disabled={row.disabled}
                    className={`palette-row${i === selected ? ' on' : ''}`}
                    onMouseMove={() => setAt(i)} onClick={() => row.pick()}
                  >
                    {row.engine ? <EngineMark engine={engineOf(row.engine).cls} />
                      : <span className="pglyph"><Icon name={row.icon ?? 'folder'} size={15} /></span>}
                    <span className="grow">
                      <span className="palette-title">{row.title}{row.tag && <span className="tag">{row.tag}</span>}</span>
                      {row.sub && <span className="palette-sub">{row.sub}</span>}
                    </span>
                  </button>
                  {row.into && (
                    <button
                      className="iconbtn newchat-into" tabIndex={-1} title={`look inside ${row.title}`} aria-label={`look inside ${row.title}`}
                      onClick={() => open(row.into!)}
                    ><Icon name="forward" size={15} /></button>
                  )}
                </div>
              </div>
            );
          })}
          {error && <div className="error">{error}</div>}
        </div>
        <div className="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>Enter</kbd> {step === 'cli' ? 'start' : 'choose'}</span>
          {step === 'folder' && <span><kbd>→</kbd> look inside</span>}
          {step !== 'machine' && !busy && <span><kbd>⌫</kbd> back</span>}
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
