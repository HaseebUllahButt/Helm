import { useEffect, useRef } from 'react';

/**
 * The keys that change a chat without the mouse. All three carry
 * Ctrl/Cmd+Shift: the owner types in the composer most of the time, and a
 * bare letter there is a letter. Thinking is Y: E is the terminal key
 * everywhere in the app (caught first), K the palette, and the owner's
 * desktop takes Ctrl+Shift+L.
 */
export type ChatKey = 'effort' | 'model' | 'agents';

export function chatKey(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'> & { isComposing?: boolean }): ChatKey | null {
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.isComposing) return null;
  const key = e.key.toLowerCase();
  return key === 'y' ? 'effort' : key === 'm' ? 'model' : key === 'a' ? 'agents' : null;
}

/** The choice after `current`, wrapping; the first when `current` is not on the ring. */
export function nextInRing(ring: string[], current: string): string | undefined {
  if (!ring.length) return undefined;
  return ring[(ring.indexOf(current) + 1) % ring.length];
}

/**
 * The models a key steps through, in the order the sheet lists them:
 * favorites first (from either list), then the account's short list. The
 * long tail stays out - stepping through forty models is not a shortcut.
 */
export function modelRing(choices: string[], more: string[], favs: string[]): string[] {
  const favorites = [...choices, ...more].filter((id) => favs.includes(id));
  return [...new Set([...favorites, ...choices])];
}

/**
 * Listen for the chat keys. They are skipped inside a terminal, which owns
 * every Ctrl key, and while a sheet is up - except the agents key over this
 * chat's own details panel, which is how the same key closes it again.
 */
export function useChatKeys(on: Partial<Record<ChatKey, () => void>>) {
  const handlers = useRef(on);
  handlers.current = on;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const which = chatKey(e);
      if (!which || (e.target as HTMLElement | null)?.closest?.('.xterm')) return;
      const run = handlers.current[which];
      if (!run) return;
      // Stops the browser's own use of these (profile menu, tab search).
      e.preventDefault();
      if (e.repeat) return;
      const modal = [...document.querySelectorAll('[aria-modal="true"]')].at(-1);
      if (modal && !(which === 'agents' && modal.matches('.thread-details'))) return;
      run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

type DeleteTarget = { tagName?: string; value?: string; hasAttribute?: (name: string) => boolean; closest?: (selector: string) => unknown } | null;

/**
 * The Delete key deletes the chat in front of you, after the usual question.
 * The owner asked for this one bare key. It never takes a key you type: not
 * in a text box or a terminal, except an empty message box, where Delete has
 * nothing else to do. A held key does not repeat into it.
 */
export function deleteKey(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'repeat'> & { isComposing?: boolean }, target: DeleteTarget): boolean {
  if (e.key !== 'Delete' || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.repeat || e.isComposing) return false;
  if (!target?.closest) return true;
  if (target.closest('.xterm, input, select, [contenteditable]:not([contenteditable="false"])')) return false;
  if (target.tagName === 'TEXTAREA') return !!target.hasAttribute?.('data-composer') && !target.value;
  return true;
}

/** Listen for the Delete key while a chat is on screen and no sheet is up. */
export function useDeleteKey(run: (() => void) | null) {
  const handler = useRef(run);
  handler.current = run;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A sidebar row that has focus takes the key for its own chat.
      if (e.defaultPrevented || !handler.current || !deleteKey(e, e.target as DeleteTarget)) return;
      if ((e.target as HTMLElement | null)?.closest?.('.tri-row') || document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      handler.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
