import { useCallback, useEffect, useRef, useState } from 'react';
import { draftFailure, loadDraft, saveDraft } from './draftStore';

/** Keep storage errors visible until a later save succeeds. */
export function useDraftStorage(env: string, id: string) {
  const [initial] = useState(() => {
    try { return { text: loadDraft(env, id), error: draftFailure(env, id), unread: false }; }
    catch (error) { return { text: '', error: (error as Error).message, unread: true }; }
  });
  const [error, setError] = useState(initial.error);
  const unseen = useRef(initial.unread || !!initial.error);
  useEffect(() => {
    const onError = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail.env === env && detail.session === id) { unseen.current = true; setError(detail.message); }
    };
    window.addEventListener('helm:draft-error', onError);
    return () => window.removeEventListener('helm:draft-error', onError);
  }, [env, id]);
  const save = useCallback((text: string) => {
    // Do not overwrite words that could not be read on entry.
    if (unseen.current) return;
    try { saveDraft(env, id, text); setError(''); }
    catch (failure) { setError((failure as Error).message); }
  }, [env, id]);
  return { initial: initial.text, error, save };
}
