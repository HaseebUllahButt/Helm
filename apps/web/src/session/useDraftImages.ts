import { useCallback, useEffect, useMemo, useState, type SetStateAction } from 'react';
import { txn } from '../idb';

type Image = { name: string; mime: string; data: string; url: string };
type StoredImage = Omit<Image, 'url'>;
// A remounted chat waits for its previous mount's writes before reading.
const writes = new Map<string, Promise<void>>();

/** Unsent images belong to the chat, even when its page or view closes. */
export function useDraftImages<T extends Image>(env: string, session: string, onError: (message: string) => void) {
  const scope = useMemo(() => ({
    key: `draft-images:${env}:${session}`, images: [] as T[],
    ready: Promise.resolve(), active: false, pending: 0,
  }), [env, session]);
  const [state, setState] = useState({ scope, images: [] as T[], loading: true, saving: false });

  useEffect(() => {
    let cancelled = false;
    scope.active = true;
    const previous = writes.get(scope.key);
    scope.ready = (async () => {
      try {
        await previous;
        const saved = await txn<StoredImage[] | undefined>('kv', 'readonly', store => store.get(scope.key));
        if (cancelled) return;
        scope.images = (saved ?? []).map(image => ({ ...image, url: `data:${image.mime};base64,${image.data}` }) as T);
      } catch {
        if (!cancelled) onError('Saved draft images could not be restored on this device.');
      }
      if (!cancelled) setState({ scope, images: scope.images, loading: false, saving: scope.pending > 0 });
    })();
    return () => { cancelled = true; scope.active = false; };
  }, [scope, onError]);

  const setImages = useCallback((next: SetStateAction<T[]>): Promise<void> => {
    scope.pending++;
    setState(now => now.scope === scope ? { ...now, saving: true } : now);
    const operation = (writes.get(scope.key) ?? Promise.resolve()).then(async () => {
      await scope.ready;
      scope.images = typeof next === 'function' ? next(scope.images) : next;
      try {
        // Store the bytes once; preview URLs are reconstructed on restore.
        const saved = scope.images.map(({ name, mime, data }) => ({ name, mime, data }));
        if (saved.length) await txn('kv', 'readwrite', store => store.put(saved, scope.key));
        else await txn('kv', 'readwrite', store => store.delete(scope.key));
      } catch {
        if (scope.active) onError('Draft images could not be saved on this device. Keep this tab open to avoid losing them.');
      }
      scope.pending--;
      // Show added previews after their write commits, so a refresh directly
      // after an image appears can recover its bytes.
      if (scope.active) setState({ scope, images: scope.images, loading: false, saving: scope.pending > 0 });
    });
    writes.set(scope.key, operation);
    void operation.then(() => { if (writes.get(scope.key) === operation) writes.delete(scope.key); });
    return operation;
  }, [scope, onError]);

  return {
    images: state.scope === scope ? state.images : [], setImages,
    loading: state.scope !== scope || state.loading,
    saving: state.scope === scope && state.saving,
  };
}
