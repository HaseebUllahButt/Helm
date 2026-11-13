import { discoverApps } from './browser-apps.js';
import { BrowserManager } from './browser.js';

// Chats of other machines that use this machine's browser (helm browser --machine).
const GUEST_ID = /^guest-[\w-]{1,150}$/;
const GUEST_REFUSED = new Set(['browser.openApp', 'browser.setup', 'browser.main', 'browser.mode', 'browser.loginDefault', 'browser.importLogins']);

export function createBrowserRoutes({ sessions, scanApps = discoverApps, alert, guests = new Map(), manager = new BrowserManager({ session: id => guests.get(id) || sessions.get(id), alert }) } = {}) {
  const apps = async id => scanApps(sessions.get(id), { roots: await sessions.appProcessRoots?.(id) || [] });
  return {
    manager, guests,
    stop: () => manager.stop(),
    // A deleted chat's browser goes with it: its window, tabs and sign-ins.
    sessionChanged(session) {
      if (session?.status !== 'exited') return;
      try { sessions.get(session.id); } catch { void manager.forget(session.id).catch(() => {}); }
    },
    async dispatch(method, p) {
      if (!method.startsWith('browser.')) return undefined;
      // A chat on another machine uses this browser: it gets its own tabs here.
      if (p?.guest) {
        if (GUEST_REFUSED.has(method)) throw new Error(`${method} works only on the chat's own machine`);
        if (!GUEST_ID.test(p.id || '')) throw new Error('a browser belongs to a Helm thread');
        const { chat, from, mode, title } = p.guest;
        guests.set(p.id, { id: p.id, guest: true, chat: String(chat || ''), from: String(from || ''), mode: typeof mode === 'string' ? mode : null, title: typeof title === 'string' ? title.slice(0, 200) : null });
      }
      // A local link in a terminal opens in the chat's external browser.
      if (method === 'browser.openApp') {
        const url = new URL(p.url);
        if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1'].includes(url.hostname) || url.username || url.password
          || !(await apps(p.id)).some(app => app.port === +(url.port || (url.protocol === 'https:' ? 443 : 80)))) throw new Error('This app stopped or does not belong to this chat.');
        return manager.open(p.id, { url: url.href });
      }
      // Settings: the owner's browser on this machine, with no chat.
      if (method === 'browser.setup') {
        if (p.do === 'main') return manager.setMain(p.name);
        if (p.do === 'open') return manager.ownerSetup();
        if (p.do === 'restart') return manager.setMode('extended', { restart: true });
        if (p.do === 'mode') return manager.setMode(p.mode);
        return manager.modeInfo();
      }
      if (method === 'browser.main') { if (p.id) manager.owner(p.id); return p.name ? manager.setMain(p.name) : manager.mainInfo(); }
      if (method === 'browser.mode') { manager.owner(p.id); return p.mode ? manager.setMode(p.mode, { restart: !!p.restart }) : manager.modeInfo(); }
      if (method === 'browser.profiles') return manager.profiles(p.id);
      if (method === 'browser.importLogins') return manager.importLogins(p.id, p.profileKey);
      if (method === 'browser.loginDefault') return manager.loginDefault(p.id, p.profileKey);
      if (method === 'browser.list') return manager.list(p.id);
      if (method === 'browser.flows') return manager.listFlows(p.id);
      if (method === 'browser.run') return manager.runFlow(p.id, p.tabId, p.name, p.with);
      if (method === 'browser.open') return manager.open(p.id, p);
      if (method === 'browser.action') return manager.run(p.id, p.tabId, p.action);
      if (method === 'browser.close') return manager.close(p.id, p.tabId);
      if (method === 'browser.captcha') return manager.captcha(p.id, p.tabId, { wait: p.wait, last: !!p.last });
      throw new Error(`unknown browser method: ${method}`);
    },
  };
}
