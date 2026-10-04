import { useEffect, useRef } from 'react';

/** Keep keyboard interaction in the open sheet and return to its launcher. */
export function useDialog(onClose: () => void, enabled = true) {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef(document.activeElement as HTMLElement | null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !enabled) return;
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>(
      'input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled), a[href], [tabindex="0"]',
    )].filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0);
    const first = () => (focusable()[0] ?? dialog).focus();
    const isTop = () => [...document.querySelectorAll('[aria-modal="true"]')].at(-1) === dialog;
    (dialog.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled)') ?? focusable()[0] ?? dialog).focus();
    const onKey = (event: KeyboardEvent) => {
      if (!isTop() || event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); close.current();
      } else if (event.key === 'Tab') {
        const items = focusable();
        const index = items.indexOf(document.activeElement as HTMLElement);
        if (!items.length) { event.preventDefault(); dialog.focus(); }
        else if (event.shiftKey && index <= 0) { event.preventDefault(); items.at(-1)?.focus(); }
        else if (!event.shiftKey && (index < 0 || index === items.length - 1)) { event.preventDefault(); items[0].focus(); }
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (isTop() && !dialog.contains(event.target as Node)) first();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocus);
      // Navigation may already have focused the next screen's composer.
      if (opener.current?.isConnected &&
          (document.activeElement === document.body || dialog.contains(document.activeElement))) {
        opener.current.focus();
      }
    };
  }, [enabled]);
  return ref;
}
