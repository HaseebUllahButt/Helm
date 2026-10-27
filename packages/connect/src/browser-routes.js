import { BrowserManager } from './browser.js';

export function createBrowserRoutes({ sessions, manager = new BrowserManager({ session: id => sessions.get(id) }) } = {}) {
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
      if (method === 'browser.open') return manager.open(p.id, p);
      if (method === 'browser.action') return manager.run(p.id, p.tabId, p.action);
      if (method === 'browser.close') return manager.close(p.id, p.tabId);
      throw new Error(`unknown browser method: ${method}`);
    },
  };
}
