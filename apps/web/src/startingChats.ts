import { errorMessage } from './errors';
import type { Client, Session } from './client';
import { retryableDelivery } from '@helm/protocol/reliable-input';
import { loadDraft, saveDraft } from './draftStore';

/**
 * New chats whose agent is still starting.
 *
 * A CLI takes a second or more to come up - several for some agents, more
 * over a slow link - and the picker used to sit there until it had. Now the
 * chat opens at once and says it is starting; what you type meanwhile waits
 * here and goes in the moment the agent is ready, even if you have looked
 * away by then. Kept outside React (and outside browser history, which can
 * only hold plain data) so leaving the screen does not lose the start.
 */

export interface StartInfo {
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
  state: 'starting' | 'failed' | 'started';
  error?: string;
  session?: Session;
  /** What was sent before the agent was ready; goes in once it is. */
  message: string;
  /** Typed but not sent; becomes the chat's draft. */
  draft: string;
  since: number;
}

const chats = new Map<string, StartingChat>();
const runs = new Map<string, () => Promise<Session>>();
const listeners = new Set<(chat: StartingChat) => void>();
let seq = 0;

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
  const chat: StartingChat = { ...info, id: `start-${Date.now().toString(36)}-${++seq}`, state: 'starting', message: '', draft, since: Date.now() };
  chats.set(chat.id, chat);
  runs.set(chat.id, run);
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
  chat.state = 'starting'; chat.error = undefined; chat.since = Date.now();
  notify(chat);
  runs.get(chat.id)!().then(
    async (session) => {
      chat.session = session;
      const origin = origins.get(chat.id);
      if (origin) origins.set(session.id, origin);
      // Start the send as the chat opens, without waiting for agent startup or
      // its receipt. The live chat can confirm it from its saved message ID.
      if (chat.message) void Promise.resolve().then(() => client.input(chat.envId, { id: session.id, data: chat.message }))
        .catch((error) => {
          if (retryableDelivery(error)) return;
          chat.draft = [chat.message, loadDraft(chat.envId, session.id)].filter(Boolean).join('\n\n');
          saveDraft(chat.envId, session.id, chat.draft);
          window.dispatchEvent(new CustomEvent('helm:restore-draft', {
            detail: { env: chat.envId, id: session.id, text: chat.message },
          }));
        });
      chat.state = 'started';
      if (!chat.message) cameUpEmpty.add(session.id);
      if (chat.draft) saveDraft(chat.envId, session.id, chat.draft);
      runs.delete(chat.id);
      notify(chat);
    },
    (e) => { chat.state = 'failed'; chat.error = errorMessage(e); notify(chat); },
  );
}

export function retryChat(client: Client, id: string) {
  const chat = chats.get(id);
  if (chat?.state === 'failed') attempt(client, chat);
}

/** Queue a message for when the agent is ready. */
export function sendWhenReady(id: string, text: string) {
  const chat = chats.get(id);
  if (!chat || !text.trim()) return;
  chat.message = chat.message ? `${chat.message}\n\n${text}` : text;
  chat.draft = '';
  notify(chat);
}

/** Take a queued message back into the box. */
export function unsendChat(id: string) {
  const chat = chats.get(id);
  if (!chat || chat.session || !chat.message) return;
  chat.draft = chat.draft ? `${chat.message}\n\n${chat.draft}` : chat.message;
  chat.message = '';
  notify(chat);
}

export function draftChat(id: string, text: string) {
  const chat = chats.get(id);
  if (chat && chat.state !== 'started') chat.draft = text;
}

/** Done with a placeholder: its chat has opened, or it was given up on. */
export function forgetChat(id: string) { chats.delete(id); runs.delete(id); }
