import { useSyncExternalStore } from 'react';

const subscribe = (tell: () => void) => {
  document.addEventListener('visibilitychange', tell);
  return () => document.removeEventListener('visibilitychange', tell);
};

/** True while the page is out of sight: a background tab, a hidden window, a locked phone. */
export const usePageHidden = () => useSyncExternalStore(subscribe, () => document.hidden, () => false);
