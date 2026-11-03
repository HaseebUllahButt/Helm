/**
 * Half-typed prompts, kept per session.
 *
 * A draft is the cheapest thing to keep and the most annoying thing to
 * lose: navigating to answer another session's question, a swipe that kills
 * the PWA, or a socket hiccup that re-mounts the view all used to take the
 * sentence with them. localStorage, not IDB - a draft is a few hundred
 * bytes that are wanted synchronously at mount, before any promise resolves.
 *
 * Keys carry env+session so the same thread on two machines and two threads
 * on one never share a draft.
 */
const KEY = (env: string, session: string) => `helm-draft:${env}:${session}`;
const failures = new Map<string, string>();

export function draftFailure(env: string, session: string) { return failures.get(KEY(env, session)) ?? ''; }
export function reportDraftFailure(env: string, session: string, message: string) {
  failures.set(KEY(env, session), message);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('helm:draft-error', { detail: { env, session, message } }));
}

export function loadDraft(env: string, session: string): string {
  try { return localStorage.getItem(KEY(env, session)) ?? ''; }
  catch { throw new Error('Cannot read the saved draft. Check browser storage and reload.'); }
}

export function saveDraft(env: string, session: string, text: string) {
  try {
    if (text) localStorage.setItem(KEY(env, session), text);
    else localStorage.removeItem(KEY(env, session));
    failures.delete(KEY(env, session));
  } catch {
    throw new Error(text
      ? 'Cannot save this draft. Keep this chat open to keep your words.'
      : 'Cannot clear the saved draft. Old words may return.');
  }
}
