import { useCallback, useEffect, useRef, useState } from 'react';
import { draftFailure, loadDraft, reportDraftFailure, saveDraft } from './draftStore';

/** Keep storage errors visible until a later save succeeds. */
export function useDraftStorage(env: string, id: string) {
  const [initial] = useState(() => {
    const held = draftFailure(env, id);
    try { return { text: held?.text ?? loadDraft(env, id), error: held?.message ?? '', unread: !!held?.unread }; }
    catch (error) { return { text: held?.text ?? '', error: (error as Error).message, unread: true }; }
  });
  const [error, setError] = useState(initial.error);
  const unseen = useRef(initial.unread);
  const unsaved = useRef(!!initial.error);
  useEffect(() => {
    const onError = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail.env === env && detail.session === id) { if (detail.unread) unseen.current = true; unsaved.current = true; setError(detail.message); }
    };
    window.addEventListener('helm:draft-error', onError);
    return () => window.removeEventListener('helm:draft-error', onError);
  }, [env, id]);
  const save = useCallback((text: string) => {
    // Do not overwrite words that could not be read on entry.
    if (unseen.current) {
      reportDraftFailure(env, id, 'Cannot read the saved draft. Check browser storage and reload.', text, true);
      return false;
    }
    try { saveDraft(env, id, text); unsaved.current = false; setError(''); return true; }
    catch (failure) { reportDraftFailure(env, id, (failure as Error).message, text); return false; }
  }, [env, id]);
  return { initial: initial.text, error, save, isSaved: () => !unsaved.current };
}
