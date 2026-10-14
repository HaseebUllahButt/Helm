import { BrowserManager } from './browser.js';

export function createBrowserRoutes({ sessions, manager = new BrowserManager({ session: id => sessions.get(id) }), onOpen = () => {} } = {}) {
  return {
    manager,
    stop: () => manager.stop(),
    async dispatch(method, p) {
      if (!method.startsWith('browser.')) return undefined;
      if (method === 'browser.profiles') return manager.profiles(p.id);
      if (method === 'browser.importLogins') return manager.importLogins(p.id, p.profileKey);
      if (method === 'browser.loginDefault') return manager.loginDefault(p.id, p.profileKey);
      if (method === 'browser.list') return manager.list(p.id);
      if (method === 'browser.flows') return manager.listFlows(p.id);
      if (method === 'browser.run') return manager.runFlow(p.id, p.tabId, p.name, p.with);
      // The chat being viewed hears of a new tab, so its Browser button can say so.
      if (method === 'browser.open') { const result = await manager.open(p.id, p); onOpen({ id: p.id, tabId: result.tab.id, ...(p.viewer ? { viewer: p.viewer } : {}) }); return result; }
      if (method === 'browser.action') return manager.run(p.id, p.tabId, p.action, p.viewer || 'agent', p.controlEpoch);
      if (method === 'browser.frame') return manager.frame(p.id, p.tabId, p);
      if (method === 'browser.unwatch') return manager.unwatch(p.id, p.tabId, p.viewer);
      if (method === 'browser.control') return manager.control(p.id, p.tabId, p.viewer, !!p.take);
      if (method === 'browser.close') return manager.close(p.id, p.tabId);
      if (method === 'browser.download') return manager.download(p.id, p.tabId, p.downloadId);
      throw new Error(`unknown browser method: ${method}`);
    },
  };
}
