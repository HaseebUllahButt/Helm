import { useEffect } from 'react';

/**
 * Close an open ⋯ menu on a tap anywhere else. A fixed scrim cannot do it:
 * `.bar`'s backdrop-filter makes it the containing block for fixed children,
 * so the scrim would only cover the bar. Taps on the menu itself, and on its
 * own toggle (the `aria-haspopup` one that is `aria-expanded`), are left to
 * their own handlers; another menu's toggle closes this one.
 */
export function useDismiss(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const off = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t?.closest?.('.menu, [aria-haspopup][aria-expanded="true"]')) close();
    };
    document.addEventListener('pointerdown', off);
    return () => document.removeEventListener('pointerdown', off);
  }, [open, close]);
}
