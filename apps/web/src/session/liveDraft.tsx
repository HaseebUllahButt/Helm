import { useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ComponentProps } from 'react';
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

type ComposerProps = ComponentProps<typeof Composer>;
const actionNames = ['setDraft', 'onSend', 'onKey', 'onStop', 'onAttach', 'onRemoveAttachment',
  'onAttachUnsupported', 'onWithdrawQueued', 'onEditQueued', 'onRemoveQueued', 'onMoveQueued',
  'onSendQueued', 'onTranscribe', 'onReference', 'onRemoveReference'] as const;

/** Stable event handlers still call the actions from the latest committed screen. */
function useComposerActions(props: Omit<ComposerProps, 'draft'>) {
  const latest = useRef(props);
  useLayoutEffect(() => { latest.current = props; });
  const actions = useMemo(() => Object.fromEntries(actionNames.map(name => [name, (...args: unknown[]) => {
    const action = latest.current[name] as ((...args: unknown[]) => unknown) | undefined;
    return action?.(...args);
  }])) as Pick<ComposerProps, typeof actionNames[number]>, []);
  return Object.fromEntries(actionNames.map(name => [name, props[name] ? actions[name] : undefined])) as typeof actions;
}

/** The composer, reading its words from a live draft. */
export function LiveComposer({ live, ...props }: Omit<ComponentProps<typeof Composer>, 'draft'> & { live: LiveDraft }) {
  const draft = useSyncExternalStore(live.subscribe, live.get);
  const actions = useComposerActions(props);
  // The log changes in place. Compare values, rather than array identity,
  // so text arriving in the transcript does not rebuild an unchanged editor.
  const historyKey = JSON.stringify(props.history);
  const queueKey = JSON.stringify(props.queued);
  const helperKey = JSON.stringify(props.helpers);
  const history = useMemo(() => props.history, [historyKey]);
  const queued = useMemo(() => props.queued, [queueKey]);
  const helpers = useMemo(() => props.helpers, [helperKey]);
  return <Composer {...props} {...actions} history={history} queued={queued} helpers={helpers} draft={draft} />;
}
