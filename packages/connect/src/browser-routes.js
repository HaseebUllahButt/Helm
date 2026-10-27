import { discoverApps } from './browser-apps.js';
import { BrowserManager } from './browser.js';

export function createBrowserRoutes({ sessions, scanApps = discoverApps, manager = new BrowserManager({ session: id => sessions.get(id) }) } = {}) {
  const apps = async id => scanApps(sessions.get(id), { roots: await sessions.appProcessRoots?.(id) || [] });
  return {
    manager,
    stop: () => manager.stop(),
    // A deleted chat's browser goes with it: its window, tabs and sign-ins.
    sessionChanged(session) {
      if (session?.status !== 'exited') return;
      try { sessions.get(session.id); } catch { void manager.forget(session.id).catch(() => {}); }
    },
    async dispatch(method, p) {
      if (!method.startsWith('browser.')) return undefined;
      // A local link in a terminal opens in the chat's external browser.
      if (method === 'browser.openApp') {
        const url = new URL(p.url);
        if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1'].includes(url.hostname) || url.username || url.password
          || !(await apps(p.id)).some(app => app.port === +(url.port || (url.protocol === 'https:' ? 443 : 80)))) throw new Error('This app stopped or does not belong to this chat.');
        return manager.open(p.id, { url: url.href });
      }
      if (method === 'browser.profiles') return manager.profiles(p.id);
      if (method === 'browser.importLogins') return manager.importLogins(p.id, p.profileKey);
      if (method === 'browser.loginDefault') return manager.loginDefault(p.id, p.profileKey);
      if (method === 'browser.list') return manager.list(p.id);
      if (method === 'browser.flows') return manager.listFlows(p.id);
      if (method === 'browser.run') return manager.runFlow(p.id, p.tabId, p.name, p.with);
      if (method === 'browser.open') return manager.open(p.id, p);
      if (method === 'browser.action') return manager.run(p.id, p.tabId, p.action);
      if (method === 'browser.close') return manager.close(p.id, p.tabId);
      throw new Error(`unknown browser method: ${method}`);
    },
  };
}
