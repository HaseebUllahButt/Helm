import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>
);

// Registering the worker is what makes this installable to a home screen,
// and it is the only thing a push notification can arrive on. The rule is a
// secure context rather than https in particular: `helm open` serves the app
// on http://127.0.0.1, which a browser still counts as secure, and a laptop
// is exactly where an OS-level notification earns its keep. A bare LAN
// address is neither, and correctly keeps getting neither.
const refreshWorker = () => {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
};

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', refreshWorker);
}

// An installed app resumes the page it loaded rather than reloading, so an
// old bundle would run until it happened to die. When the hub is serving a
// newer build - it reports the asset its index.html points at - reload once
// and run that instead.
const checkBuild = () => {
  fetch('/api/version', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((v) => {
      const own = document.querySelector<HTMLScriptElement>('script[type="module"]')?.src;
      if (v?.build && own && !own.endsWith(v.build)) location.reload();
    })
    .catch(() => { /* offline, or a dev server with no such route */ });
};
checkBuild();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    refreshWorker();
    checkBuild();
  }
});
