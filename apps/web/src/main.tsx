import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { AppUpdate } from './AppUpdate';
import { AppErrorBoundary } from './AppErrorBoundary';
import { applyAppearance, watchSystemTheme } from './appearance';
import { clearRefreshMarker } from './reload';

clearRefreshMarker();

// Before the first render, so a light-theme device never flashes dark.
applyAppearance();
watchSystemTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode><AppErrorBoundary><App /><AppUpdate /></AppErrorBoundary></StrictMode>
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

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    refreshWorker();
  }
});
