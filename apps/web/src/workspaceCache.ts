import type { Environment, Session } from './client';
import { txn } from './idb';
import { listedThread } from './format';

export interface WorkspaceSnapshot {
  environments: Environment[];
  sessions: Record<string, Session[]>;
  view?: { envId: string; session: Session };
}
const empty = (): WorkspaceSnapshot => ({ environments: [], sessions: {} });
const hot = new Map<string, WorkspaceSnapshot>();
const revisions = new Map<string, number>();
const touched = new Map<string, Set<string>>();
const key = (scope: string) => `helm.workspace:${scope}`;
// Scopes changed in memory but not yet written to the device.
const dirty = new Set<string>();
let writer: ReturnType<typeof setTimeout> | null = null;

/** Namespacing only; authentication is still performed by the hub. */
export function workspaceScope(token?: string): string {
  try {
    const claims = JSON.parse(atob(token!.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof claims.net === 'string' && typeof claims.sub === 'string' ? `${claims.net}:${claims.sub}` : '';
  } catch { return ''; }
}

function valid(value: any): value is WorkspaceSnapshot {
  const session = (s: any) => s && ['id', 'title', 'cwd', 'engine', 'profileId', 'status']
    .every(k => typeof s[k] === 'string');
  return value && Array.isArray(value.environments)
    && value.environments.every((e: any) => e && typeof e.id === 'string' && typeof e.name === 'string'
      && e.info && typeof e.info === 'object')
    && value.sessions && typeof value.sessions === 'object' && !Array.isArray(value.sessions)
    && Object.values(value.sessions).every(list => Array.isArray(list) && list.every(session))
    && (!value.view || (typeof value.view.envId === 'string' && session(value.view.session)));
}

/** Small headers, never transcript bodies, keys or provider settings. */
function header(s: Session): Session {
  const { id, title, cwd, engine, profileId, status, driver, pty, model, engineModel, mode, effort, engineEffort, permissionControl,
    speed, alive, createdAt, updatedAt, seenAt, team, recovery, pending, archived, brain, turns, external, engineSessionId, adopted, account, nativeCli, nativeChat, shared, nativeCards, context } = s;
  // seenAt, team and recovery decide which shelf a chat sits on and whether
  // it is new; a saved row without them was sorted differently from the
  // same chat live.
  return { id, title: title?.slice(0, 300), cwd, engine, profileId, status, driver, pty,
    model, engineModel, mode, effort, engineEffort, permissionControl, speed, alive, createdAt, updatedAt, seenAt, team, recovery, pending, archived, brain, turns, external, engineSessionId, adopted, account, nativeCli, nativeChat, shared,
    // How full the chat is: the ring under the composer, before the machine answers.
    context,
    // A chat's own helpers, so its Agents count is right before the machine answers.
    ...(nativeCards?.length ? { nativeCards: nativeCards.slice(-24).map((card) => ({ ...card, title: card.title.slice(0, 100), last: '' })) } : {}) };
}

export function loadWorkspace(scope: string): WorkspaceSnapshot {
  if (dirty.has(scope)) writeWorkspace(scope);
  return current(scope);
}

/** The latest copy in memory, with lists not yet tidied for saving. */
function current(scope: string): WorkspaceSnapshot {
  if (!scope) return empty();
  if (hot.has(scope)) return hot.get(scope)!;
  try {
    const value = JSON.parse(localStorage.getItem(key(scope)) || 'null');
    if (valid(value)) { hot.set(scope, value); return value; }
  } catch { /* durable copy may still be available */ }
  return empty();
}

export async function loadWorkspaceDurable(scope: string): Promise<WorkspaceSnapshot> {
  const current = loadWorkspace(scope);
  if (!scope || current.environments.length) return current;
  const revision = revisions.get(scope);
  try {
    const value = await txn<WorkspaceSnapshot | undefined>('kv', 'readonly', s => s.get(key(scope)));
    if (revision === revisions.get(scope) && valid(value)) {
      // A fast machine list must not discard saved thread lists while disk
      // is still answering. Only fields actually refreshed live override it.
      const current = loadWorkspace(scope), fields = touched.get(scope);
      const environments = fields?.has('environments') ? current.environments : value.environments;
      const ids = new Set(environments.map(e => e.id));
      const sessions = Object.fromEntries(Object.entries({ ...value.sessions, ...current.sessions })
        .filter(([id]) => ids.has(id)));
      const view = fields?.has('view') ? current.view : current.view ?? value.view;
      const merged = { environments, sessions, view: view && ids.has(view.envId) ? view : undefined };
      saveWorkspace(scope, merged);
      return loadWorkspace(scope);
    }
  } catch { /* metadata is only a signpost to the cached transcript */ }
  return loadWorkspace(scope);
}

export function saveWorkspace(scope: string, patch: Partial<WorkspaceSnapshot>): void {
  if (!scope) return;
  const fields = touched.get(scope) ?? new Set<string>();
  if ('environments' in patch) fields.add('environments');
  if ('view' in patch) fields.add('view');
  touched.set(scope, fields);
  const previous = current(scope);
  const value = { ...previous, ...patch, sessions: { ...previous.sessions, ...patch.sessions } };
  // The open view is another copy of the same header. Keep it current when
  // a live list arrives, so reload never boots with its older settings.
  if (value.view && patch.sessions?.[value.view.envId]) {
    const current = patch.sessions[value.view.envId].find(s => s.id === value.view!.session.id);
    if (current) value.view = { ...value.view, session: current };
  }
  if (patch.environments) {
    const ids = new Set(patch.environments.map(e => e.id));
    value.sessions = Object.fromEntries(Object.entries(value.sessions).filter(([id]) => ids.has(id)));
    if (value.view && !ids.has(value.view.envId)) value.view = undefined;
  }
  hot.set(scope, value);
  // Every chat update lands here, many a second while agents work, and
  // sorting and writing the whole list each time held up the screen. Memory
  // has the change now; the device gets it at most once a second, and when
  // the page is hidden or closed.
  dirty.add(scope);
  writer ??= setTimeout(writeWorkspaces, 1000);
}

function writeWorkspace(scope: string): void {
  dirty.delete(scope);
  const latest = hot.get(scope);
  if (!latest) return;
  const value: WorkspaceSnapshot = { ...latest, sessions: Object.fromEntries(Object.entries(latest.sessions).map(([id, sessions]) =>
    [id, sessions.filter(s => listedThread(s) && s.engine !== 'shell')
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, 200).map(header)])) };
  if (value.view) value.view = { ...value.view, session: header(value.view.session) };
  hot.set(scope, value);
  try { localStorage.setItem(key(scope), JSON.stringify(value)); } catch { /* quota or private mode */ }
  void txn('kv', 'readwrite', s => s.put(value, key(scope))).catch(() => {});
}

/** Write every pending change to the device now. */
export function writeWorkspaces(): void {
  if (writer) clearTimeout(writer);
  writer = null;
  for (const scope of [...dirty]) writeWorkspace(scope);
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', writeWorkspaces);
  window.addEventListener('beforeunload', writeWorkspaces);
  document.addEventListener('visibilitychange', () => { if (document.hidden) writeWorkspaces(); });
}

/** Save acknowledged changes, including CLI-reported settings. */
export function updateWorkspaceSession(scope: string, envId: string, session: Session): void {
  const saved = current(scope);
  const list = saved.sessions[envId];
  const view = saved.view?.envId === envId && saved.view.session.id === session.id
    ? { ...saved.view, session: { ...saved.view.session, ...session } } : saved.view;
  saveWorkspace(scope, {
    ...(list ? { sessions: { [envId]: list.map(s => s.id === session.id ? { ...s, ...session } : s) } } : {}),
    view,
  });
}

export function forgetWorkspace(scope: string): void {
  if (!scope) return;
  revisions.set(scope, (revisions.get(scope) ?? 0) + 1);
  // A change still waiting must not write the signed-out list back.
  dirty.delete(scope);
  touched.delete(scope);
  hot.delete(scope);
  try { localStorage.removeItem(key(scope)); } catch { /* storage denied */ }
  void txn('kv', 'readwrite', s => s.delete(key(scope))).catch(() => {});
}
