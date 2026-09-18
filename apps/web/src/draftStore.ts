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

export function loadDraft(env: string, session: string): string {
  try { return localStorage.getItem(KEY(env, session)) ?? ''; } catch { return ''; }
}

export function saveDraft(env: string, session: string, text: string) {
  try {
    if (text) localStorage.setItem(KEY(env, session), text);
    else localStorage.removeItem(KEY(env, session));
  } catch { /* storage full or denied: the draft is a nicety, not state */ }
}
