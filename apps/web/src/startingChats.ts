import { errorMessage } from './errors';
import type { Client, Session } from './client';
import { newMessageId, retryableDelivery } from '@helm/protocol/reliable-input';
import { loadDraft } from './draftStore';

/**
 * New chats whose agent is still starting.
 *
 * A CLI takes a second or more to come up - several for some agents, more
 * over a slow link - and the picker used to sit there until it had. Now the
 * chat opens at once and says it is starting; what you type meanwhile waits
 * here and goes in when the agent is ready. Saved before sending so a
 * reload can recover the same start and message numbers.
 */

export interface StartInfo {
  startParams?: Record<string, unknown>;
  envId: string;
  title: string;
  /** Where it runs, as the picker showed it; null for a quick chat. */
  folder: string | null;
  account: string;
  /** The account's id, which the live chat names under its composer. */
  profileId: string;
  engine: string;
  /** The engine's name as people know it, e.g. "Claude". */
  agent: string;
}

export interface StartingChat extends StartInfo {
  id: string;
  owner?: string;
  state: 'starting' | 'failed' | 'started';
  error?: string;
  session?: Session;
  /** What was sent before the agent was ready; goes in once it is. */
  messageId?: string;
  message: string;
  /** Typed but not sent; becomes the chat's draft. */
  draft: string;
  since: number;
}

const chats = new Map<string, StartingChat>();
const runs = new Map<string, () => Promise<Session>>();
const listeners = new Set<(chat: StartingChat) => void>();
const storageKey = 'helm.startingChat.v1:';
function persist(chat: StartingChat) {
  try { localStorage.setItem(storageKey + chat.id, JSON.stringify(chat)); }
  catch { throw new Error('Cannot save this chat. Keep your text and try again.'); }
}
function removeSaved(id: string) { localStorage.removeItem(storageKey + id); }
// Read before React restores a history entry that names a starting chat.
let restoreError = '';
try {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(storageKey)) continue;
    const chat = JSON.parse(localStorage.getItem(key) ?? 'null') as StartingChat;
    if (chat?.id && chat.envId && chat.startParams) chats.set(chat.id, chat);
    else throw new Error('Invalid saved start');
  }
} catch { restoreError = 'Cannot read saved chats. Check browser storage and reload.'; }
export const startingChatsError = () => restoreError;
function owner(client: Client) {
  if (!client.token) return 'local';
  try {
    const claims = JSON.parse(atob(client.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return claims.net && claims.sub ? JSON.stringify([claims.net, claims.sub]) : undefined;
  } catch { return undefined; }
}
const active = new Set<string>();
export function restoreStartingChats(client: Client, online: string[]) {
  const restored: StartingChat[] = [];
  const identity = owner(client);
  if (!identity) { restoreError = 'Cannot check this device. Sign in again.'; return restored; }
  for (const chat of chats.values()) {
    if (chat.owner !== identity || !chat.startParams || !online.includes(chat.envId) || active.has(chat.id)) continue;
    if (runs.has(chat.id)) continue;
    runs.set(chat.id, () => client.rpc<{ session: Session }>(chat.envId, 'session.start',
      { ...chat.startParams, startId: chat.id }, 120_000).then(r => r.session));
    restored.push(chat);
    attempt(client, chat);
  }
  return restored;
}

/**
 * Chats that came up with nothing sent in them. One is known to be empty,
 * so it can stay on the empty page its placeholder showed rather than
 * "Loading…" while its history is fetched. Only until that history is in.
 */
const cameUpEmpty = new Set<string>();
export const startedEmpty = (sessionId: string) => cameUpEmpty.has(sessionId);
export const loadedChat = (sessionId: string) => { cameUpEmpty.delete(sessionId); };

/**
 * How each chat started here came up, by its placeholder's id and, once up,
 * by its session id. An unused chat is let go when you leave it; going back
 * to it starts the same chat again rather than an empty page.
 */
const origins = new Map<string, { info: StartInfo; run: () => Promise<Session> }>();

const notify = (chat: StartingChat) => { for (const l of listeners) l(chat); };

export function startingChat(id: string): StartingChat | undefined { return chats.get(id); }

export function onStartingChat(listener: (chat: StartingChat) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Start a chat in the background and return its placeholder at once. */
export function beginChat(client: Client, info: StartInfo, run: () => Promise<Session>, draft = ''): StartingChat {
  const identity = owner(client);
  if (!identity) throw new Error('Cannot check this device. Sign in again.');
  const chat: StartingChat = { ...info, owner: identity, id: newMessageId(), state: 'starting', message: '', draft, since: Date.now() };
  persist(chat);
  chats.set(chat.id, chat);
  runs.set(chat.id, info.startParams
    ? () => client.rpc<{ session: Session }>(info.envId, 'session.start', { ...info.startParams, startId: chat.id }, 120_000).then(r => r.session)
    : run);
  origins.set(chat.id, { info, run });
  attempt(client, chat);
  return chat;
}

/** The same chat again, from a placeholder's id or a session id; undefined when it did not start here. */
export function startAgain(client: Client, key: string, draft = ''): StartingChat | undefined {
  const origin = origins.get(key);
  return origin && beginChat(client, origin.info, origin.run, draft);
}

function attempt(client: Client, chat: StartingChat) {
  if (active.has(chat.id)) return;
  active.add(chat.id);
  chat.state = 'starting'; chat.error = undefined; chat.since = Date.now();
  notify(chat);
  runs.get(chat.id)!().then(
    async (session) => {
      chat.session = session;
      const origin = origins.get(chat.id);
      if (origin) origins.set(session.id, origin);
      // Save the target before delivery. Reloads repeat this exact delivery ID.
      persist(chat);
      const deliver = async () => {
        if (!chat.message) { removeSaved(chat.id); return; }
        try {
          await Promise.resolve().then(() => client.input(chat.envId, { id: session.id, data: chat.message }, 120_000, chat.messageId));
        } catch (error) {
          // The saved failure card already owns these words.
          const failure = error as { deliveryRetained?: boolean; deliveryPersisted?: boolean };
          if (failure?.deliveryRetained === true) {
            if (failure.deliveryPersisted === true) removeSaved(chat.id);
            return;
          }
          if (retryableDelivery(error)) return;
          chat.draft = [chat.message, loadDraft(chat.envId, session.id)].filter(Boolean).join('\n\n');
          localStorage.setItem(`helm-draft:${chat.envId}:${session.id}`, chat.draft);
          // Keep the start copy if saving the live draft failed.
          removeSaved(chat.id);
          window.dispatchEvent(new CustomEvent('helm:restore-draft', {
            detail: { env: chat.envId, id: session.id, text: chat.message },
          }));
          return;
        }
        // A cleanup failure cannot turn accepted words into a fresh draft.
        removeSaved(chat.id);
      };
      if (chat.draft) localStorage.setItem(`helm-draft:${chat.envId}:${session.id}`, chat.draft);
      void deliver().catch(() => { /* The saved start still holds the text. */ });
      active.delete(chat.id);
      chat.state = 'started';
      if (!chat.message) cameUpEmpty.add(session.id);
      runs.delete(chat.id);
      notify(chat);
    },
  ).catch((e) => {
    active.delete(chat.id); chat.state = 'failed'; chat.error = errorMessage(e);
    try { persist(chat); } catch { /* Keep the last saved copy. */ }
    notify(chat);
  });
}

export function retryChat(client: Client, id: string) {
  const chat = chats.get(id);
  if (chat?.state === 'failed') attempt(client, chat);
}

/** Queue a message for when the agent is ready. */
export function sendWhenReady(id: string, text: string) {
  const chat = chats.get(id);
  if (!chat || !text.trim()) return;
  const next = { ...chat, message: chat.message ? `${chat.message}\n\n${text}` : text, messageId: chat.messageId ?? newMessageId(), draft: '' };
  persist(next);
  Object.assign(chat, next);
  notify(chat);
}

/** Take a queued message back into the box. */
export function unsendChat(id: string) {
  const chat = chats.get(id);
  if (!chat || chat.session || !chat.message) return;
  const next = { ...chat, draft: chat.draft ? `${chat.message}\n\n${chat.draft}` : chat.message, message: '', messageId: undefined };
  persist(next);
  Object.assign(chat, next);
  notify(chat);
}

export function draftChat(id: string, text: string) {
  const chat = chats.get(id);
  if (chat && chat.state !== 'started') { persist({ ...chat, draft: text }); chat.draft = text; }
}

/** Done with a placeholder: its chat has opened, or it was given up on. */
export function forgetChat(id: string) { chats.delete(id); runs.delete(id); }
