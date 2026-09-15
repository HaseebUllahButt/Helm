import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>
);

// Registering the worker is what makes this installable to a home screen.
// It is also entirely optional - the app works without it.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
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
  if (document.visibilityState === 'visible') checkBuild();
});
