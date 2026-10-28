import { errorMessage } from './errors';
import { useDialog } from './useDialog';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { EngineMark } from './EngineMark';
import { Icon } from './Icon';
import type { Client, DirEntry, Environment, Session } from './client';
import { watchAccounts } from './accountsCache';
import { accountsFrom, loadPrefs, rememberFolder, savePrefs, type Account, type PickerPrefs } from './accounts';
import { fetchFolders, knownInside, listFolder, loadFolders, rememberFolderMade, searchFolders, type FolderIndex } from './folderIndex';
import type { StartInfo } from './startingChats';

/**
 * A new chat without the mouse: machine, then folder, then CLI, in one box.
 *
 * Each step is a list you type into to narrow, move through with the arrows
 * and pick from with Enter. Backspace in an empty box steps back. The folder
 * step is the machine's folders as a tree, starting at home, and nothing else
 * - a new chat never continues an old one. Enter picks a folder, → opens it
 * in place to show the folders inside, ← closes it again. Typing searches
 * every folder on that machine; a result opens with → the same way.
 *
 * Two rows are not folders. "No folder · quick chat" sits first: a chat for
 * a small question that belongs to no project (Ctrl/Cmd+Enter). And when the
 * typed text is not a folder there already, the last row makes it, inside
 * the folder the cursor was last on (Ctrl/Cmd+Shift+Enter), and picks it.
 * The same is always a tap away below the list - "New folder in …", aimed
 * at the folder the cursor is in - and on each folder row as a +.
 *
 * Search runs on the device, over the machine's folder list fetched when the
 * machine is chosen (see folderIndex.ts); a machine too old to send one is
 * asked per search instead.
 *
 * "Clone from GitHub" is a side step off the folder list: the repos the
 * machine's own GitHub CLI login can reach, yours first and then each
 * organization's under its name, narrowed by typing. The list is the one
 * kept from last time, shown at once and fetched again behind it when old.
 * A search that finds nothing in it gets the list again and asks GitHub's
 * own search before saying the repo is not there. Picking a repo asks where
 * it goes, in the same folder tree as the folder step; then the agent, as
 * always. The chat opens at once in the repo's folder and the clone runs
 * inside it - see CloneCard. Helm never signs in to GitHub itself: with no
 * gh login there, it says to run `gh auth login` on that machine.
 */

type Step = 'machine' | 'folder' | 'github' | 'into' | 'cli';

interface GhRepo { full: string; owner: string; org?: boolean; name: string; private: boolean; archived: boolean; desc: string }
interface GhView { installed: boolean; accounts: { login: string; active: boolean }[]; login: string | null; repos: GhRepo[]; parent: string; at?: number; stale?: boolean; failed?: boolean }
/** A search the list missed, asked of GitHub itself. */
interface GhFind { query: string; state: 'looking' | 'done' | 'failed'; found: GhRepo[]; error?: string }

/** The repo lists already shown on this device, by machine and login: the box opens on them at once. */
const ghSeen = new Map<string, GhView>();

const QUICK_ROW = ':quick';
const NEW_ROW = ':new-folder';
const HIDDEN_ROW = ':hidden-clis';
const GITHUB_ROW = ':github';
const YOURS = 'Yours';
const SHARED = 'Shared with you';
const ON_GITHUB = 'On GitHub';
const HOME_ROW = '@home';
const parentKey = (machineId: string) => `helm.cloneParent.${machineId}`;
const savedParent = (machineId: string) => { try { return localStorage.getItem(parentKey(machineId)); } catch { return null; } };

interface Row {
  id: string;
  title: string;
  sub?: string;
  group?: string;
  engine?: string;
  icon?: 'machine' | 'folder' | 'repo' | 'quill' | 'plus' | 'back' | 'github' | 'lock';
  quiet?: boolean;
  tag?: string;
  disabled?: boolean;
  /** A folder: how deep in the tree, and whether it is opened. */
  folder?: { path: string; depth: number; open: boolean; parent?: string };
  /** A CLI: hides it from the list, or shows it again. */
  hide?: () => void;
  pick: () => void;
}

/** Every typed word has to be found somewhere in the row. */
const matches = (row: Row, q: string) => {
  const hay = `${row.title} ${row.sub ?? ''}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
};

const leaf = (p: string) => p.replace(/\/$/, '').split('/').pop() || p;
/** The folder a path is in: "~/dev/helm" -> "~/dev", "~/dev" -> "~". */
const up = (p: string) => p.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || (p.startsWith('/') ? '/' : '~');
const join = (dir: string, name: string) => `${dir.replace(/\/+$/, '')}/${name}`;
const where = (p: string) => (p === '~' ? 'home' : leaf(p));
const checked = (at: number, now: number) => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 10 ? 'just now' : s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

export function NewChat({ client, envs, envId, initialFolder, quick: startQuick = false, near, onFolder, onClose, onStarting, engineOf }: {
  client: Client;
  envs: Environment[];
  /** Start on this machine's folder step instead of asking which machine. */
  envId?: string | null;
  /** A known directory skips the folder step and asks which agent to start. */
  initialFolder?: string;
  /** A chat with no folder: the folder step is skipped once there is a machine. */
  quick?: boolean;
  /** The machine on screen: asked about first, with the cursor already on it. */
  near?: string | null;
  onFolder?: (envId: string, folder: string) => void;
  onClose: () => void;
  /** The chat opens at once; `run` starts its agent in the background. */
  onStarting: (info: StartInfo, run: () => Promise<Session>) => void;
  engineOf: (id?: string) => { label: string; cls: string };
}) {
  // Esc puts away the "New folder" box first, the picker after.
  const dialog = useDialog(() => {
    if (creatingNow.current) { setCreating(null); input.current?.focus(); } else onClose();
  });
  const creatingNow = useRef(false);
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // One machine online: there is nothing to choose, so it starts on its folders.
  const online = envs.filter((e) => e.online);
  const startEnv = envId ? envs.find((e) => e.id === envId && e.online) : online.length === 1 ? online[0] : undefined;
  const [step, setStep] = useState<Step>(startEnv ? initialFolder || startQuick ? 'cli' : 'folder' : 'machine');
  const [machine, setMachine] = useState<Environment | null>(startEnv ?? null);
  const [folder, setFolder] = useState(startEnv && !startQuick ? initialFolder ?? '' : '');
  /** No folder: the CLI step starts a quick chat. */
  const [quick, setQuick] = useState(startQuick);
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [accountCheck, setAccountCheck] = useState(0);
  const [accountError, setAccountError] = useState('');

  // Folder step.
  const [home, setHome] = useState<DirEntry[] | null>(null);
  /** The folders opened with →, by row id; what is inside each, once asked. */
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [inside, setInside] = useState<Record<string, DirEntry[] | null>>({});
  const [remoteHits, setRemoteHits] = useState<{ name: string; path: string; repo: boolean }[] | null>(null);
  /** The machine's folders, searched here; null until known, 'remote' on a machine that cannot send them. */
  const [index, setIndex] = useState<FolderIndex | null | 'remote'>(null);
  const [indexing, setIndexing] = useState(false);
  /** The "New folder" box below the list: where it goes, and the name typed. */
  const [creating, setCreating] = useState<{ parent: string; name: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // GitHub step.
  const [gh, setGh] = useState<GhView | null>(null);
  const [ghLogin, setGhLogin] = useState<string | undefined>();
  const [ghReload, setGhReload] = useState(0);
  /** The next load asks GitHub, not the list the machine kept. */
  const ghRefresh = useRef(false);
  const [ghBusy, setGhBusy] = useState(false);
  const [finding, setFinding] = useState<GhFind | null>(null);
  const [findAgain, setFindAgain] = useState(0);
  /** The repo picked, on its way to the "where does it go" step. */
  const [chosen, setChosen] = useState('');
  /** The CLI step starts a chat that clones this repo into `folder` first. */
  const [cloneFrom, setCloneFrom] = useState<string | null>(null);
  /** Where clones last went, remembered per machine; offered first. */
  const [cloneParent, setCloneParent] = useState<string | null>(null);
  creatingNow.current = !!creating;
  /**
   * The folder row the cursor was last moved to, which says where a new
   * folder goes. Typing resets the cursor to the first search hit, so only a
   * move made on purpose (arrows, mouse) changes it.
   */
  const [anchor, setAnchor] = useState<{ id: string; path: string } | null>(null);

  // CLI step.
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [picker, setPicker] = useState<(PickerPrefs & { onMachine: boolean }) | null>(null);
  const [viewHidden, setViewHidden] = useState(false);

  const go = (next: Step) => { setStep(next); setViewHidden(false); setQ(''); setAt(0); setError(''); input.current?.focus(); };

  // What a machine offers is asked for the moment it is chosen, so the
  // folder list and the CLI list are usually there before they are needed.
  useEffect(() => {
    if (!machine) return;
    let stale = false;
    setHome(null); setViewHidden(false); setOpened(new Set()); setInside({}); setAnchor(null);
    setIndex(null); setCreating(null);
    setGh(null); setGhLogin(undefined); setChosen(''); setCloneFrom(null); setFinding(null); setCloneParent(savedParent(machine.id));
    // Home as this device last saw it, at once; the machine's answer replaces it.
    setHome(knownInside(machine.id, '~'));
    listFolder(client, machine.id, '~')
      .then((r) => { if (!stale) setHome(r.entries); }).catch((e) => { if (!stale) { setHome((now) => now ?? []); setError(errorMessage(e)); } });
    // The folders this device remembers first, then the machine's own list
    // as it is now: it looks at its disk again when asked.
    void loadFolders(machine.id).then((held) => {
      if (stale || !held) return;
      setIndex((now) => now ?? held);
      setHome((now) => now ?? knownInside(machine.id, '~'));
    });
    setIndexing(true);
    fetchFolders(client, machine.id)
      .then((fresh) => { if (!stale) { setIndex(fresh); setNow(Date.now()); } })
      .catch(() => { if (!stale) setIndex((now) => now ?? 'remote'); })
      .finally(() => { if (!stale) setIndexing(false); });
    return () => { stale = true; };
  }, [client, machine]);

  useEffect(() => {
    if (!machine) return;
    let stale = false;
    setAccountError(''); setAccounts(null); setPicker(null);
    // The remembered list first, so the agent step never waits on a slow
    // machine; the machine's own answer replaces it when it lands.
    const stop = watchAccounts(client, machine.id, (r) => {
      if (stale) return;
      const local = loadPrefs()[machine.id];
      const prefs: PickerPrefs = r.picker ?? { hidden: local?.hidden ?? [], last: local?.account ?? null };
      setPicker({ ...prefs, onMachine: !!r.picker });
      setAccounts(accountsFrom(r.profiles));
    }, (message) => { if (!stale) { setAccounts((now) => now ?? []); setAccountError(message); } });
    return () => { stale = true; stop(); };
  }, [client, machine, accountCheck]);

  const expand = (path: string, id: string) => {
    setOpened((all) => new Set(all).add(id));
    if (!machine || path in inside) return;
    // What this device already knows is inside shows at once; the machine's
    // own answer replaces it when it lands.
    setInside((all) => ({ ...all, [path]: knownInside(machine.id, path) }));
    listFolder(client, machine.id, path)
      .then((r) => setInside((all) => ({ ...all, [path]: r.entries })))
      .catch((e) => { setInside((all) => ({ ...all, [path]: all[path] ?? [] })); setError(errorMessage(e)); });
  };
  const collapse = (id: string) => setOpened((all) => {
    // Closing a folder closes everything opened inside it too.
    const next = new Set([...all].filter((o) => o !== id && !o.startsWith(`${id}>`)));
    return next;
  });

  // Typing in the suggestions searches the whole machine: here, from its
  // folder list, or - on a machine that cannot send one - by asking it.
  const query = q.trim();
  const searching = (step === 'folder' || step === 'into') && !!query;
  const remote = index === 'remote';
  useEffect(() => {
    if (!searching || !machine || !remote) { setRemoteHits(null); return; }
    let stale = false;
    const t = setTimeout(() => {
      client.rpc<any>(machine.id, 'fs.search', { query }, 20_000)
        .then((r) => { if (!stale) setRemoteHits(r.results ?? []); })
        .catch((e) => { if (!stale) { setRemoteHits([]); setError(errorMessage(e)); } });
    }, 120);
    return () => { stale = true; clearTimeout(t); };
  }, [searching, query, client, machine, remote]);
  const localHits = useMemo(() => (searching && index && index !== 'remote' ? searchFolders(index.folders, query) : null),
    [searching, query, index]);
  const hits = remote ? remoteHits : localHits;

  // The repos: the list this device already showed, at once; then the
  // machine's (kept on its disk, so quick), and GitHub's own when that one
  // is old - quietly, behind the list on screen.
  const keepGh = (machineId: string, view: GhView, asked?: string) => {
    ghSeen.set(`${machineId}|${asked ?? ''}`, view);
    if (view.login) ghSeen.set(`${machineId}|${view.login}`, view);
  };
  useEffect(() => {
    if (step !== 'github' || !machine) return;
    let stale = false;
    const refresh = ghRefresh.current;
    ghRefresh.current = false;
    const held = ghSeen.get(`${machine.id}|${ghLogin ?? ''}`);
    if (held && !refresh) setGh((now) => now ?? held);
    const ask = (again: boolean) => client.rpc<GhView>(machine.id, 'github.repos', { login: ghLogin, refresh: again }, 60_000);
    setGhBusy(true);
    ask(refresh)
      .then(async (r) => {
        if (stale) return;
        setGh(r); keepGh(machine.id, r, ghLogin);
        if (!r.stale || !r.login) return;
        const fresh = await ask(true);
        if (!stale) { setGh(fresh); keepGh(machine.id, fresh, ghLogin); }
      })
      .catch((e) => { if (!stale) { setGh((now) => now ?? { installed: true, accounts: [], login: null, repos: [], parent: '~', failed: true }); setError(errorMessage(e)); } })
      .finally(() => { if (!stale) setGhBusy(false); });
    return () => { stale = true; };
  }, [step, client, machine, ghLogin, ghReload]);
  const reloadGh = () => { ghRefresh.current = true; setGhReload((n) => n + 1); };

  // The list narrowed by what is typed; every word has to be in the name or
  // the description.
  const ghMatches = useMemo(() => {
    if (step !== 'github' || !gh?.login) return [];
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return gh.repos.filter((r) => { const hay = `${r.full} ${r.desc}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
  }, [step, gh, query]);
  // Nothing in the list: get it again and ask GitHub's own search, once
  // typing pauses, before saying the repo is not there.
  const missed = step === 'github' && !!gh?.login && query.length >= 2 && ghMatches.length === 0;
  useEffect(() => {
    if (!missed || !machine || !gh?.login) { setFinding(null); return; }
    let stale = false;
    const login = gh.login;
    setFinding({ query, state: 'looking', found: [] });
    const t = setTimeout(() => {
      client.rpc<{ login: string; repos: GhRepo[]; at: number; found: GhRepo[] }>(machine.id, 'github.find', { login, query }, 60_000)
        .then((r) => {
          if (stale) return;
          setFinding({ query, state: 'done', found: r.found });
          setGh((now) => {
            if (!now || now.login !== r.login) return now;
            const next = { ...now, repos: r.repos, at: r.at, stale: false };
            keepGh(machine.id, next, ghLogin);
            return next;
          });
        })
        .catch((e) => { if (!stale) setFinding({ query, state: 'failed', found: [], error: errorMessage(e) }); });
    }, 500);
    return () => { stale = true; clearTimeout(t); };
  }, [missed, query, machine, gh?.login, findAgain]); // eslint-disable-line react-hooks/exhaustive-deps

  const chooseRepo = (full: string) => { setChosen(full); go('into'); };
  /**
   * The folder the repo goes into is picked: the agent is next. A folder
   * already holding that repo is simply used; one holding something else
   * is refused here, before anything starts.
   */
  const chooseParent = async (parent: string, id: string) => {
    if (!machine || busy || !chosen) return;
    const clean = parent.trim().replace(/\/+$/, '') || '~';
    const target = join(clean, chosen.split('/')[1] ?? chosen);
    setBusy(true); setError('');
    try {
      const r = await client.rpc<{ state: 'new' | 'there' | 'other'; path: string; reason?: string }>(machine.id, 'github.check', { repo: chosen, target }, 20_000);
      if (r.state === 'other') throw new Error(r.reason ?? `${target} already exists. It does not contain ${chosen}. Pick another folder.`);
      setCloneParent(clean);
      try { localStorage.setItem(parentKey(machine.id), clean); } catch { /* only a default */ }
      folderSpot.current = { q, id, step: 'into' };
      setFolder(target); setQuick(false); setCloneFrom(r.state === 'new' ? chosen : null);
      setBusy(false);
      go('cli');
    } catch (e: any) { setError(errorMessage(e)); setBusy(false); }
  };

  const refreshFolders = () => {
    if (!machine || indexing) return;
    const id = machine.id;
    setIndexing(true);
    fetchFolders(client, id, { refresh: true })
      .then((fresh) => { if (machine?.id === id) { setIndex(fresh); setNow(Date.now()); } })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setIndexing(false));
  };
  // "checked 20s ago" keeps counting while the picker is open.
  useEffect(() => {
    if (step !== 'folder' && step !== 'github') return;
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, [step]);

  // Stepping back from the CLIs lands on the same folder in the same list.
  const folderSpot = useRef<{ q: string; id: string; step: Step }>({ q: '', id: '', step: 'folder' });
  const pickFolder = (path: string, id: string) => {
    folderSpot.current = { q, id, step: 'folder' }; setFolder(path); setQuick(false); setCloneFrom(null);
    if (machine) onFolder?.(machine.id, path);
    go('cli');
  };
  const pickQuick = () => {
    folderSpot.current = { q, id: QUICK_ROW, step: 'folder' }; setFolder(''); setQuick(true); setCloneFrom(null);
    go('cli');
  };

  // A new folder goes inside the folder the cursor is on when that one is
  // opened, and beside it otherwise - the way a file tree reads. Home when
  // the cursor has not been anywhere yet.
  const newParent = !anchor ? '~' : opened.has(anchor.id) ? anchor.path : up(anchor.path);
  const newPath = join(newParent, query);
  const makeFolder = async (parent = newParent, name = query) => {
    name = name.trim();
    if (!machine || busy || !name) return;
    setBusy(true); setError('');
    try {
      // The machine checks the name (one segment, no "..") and says why not.
      const r = await client.rpc<{ path: string }>(machine.id, 'fs.mkdir', { path: parent, name }, 20_000);
      // The lists already fetched learn it too, so it is there on the way back.
      const entry: DirEntry = { name: leaf(r.path), path: r.path, isRepo: false, skip: false };
      const add = (list: DirEntry[]) => [...list.filter((e) => e.path !== r.path), entry].sort((a, b) => a.name.localeCompare(b.name));
      if (parent === '~') setHome((h) => (h ? add(h) : h));
      setInside((all) => (all[parent] ? { ...all, [parent]: add(all[parent]!) } : all));
      rememberFolderMade(machine.id, { name: entry.name, path: r.path, repo: false });
      setBusy(false); setCreating(null);
      pickFolder(r.path, r.path);
    } catch (e: any) { setError(errorMessage(e)); setBusy(false); }
  };
  /** Open the "New folder" box, aimed inside `parent`. */
  const createIn = (parent: string) => { setError(''); setCreating({ parent, name: '' }); };

  // The box is disabled while the machine works, which drops the cursor out
  // of it; it goes back once there is something to type again.
  useEffect(() => { if (!busy) input.current?.focus(); }, [busy]);

  // Kept where the machine keeps it, so every device shows the same list.
  const toggleHidden = (key: string) => {
    if (!machine || !picker) return;
    const before = new Set(picker.hidden);
    if (before.has(key)) before.delete(key); else before.add(key);
    const hidden = [...before];
    setPicker({ ...picker, hidden });
    if (viewHidden && !accounts?.some((a) => before.has(a.key))) setViewHidden(false);
    if (picker.onMachine) client.rpc(machine.id, 'picker.prefs', { hidden }, 15_000).catch((e) => setError(errorMessage(e)));
    else {
      const prefs = loadPrefs();
      savePrefs({ ...prefs, [machine.id]: { ...prefs[machine.id], hidden } });
    }
    input.current?.focus();
  };

  const start = async (a: Account) => {
    if (!machine || busy) return;
    setBusy(true); setError('');
    if (!quick) rememberFolder(machine.id, folder);
    if (!viewHidden) {
      if (picker?.onMachine) client.rpc(machine.id, 'picker.prefs', { last: a.key }, 15_000).catch(() => { /* only a default */ });
      else {
        const prefs = loadPrefs();
        savePrefs({ ...prefs, [machine.id]: { ...prefs[machine.id], account: a.key } });
      }
    }
    // The chat opens now and says it is starting; the agent comes up behind it.
    const params = {
      ...(quick ? { quick: true } : { cwd: folder }), profileId: a.profile.id,
      model: a.prefs?.default || undefined,
      effort: a.defaults?.effort || undefined,
      mode: a.defaults?.mode && a.defaults.mode !== 'plan' ? a.defaults.mode : undefined,
      speed: a.defaults?.speed || undefined,
      // The repo comes down into the folder inside the chat, which opens now.
      ...(cloneFrom ? { clone: { repo: cloneFrom, login: gh?.login ?? undefined } } : {}),
    };
    const env = machine.id;
    onClose();
    onStarting(
      { envId: env, title: quick ? 'Sketch' : where(folder), folder: quick ? null : folder, account: a.account, profileId: a.profile.id, engine: a.engine, agent: engineOf(a.engine).label },
      () => client.rpc<{ session: Session }>(env, 'session.start', params, cloneFrom ? 120_000 : 70_000).then((r) => r.session),
    );
  };

  const rows = useMemo((): Row[] => {
    if (step === 'machine') {
      const all = envs.map((e): Row => ({
        id: e.id, title: e.name, icon: 'machine', sub: e.online ? 'online' : 'offline', disabled: !e.online,
        pick: () => { if (machine?.id !== e.id) setMachine(e); go(quick ? 'cli' : 'folder'); },
      }));
      // Online first; offline ones stay visible so a missing machine is explained.
      return all.filter((r) => matches(r, query)).sort((a, b) => Number(!!a.disabled) - Number(!!b.disabled));
    }
    if (step === 'folder' || step === 'into') {
      // A row's id is its place in the tree - "~/dev>helm>apps" - which can
      // never equal a top-level folder's own path, "~/dev/helm/apps".
      // Where a repo goes is picked in the same tree as any folder.
      const out: Row[] = [];
      const pickAt = step === 'folder' ? pickFolder : (path: string, id: string) => void chooseParent(path, id);
      const add = (path: string, title: string, repo: boolean, depth: number, parent?: string, sub?: string, own?: { id: string; tag?: string }) => {
        const id = own?.id ?? (parent ? `${parent}>${title}` : path);
        const open = opened.has(id);
        out.push({ id, title, sub, tag: own?.tag, icon: repo ? 'repo' : 'folder', folder: { path, depth, open, parent }, pick: () => pickAt(path, id) });
        if (!open) return;
        const kids = inside[path];
        if (kids === null || kids === undefined) out.push({ id: `${id}>…`, title: 'Helm is loading folders.', disabled: true, folder: { path, depth: depth + 1, open: false, parent: id }, pick: () => {} });
        else if (!kids.length) out.push({ id: `${id}>…`, title: 'This folder has no folders.', disabled: true, folder: { path, depth: depth + 1, open: false, parent: id }, pick: () => {} });
        else for (const k of kids) add(k.path, k.name, k.isRepo, depth + 1, id);
      };
      if (step === 'into') {
        // The last place a repo went, then home itself; a typed path is
        // offered as it is, made if it is not there yet.
        if (!query) {
          if (cloneParent && cloneParent !== '~') add(cloneParent, leaf(cloneParent), false, 0, undefined, cloneParent, { id: `@${cloneParent}`, tag: 'last used' });
          out.push({ id: HOME_ROW, title: 'Home', sub: '~', icon: 'folder', pick: () => void chooseParent('~', HOME_ROW) });
        } else if (/^[~/]/.test(query)) {
          const typed = query.replace(/\/+$/, '') || '/';
          out.push({ id: ':path', title: typed, sub: `→ ${join(typed, chosen.split('/')[1] ?? chosen)}`, icon: 'plus', pick: () => void chooseParent(typed, ':path') });
        }
      }
      if (searching) {
        // A hit inside another hit is one → away from it; listing both is
        // the same folder twice.
        const all = hits ?? [];
        for (const h of all) {
          if (all.some((o) => o !== h && h.path.startsWith(`${o.path.replace(/\/$/, '')}/`))) continue;
          add(h.path, h.name, h.repo, 0, undefined, h.path);
        }
      }
      else for (const e of home ?? []) add(e.path, e.name, e.isRepo, 0);
      if (step === 'into') return out;
      const quickRow: Row = { id: QUICK_ROW, title: 'No folder · sketch', sub: 'Ask a short question.', icon: 'quill', pick: pickQuick };
      const githubRow: Row = { id: GITHUB_ROW, title: 'Copy from GitHub', icon: 'github', pick: () => go('github') };
      if (!query || matches(githubRow, query)) out.unshift(githubRow);
      if (!query || matches(quickRow, query)) out.unshift(quickRow);
      // Offered once the typed name is not a folder that is already there.
      const known = [...(hits ?? []), ...(home ?? []), ...(inside[newParent] ?? [])];
      if (query && (!searching || hits !== null) && !known.some((f) => f.path === newPath)) {
        out.push({ id: NEW_ROW, title: `Create folder "${query}" in ${where(newParent)}`, sub: newPath, icon: 'plus', pick: () => void makeFolder() });
      }
      return out;
    }
    if (step === 'github') {
      if (!gh?.login) return [];
      // Yours first, then each organization under its own name; repos
      // other people shared with you last, together. What GitHub's own
      // search found, when the list had nothing, comes under its own name.
      const groupOf = (r: GhRepo) => r.owner === gh.login ? YOURS : r.org ? r.owner : SHARED;
      const rank = (g: string) => (g === YOURS ? 0 : g === SHARED ? 2 : 1);
      const row = (r: GhRepo, group: string): Row => ({
        id: r.full, title: r.name, sub: group === ON_GITHUB ? [r.owner, r.desc].filter(Boolean).join(' · ') : r.desc || undefined, group,
        icon: r.private ? 'lock' : 'repo', tag: r.archived ? 'archived' : undefined, pick: () => chooseRepo(r.full),
      });
      const out = ghMatches.map((r) => row(r, groupOf(r)))
        .sort((x, y) => rank(x.group!) - rank(y.group!) || (rank(x.group!) === 1 ? x.group!.localeCompare(y.group!) : 0));
      if (!out.length && finding?.query === query) for (const r of finding.found) out.push(row(r, ON_GITHUB));
      return out;
    }
    const hidden = new Set(picker?.hidden ?? []);
    const cliRows = (hiddenView: boolean) => {
      const shown = (accounts ?? []).filter((a) => hidden.has(a.key) === hiddenView);
      const twins = new Set(shown.map((a) => `${a.engine}|${a.account}`).filter((k, i, all) => all.indexOf(k) !== i));
      // The machine's chosen default first, then the last one used, so Enter
      // straight away starts what you would have picked.
      const first = shown.find((a) => a.key === picker?.agent) ?? shown.find((a) => a.key === picker?.last);
      const ordered = first ? [first, ...shown.filter((a) => a !== first)] : shown;
      return ordered.map((a): Row => ({
        id: a.key, engine: a.engine, title: engineOf(a.engine).label,
        group: hiddenView ? 'Hidden agents' : undefined,
        sub: twins.has(`${a.engine}|${a.account}`) ? `${a.account} (${a.profile.id})` : a.account,
        tag: a.key === picker?.agent ? 'default' : a.key === picker?.last ? 'last used' : undefined,
        hide: () => toggleHidden(a.key),
        pick: () => void start(a),
      })).filter((r) => matches(r, query));
    };
    const hiddenRows = cliRows(true);
    const out = viewHidden ? hiddenRows : cliRows(false);
    if (viewHidden || hiddenRows.length) out.push({
      id: HIDDEN_ROW, quiet: true, icon: viewHidden ? 'back' : undefined,
      title: viewHidden ? 'Show visible agents' : query
        ? `Show ${hiddenRows.length} hidden ${hiddenRows.length === 1 ? 'match' : 'matches'}`
        : `Show ${hiddenRows.length} hidden ${hiddenRows.length === 1 ? 'agent' : 'agents'}`,
      pick: () => { setViewHidden(value => !value); setAt(0); input.current?.focus(); },
    });
    return out;
  }, [step, envs, machine, query, opened, inside, searching, hits, home, accounts, picker, viewHidden, folder, quick, anchor, busy, gh, ghMatches, finding, chosen, cloneParent]); // eslint-disable-line react-hooks/exhaustive-deps

  // Where "New folder" puts it: inside the folder the cursor is on when that
  // one is open, beside it otherwise.
  const cursorRow = rows[Math.max(0, Math.min(at, rows.length - 1))];
  const createTarget = step !== 'folder' ? '~'
    : cursorRow?.folder && !cursorRow.disabled ? (cursorRow.folder.open ? cursorRow.folder.path : up(cursorRow.folder.path))
    : newParent;

  // On the machine step the one you are on is where the cursor starts.
  useEffect(() => {
    if (step !== 'machine' || query) return;
    const i = rows.findIndex((r) => r.id === (machine?.id ?? near) && !r.disabled);
    setAt(i >= 0 ? i : 0);
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // Back from the CLIs: put the cursor on the folder that was picked, once
  // its list is on screen again.
  const returning = useRef('');
  useEffect(() => {
    if ((step !== 'folder' && step !== 'github' && step !== 'into') || !returning.current) return;
    const i = rows.findIndex((r) => r.id === returning.current);
    if (i >= 0) { setAt(i); returning.current = ''; }
  }, [step, rows]);

  const selected = Math.max(0, Math.min(at, rows.length - 1));
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, rows]);

  /** Put the cursor on a row on purpose: a folder row there becomes the anchor. */
  const point = (i: number) => {
    setAt(i);
    const f = rows[i]?.folder;
    if (f && !rows[i].disabled) setAnchor({ id: rows[i].id, path: f.path });
  };
  const move = (by: number) => {
    if (!rows.length) return;
    let i = selected;
    for (let n = 0; n < rows.length; n++) {
      i = (i + by + rows.length) % rows.length;
      if (!rows[i].disabled) break;
    }
    point(i);
  };
  const back = () => {
    setError('');
    if (step === 'cli' && viewHidden) { setViewHidden(false); setAt(0); return; }
    if (step === 'cli') { go(folderSpot.current.step); setQuick(false); setCloneFrom(null); setQ(folderSpot.current.q); returning.current = folderSpot.current.id; }
    else if (step === 'into') { go('github'); returning.current = chosen; }
    else if (step === 'github') { go('folder'); returning.current = GITHUB_ROW; }
    else if (step === 'folder') go('machine');
  };
  // → opens a folder, or steps into one already open; ← closes it, or steps
  // out to the folder it is in - the way every file tree answers the arrows.
  const right = (row: Row) => {
    const f = row.folder!;
    if (!f.open) { expand(f.path, row.id); setAnchor({ id: row.id, path: f.path }); return; }
    const next = rows[selected + 1];
    if (next?.folder?.parent === row.id && !next.disabled) point(selected + 1);
  };
  const left = (row: Row) => {
    const f = row.folder!;
    if (f.open) { collapse(row.id); return; }
    const outer = rows.findIndex((r) => r.id === f.parent);
    if (outer >= 0) { collapse(f.parent!); point(outer); }
  };

  // Where the repo would land from the row the cursor is on.
  const intoRow = step === 'into' ? rows[selected] : undefined;
  const intoTarget = !intoRow || intoRow.disabled ? ''
    : join(intoRow.folder?.path ?? (intoRow.id === HOME_ROW ? '~' : query.replace(/\/+$/, '') || '/'), chosen.split('/')[1] ?? chosen);

  const loading = step === 'folder'
    ? (searching ? hits === null : home === null)
    : step === 'cli' ? accounts === null
    : step === 'github' ? gh === null
    : step === 'into' ? (searching ? hits === null : home === null) : false;
  const placeholder = step === 'machine' ? 'Search machines'
    : step === 'folder' ? `Search folders on ${machine?.name}`
    : step === 'github' ? 'Search GitHub projects'
    : step === 'into' ? 'Search folders, or type a path'
    : viewHidden ? 'Search hidden agents' : 'Search agents';

  return (
    <div className="modal-back palette-back" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette-box newchat" role="dialog" aria-modal="true" aria-label="New chat" ref={dialog} tabIndex={-1}>
        <div className="palette-heading">
          <span className="newchat-steps">
            <span className={step === 'machine' ? 'on' : ''}>{machine?.name ?? 'Machine'}</span>
            <Icon name="forward" size={12} />
            <span className={step === 'folder' || step === 'github' || step === 'into' ? 'on' : ''}>{step === 'cli' ? quick ? 'Sketch' : leaf(folder) : step === 'github' || step === 'into' ? 'GitHub' : 'Folder'}</span>
            <Icon name="forward" size={12} />
            <span className={step === 'cli' ? 'on' : ''}>Agent</span>
          </span>
          <button className="iconbtn" onClick={onClose} aria-label="Close new chat" title="Close"><Icon name="close" size={16} /></button>
        </div>
        {/* The same question an empty chat asks, one step at a time. */}
        <h2 className="newchat-greeting">
          {step === 'machine' ? 'Pick a machine.'
            : step === 'folder' ? <>Pick a folder on <b>{machine?.name}</b>.</>
            : step === 'github' ? <>Pick a GitHub project.</>
            : step === 'into' ? <>Pick a folder for <b>{chosen.split('/')[1] ?? chosen}</b>.</>
            : quick ? <>Pick an agent for a <b>sketch</b>.</>
            : <>Pick an agent in <b>{leaf(folder)}</b>.</>}
        </h2>
        {step === 'cli' && <details className="newchat-note">
          <summary>First chat help</summary>
          <p>Pick an agent. Send a short question. Wait for its reply before you give it project work.</p>
          <p>For a first check, use “No folder · quick chat” on the folder step.</p>
          <p>Helm uses the agent accounts on {machine?.name}. Open the agent in a terminal there and sign in first.</p>
          <p>If the chat cannot start, run <code>helm doctor</code> on that machine. Follow its checks, then try again.</p>
        </details>}
        {step === 'cli' && accountError && <div className="banner warn" role="alert">
          Helm could not check agents on {machine?.name}. {accountError}
          <button type="button" className="ghost" onClick={() => setAccountCheck(n => n + 1)}>Check agents again</button>
        </div>}
        {step === 'cli' && accounts !== null && !accounts.length && !accountError && <div className="newchat-signin">
          <p>No agent account is ready on {machine?.name}.</p>
          <p>Install an agent on that machine. Open it in a terminal and sign in. Then check again.</p>
          <p>Run <code>helm doctor</code> there if the account still does not appear.</p>
          <button type="button" className="ghost" onClick={() => setAccountCheck(n => n + 1)}>Check agents again</button>
        </div>}
        {step === 'cli' && cloneFrom && <p className="newchat-note">Helm will copy {cloneFrom} into {folder}.</p>}
        <input
          ref={input} className="palette-input" value={q} placeholder={placeholder} disabled={busy || (step === 'github' && !!gh && !gh.login)}
          autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
          role="combobox" aria-label={placeholder}
          aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={rows.length ? `${listId}-${selected}` : undefined}
          onChange={(e) => { setQ(e.target.value); setAt(0); }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            const row = rows[selected];
            // With Ctrl/Cmd, Enter is about the folder step's own two rows:
            // no folder at all, or a new one with the typed name.
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && step !== 'cli') {
              e.preventDefault();
              if (step !== 'folder' || busy) return;
              if (e.shiftKey) void makeFolder(); else pickQuick();
              return;
            }
            if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
            else if (e.key === 'Enter') { e.preventDefault(); if (row && !row.disabled) row.pick(); }
            // In the folder tree the side arrows belong to the tree, even
            // with a search typed: nobody edits a folder name mid-word here.
            else if (e.key === 'ArrowRight' && row?.folder) { e.preventDefault(); right(row); }
            else if (e.key === 'ArrowLeft' && row?.folder) { e.preventDefault(); left(row); }
            else if ((e.key === 'Backspace' || (e.key === 'ArrowLeft' && step !== 'folder')) && !q) { e.preventDefault(); back(); }
          }}
        />
        <div className="palette-list" ref={list} role="listbox" id={listId} aria-label={placeholder}>
          {step === 'github' && !ghBusy && gh && !gh.login && !gh.failed && (
            <div className="newchat-signin">
              <Icon name="github" size={28} />
              {!gh.installed ? <>
                <p><b>{machine?.name}</b> does not have the GitHub CLI.</p>
                <a href="https://cli.github.com" target="_blank" rel="noreferrer">cli.github.com</a>
              </> : <>
                <p>The GitHub CLI on <b>{machine?.name}</b> needs you to sign in. Run this command there:</p>
                <div className="newchat-signin-acts">
                  <code className="newchat-code">gh auth login</code>
                  <button type="button" className="ghost" title="Copy" aria-label="Copy" onClick={() => void navigator.clipboard?.writeText('gh auth login').catch(() => {})}><Icon name="copy" size={14} /></button>
                </div>
              </>}
              <button type="button" className="ghost" onClick={reloadGh}><Icon name="refresh" size={14} />Check again</button>
            </div>
          )}
          {busy && step !== 'github' && <div className="empty quiet">{step === 'into' ? `Helm is checking the folder for ${chosen.split('/')[1] ?? chosen}.` : step === 'folder' ? `Helm is creating ${newPath}.` : quick ? `Helm is starting ${rows[selected]?.title} for a sketch.` : `Helm is starting ${rows[selected]?.title} in ${leaf(folder)}.`}</div>}
          {!busy && loading && !rows.length && <div className="empty quiet">{step === 'cli' ? 'Helm is looking for agents.' : step === 'github' ? 'Helm is checking GitHub.' : 'Helm is looking for folders.'}</div>}
          {!busy && !loading && (!rows.length || (viewHidden && rows.every(row => row.quiet))) && step !== 'github' && (
            <div className="empty quiet">
              {step === 'machine' ? 'No machine matches.' : step === 'folder' ? (searching ? 'No folder matches.' : 'This folder has no folders.')
                : step === 'into' ? 'No folder matches. Type a path like ~/work.' : viewHidden ? 'No hidden agent matches.' : 'No agent matches.'}
            </div>
          )}
          {/* Not in the list: GitHub is asked before anything says it is not there. */}
          {step === 'github' && gh?.login && !rows.length && (query.length < 2 ? (
            gh.repos.length ? null : <div className="empty quiet">{ghBusy ? 'Helm is checking GitHub.' : `${gh.login} has no GitHub projects.`}</div>
          ) : !finding || finding.state === 'looking' ? (
            <div className="empty quiet"><Icon name="think" size={12} /> No match in your list. Helm is searching GitHub.</div>
          ) : (
            <div className="empty quiet newchat-missing">
              <span>{finding.state === 'failed' ? finding.error : <><b>{gh.login}</b> cannot find a GitHub project called “{query}”.</>}</span>
              <button type="button" className="ghost" onClick={() => setFindAgain((n) => n + 1)}><Icon name="refresh" size={14} />Look again</button>
            </div>
          ))}
          {!busy && rows.map((row, i) => {
            const head = row.group && (i === 0 || rows[i - 1].group !== row.group);
            return (
              <div key={row.id}>
                {head && <div className="palette-group">{row.group}</div>}
                <div className={`newchat-row${row.folder || step === 'into' ? ' tree' : ''}`} style={row.folder ? { paddingLeft: row.folder.depth * 22 } : undefined}>
                  {/* Home and a typed path sit in line with the folder tree around them. */}
                  {!row.folder && step === 'into' && <span className="newchat-twisty" />}
                  {row.folder && (row.disabled ? <span className="newchat-twisty" /> : (
                    <button
                      className={`newchat-twisty${row.folder.open ? ' open' : ''}`} tabIndex={-1}
                      title={row.folder.open ? `Close ${row.title}` : `Open ${row.title}`}
                      aria-label={row.folder.open ? `Close ${row.title}` : `Open ${row.title}`}
                      onClick={() => { point(i); if (row.folder!.open) collapse(row.id); else expand(row.folder!.path, row.id); }}
                    ><Icon name="forward" size={14} /></button>
                  ))}
                  <button
                    role="option" id={`${listId}-${i}`} tabIndex={-1} aria-selected={i === selected}
                    aria-disabled={row.disabled || undefined} disabled={row.disabled}
                    aria-expanded={row.folder && !row.disabled ? row.folder.open : undefined}
                    className={`palette-row${row.quiet ? ' quiet' : ''}${i === selected ? ' on' : ''}`}
                    onMouseMove={() => { if (i !== selected) point(i); }} onClick={() => row.pick()}
                  >
                    {row.quiet ? <span className="newchat-quiet-glyph">{row.icon && <Icon name={row.icon} size={14} />}</span>
                      : row.engine ? <EngineMark engine={engineOf(row.engine).cls} />
                      : !row.disabled && <span className="pglyph"><Icon name={row.icon ?? 'folder'} size={15} /></span>}
                    <span className="grow">
                      <span className="palette-title">{row.title}{row.tag && <span className="tag">{row.tag}</span>}</span>
                      {row.sub && <span className="palette-sub">{row.sub}</span>}
                    </span>
                  </button>
                  {row.hide && (
                    <button
                      className="newchat-add newchat-hide" tabIndex={-1}
                      title={viewHidden ? `Show ${row.title} · ${row.sub} again` : `Hide ${row.title} · ${row.sub}`}
                      aria-label={viewHidden ? `Show ${row.title} · ${row.sub} again` : `Hide ${row.title} · ${row.sub}`}
                      onClick={() => { point(i); row.hide!(); }}
                    ><Icon name={viewHidden ? 'eye' : 'eye-off'} size={14} /></button>
                  )}
                  {row.folder && !row.disabled && step === 'folder' && (
                    <button
                      className="newchat-add" tabIndex={-1} title={`Create a folder inside ${row.title}`} aria-label={`Create a folder inside ${row.title}`}
                      onClick={() => { point(i); if (!row.folder!.open) expand(row.folder!.path, row.id); createIn(row.folder!.path); }}
                    ><Icon name="plus" size={14} /></button>
                  )}
                </div>
              </div>
            );
          })}
          {error && <div className="error">{error}</div>}
        </div>
        {step === 'folder' && machine && (creating ? (
          <form className="newchat-bar creating" onSubmit={(e) => { e.preventDefault(); void makeFolder(creating.parent, creating.name); }}>
            <span className="pglyph"><Icon name="plus" size={15} /></span>
            <label className="newchat-create">
              <span className="newchat-where" title={creating.parent}>New folder in <b>{where(creating.parent)}</b></span>
              <input
                autoFocus value={creating.name} placeholder="Folder name" aria-label={`New folder name, in ${creating.parent}`} disabled={busy}
                autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
                onChange={(e) => setCreating({ ...creating, name: e.target.value })}
              />
            </label>
            <button type="submit" className="primary" disabled={busy || !creating.name.trim()}>{busy ? 'Helm is creating the folder.' : 'Create'}</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => { setCreating(null); input.current?.focus(); }}>Cancel</button>
          </form>
        ) : (
          <div className="newchat-bar">
            <button type="button" className="newchat-new" onClick={() => createIn(createTarget)} title={`Create a folder in ${createTarget}`}>
              <Icon name="plus" size={15} />New folder in <b>{where(createTarget)}</b>
            </button>
            <span className="newchat-index" role="status" title={index && index !== 'remote' ? `${index.count.toLocaleString()} folders` : undefined}>
              {index && index !== 'remote' ? <>{indexing ? 'Helm is checking folders.' : `checked ${checked(index.at, now)}`}</>
                : remote ? 'Helm is searching the machine.' : 'Helm is reading folders.'}
            </span>
            {!remote && <button type="button" className="iconbtn newchat-refresh" onClick={refreshFolders} disabled={indexing}
              title="Look for new folders now" aria-label="Look for new folders now"><Icon name="refresh" size={15} /></button>}
          </div>
        ))}
        {step === 'github' && machine && gh?.login && (
          <div className="newchat-bar">
            {gh.accounts.length > 1 ? (
              <button type="button" className="newchat-new" disabled={busy || ghBusy} title="Use another GitHub account"
                onClick={() => { const i = gh.accounts.findIndex((a) => a.login === gh.login); setGhLogin(gh.accounts[(i + 1) % gh.accounts.length].login); setGh(null); setAt(0); }}>
                <Icon name="github" size={15} /><b>{gh.login}</b><span className="quiet">· switch</span>
              </button>
            ) : <span className="newchat-account" title={`GitHub account ${gh.login}`}><Icon name="github" size={14} />{gh.login}</span>}
            <span className="newchat-index" role="status" title={`${gh.repos.length.toLocaleString()} GitHub projects`}>{ghBusy ? 'Helm is checking GitHub.' : gh.at ? `checked ${checked(gh.at, now)}` : ''}</span>
            <button type="button" className="iconbtn newchat-refresh" onClick={reloadGh} disabled={ghBusy}
              title="Look for new GitHub projects" aria-label="Look for new GitHub projects"><Icon name="refresh" size={15} /></button>
          </div>
        )}
        {step === 'into' && machine && (
          <div className="newchat-bar">
            <span className="newchat-account"><Icon name="github" size={14} />{intoTarget ? <>Goes to <b>{intoTarget}</b></> : 'Pick a folder for the project.'}</span>
          </div>
        )}
      </div>
    </div>
  );
}
