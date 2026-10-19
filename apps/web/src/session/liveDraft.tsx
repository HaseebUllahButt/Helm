import { useSyncExternalStore, type ComponentProps } from 'react';
import { Composer } from './Composer';

/**
 * The words being typed, kept outside the chat screen's state. Only the
 * composer listens to them, so a key press redraws the box and not the
 * whole conversation above it.
 */
export function createLiveDraft(initial: string) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: string) {
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export type LiveDraft = ReturnType<typeof createLiveDraft>;

/** The composer, reading its words from a live draft. */
export function LiveComposer({ live, ...props }: Omit<ComponentProps<typeof Composer>, 'draft'> & { live: LiveDraft }) {
  const draft = useSyncExternalStore(live.subscribe, live.get);
  return <Composer {...props} draft={draft} />;
}
