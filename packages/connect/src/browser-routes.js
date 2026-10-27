import { BrowserManager } from './browser.js';

export function createBrowserRoutes({ sessions, onOpen = () => {}, manager = new BrowserManager({ session: id => sessions.get(id), changed: onOpen }) } = {}) {
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
      if (method === 'browser.profiles') return manager.profiles(p.id);
      if (method === 'browser.importLogins') return manager.importLogins(p.id, p.profileKey);
      if (method === 'browser.loginDefault') return manager.loginDefault(p.id, p.profileKey);
      if (method === 'browser.list') return manager.list(p.id, { warm: p.warm === true });
      if (method === 'browser.flows') return manager.listFlows(p.id);
      if (method === 'browser.run') return manager.runFlow(p.id, p.tabId, p.name, p.with);
      // The chat being viewed hears of a new tab, so its Browser button can say so.
      if (method === 'browser.open') { const result = await manager.open(p.id, p); onOpen({ id: p.id, tabId: result.tab.id, ...(p.viewer ? { viewer: p.viewer } : {}) }); return result; }
      if (method === 'browser.action') return manager.run(p.id, p.tabId, p.action, p.viewer || 'agent');
      if (method === 'browser.close') return manager.close(p.id, p.tabId);
      // The thread's window, brought forward on its machine's screen.
      if (method === 'browser.show') return manager.show(p.id, typeof p.tabId === 'string' ? p.tabId : undefined);
      if (method === 'browser.download') return manager.download(p.id, p.tabId, p.downloadId);
      throw new Error(`unknown browser method: ${method}`);
    },
  };
}
