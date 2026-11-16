// The link between Helm and its add-on in the owner's own browser.
//
// The add-on connects here and drives tabs through Chromium's debugger
// channel. Helm's browser driver (Patchright) connects to the other end as if
// this were a normal Chromium debugging port, so every browser action works
// the same in both modes. Only tabs the add-on opened for Helm, and popups
// they open, are visible here: the owner's own tabs never are.
//
// Each profile of the owner's browser runs its own copy of the add-on, and
// each copy connects here with its profile's mark. A new tab opens in the
// profile Helm names; every later step goes to the copy that holds the tab.
//
// Ideas and traps borrowed from opencode's Browse (MIT): new tabs start blank
// and go to their address only after the driver has set the page up, and
// browser-wide cookie, cache and close commands are refused.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { WebSocketServer } from 'ws';

/** The add-on's public key from its manifest fixes its id in every browser. */
export const extensionIdFromKey = base64 => [...createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex').slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');

// The driver may not change things for the owner's whole browser.
const REFUSED = new Set(['Browser.close', 'Browser.crash', 'Target.createBrowserContext', 'Target.disposeBrowserContext', 'Target.activateTarget',
  'Storage.getCookies', 'Storage.setCookies', 'Storage.clearCookies', 'Storage.clearDataForOrigin', 'Storage.clearDataForStorageKey',
  'Network.getAllCookies', 'Network.clearBrowserCookies', 'Network.clearBrowserCache', 'Network.deleteCookies', 'Network.setCookie', 'Network.setCookies']);
// Browser-wide settings: accepted and left as the owner has them.
const IGNORED = new Set(['Browser.setDownloadBehavior', 'Browser.grantPermissions', 'Browser.resetPermissions', 'Browser.setPermission', 'Page.bringToFront', 'Target.setRemoteLocations']);
const CONTEXT = 'helm-owner-browser';
const sign = (key, text) => createHmac('sha256', Buffer.from(key, 'hex')).update(text).digest('hex');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class ExtensionRelay {
  /**
   * `linkFile` is helm-link.json in the add-on's folder: the add-on reads the
   * port and key from it on each connection attempt.
   */
  constructor({ linkFile, extensionId, commandMs = 30000, version = '' }) {
    this.linkFile = linkFile; this.extensionId = extensionId; this.commandMs = commandMs; this.version = version;
    this.key = randomBytes(32).toString('hex'); this.token = randomBytes(18).toString('base64url');
    this.links = new Map(); this.pending = new Map(); this.nextId = 1; this.tabs = new Map(); this.children = new Map(); this.clients = new Set(); this.waiters = new Set();
    this.info = { userAgent: '', version: '' }; this.serial = 0; this.reloaded = new Set();
  }
  get connected() { return this.links.size > 0; }
  /** The marks of the connected profiles, the first connected first. */
  get profiles() { return [...this.links.keys()]; }
  get cdpUrl() { return `ws://127.0.0.1:${this.port}/cdp/${this.token}`; }

  async start() {
    if (this.server) return this;
    const server = createServer((req, res) => { res.writeHead(404).end(); });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
    server.on('upgrade', (req, sock, head) => {
      const path = (req.url || '').split('?')[0];
      // Only this machine, only the add-on's own page, only the driver with the token.
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      const host = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '');
      const isExtension = path === '/extension' && req.headers.origin === `chrome-extension://${this.extensionId}`;
      const isDriver = path === `/cdp/${this.token}` && !req.headers.origin;
      if (!local || !host || (!isExtension && !isDriver)) { sock.destroy(); return; }
      wss.handleUpgrade(req, sock, head, ws => isExtension ? this.acceptExtension(ws) : this.acceptClient(ws));
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    this.server = server; this.wss = wss; this.port = server.address().port;
    await this.writeLink();
    this.pinger = setInterval(() => { if (this.connected) void this.callAll('ping', {}, 10000); }, 20000); this.pinger.unref?.();
    return this;
  }
  async writeLink() {
    mkdirSync(dirname(this.linkFile), { recursive: true, mode: 0o700 });
    const temp = `${this.linkFile}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify({ port: this.port, key: this.key }), { mode: 0o600 });
    await rename(temp, this.linkFile);
  }
  async stop() {
    clearInterval(this.pinger);
    // Every socket, also one still proving itself.
    for (const ws of this.wss?.clients || []) ws.terminate();
    this.wss?.close(); this.server?.closeAllConnections();
    await new Promise(resolve => this.server ? this.server.close(() => resolve()) : resolve());
    this.server = null;
  }
  /** Resolves once the add-on is connected (in a profile `want` accepts), or false after `ms`. */
  waitForExtension(ms = 3000, want = () => true) {
    if (this.profiles.some(want)) return Promise.resolve(true);
    return new Promise(resolve => {
      const done = value => { clearTimeout(timer); this.waiters.delete(check); resolve(value); };
      const check = profile => { if (want(profile)) done(true); };
      const timer = setTimeout(() => done(false), ms); timer.unref?.();
      this.waiters.add(check);
    });
  }

  // ---------- The add-on ----------
  acceptExtension(ws) {
    const link = { ws, ready: false, challenge: randomBytes(16).toString('hex') };
    const timer = setTimeout(() => { if (!link.ready) ws.terminate(); }, 10000); timer.unref?.();
    ws.on('message', raw => {
      let message; try { message = JSON.parse(raw); } catch { return; }
      if (!link.ready) {
        if (message.type !== 'hello' || !same(message.proof, sign(this.key, `helm-extension:${link.challenge}`)) || typeof message.nonce !== 'string') { ws.close(); return; }
        // One browser at a time, one link per profile: another is told to try later.
        // An add-on from before profile marks counts as one profile.
        const profile = /^[0-9a-f]{32}$/.test(message.profile || '') ? message.profile : 'unmarked';
        const userAgent = String(message.userAgent || '');
        if (this.links.has(profile) || (this.connected && userAgent !== this.info.userAgent)) { ws.close(4001, 'another browser is connected'); return; }
        link.ready = true; link.profile = profile; clearTimeout(timer);
        ws.send(JSON.stringify({ type: 'welcome', proof: sign(this.key, `helm-relay:${message.nonce}`) }));
        this.links.set(profile, link);
        this.info = { userAgent, version: String(message.version || '') };
        // An add-on of another version loads Helm's copy, once: a copy from
        // another folder must not reload again and again.
        if (this.version && message.version !== this.version && !this.reloaded.has(profile)) { this.reloaded.add(profile); void this.send(link, 'reload', {}).catch(() => {}); }
        // After Helm restarts the add-on still holds the tabs it opened.
        for (const tab of Array.isArray(message.tabs) ? message.tabs : []) this.addTab(tab, false, link);
        for (const check of [...this.waiters]) check(profile);
        return;
      }
      if (message.id != null) {
        const waiting = this.pending.get(message.id); if (!waiting || waiting.link !== link) return;
        this.pending.delete(message.id); clearTimeout(waiting.timer);
        if (message.error) waiting.reject(new Error(message.error)); else waiting.resolve(message.result || {});
      } else this.onEvent(message, link);
    });
    ws.on('close', () => {
      clearTimeout(timer);
      if (!link.ready || this.links.get(link.profile) !== link) return;
      this.links.delete(link.profile);
      for (const [id, waiting] of this.pending) if (waiting.link === link) { this.pending.delete(id); clearTimeout(waiting.timer); waiting.reject(new Error('Your browser closed its link to Helm.')); }
      // The driver sees a closed browser: Helm keeps the chats' tabs asleep.
      if (!this.connected) { this.tabs.clear(); this.children.clear(); for (const client of this.clients) client.ws.close(); return; }
      // One profile went: only its tabs close.
      for (const tab of [...this.tabs.values()]) if (tab.link === link) this.dropTab(tab.tabId);
    });
    ws.send(JSON.stringify({ type: 'challenge', nonce: link.challenge }));
  }
  /** A command for the add-on: in the profile that holds the tab, else the first connected profile. */
  call(method, params = {}, ms = this.commandMs) {
    const link = this.tabs.get(params.tabId)?.link || this.links.values().next().value;
    if (!link) return Promise.reject(new Error('Your browser is not connected to Helm.'));
    return this.send(link, method, params, ms);
  }
  /** Ping or reload each profile's add-on. */
  callAll(method, params = {}, ms = this.commandMs) { return Promise.allSettled([...this.links.values()].map(link => this.send(link, method, params, ms))); }
  send(link, method, params, ms = this.commandMs) {
    if (this.links.get(link.profile) !== link) return Promise.reject(new Error('Your browser is not connected to Helm.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Your browser did not answer ${method}.`)); }, ms); timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, link });
      link.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  addTab({ tabId, targetId, url = 'about:blank', title = '', openerTabId }, waiting = false, link = null) {
    if (!Number.isInteger(tabId) || typeof targetId !== 'string') return null;
    const existing = this.tabs.get(tabId); if (existing) return existing;
    const tab = { tabId, targetId, url, title, link, profile: link?.profile, sessionId: `helm-tab-${tabId}-${++this.serial}`, openerId: openerTabId != null ? this.tabs.get(openerTabId)?.targetId : undefined };
    this.tabs.set(tabId, tab);
    for (const client of this.clients) if (client.autoAttach) this.announce(client, tab, waiting);
    for (const client of this.clients) if (client.discover) this.emit(client, 'Target.targetCreated', { targetInfo: this.targetInfo(tab) });
    return tab;
  }
  dropTab(tabId) {
    const tab = this.tabs.get(tabId); if (!tab) return;
    this.tabs.delete(tabId); clearTimeout(tab.castTimer);
    for (const [child, owner] of this.children) if (owner === tabId) this.children.delete(child);
    for (const client of this.clients) {
      if (client.announced.delete(tab.sessionId)) this.emit(client, 'Target.detachedFromTarget', { sessionId: tab.sessionId, targetId: tab.targetId });
      this.emit(client, 'Target.targetDestroyed', { targetId: tab.targetId });
    }
  }
  onEvent(message, link) {
    if (message.event === 'added') { this.addTab(message, false, link); return; }
    const tab = this.tabs.get(message.tabId); if (!tab || tab.link !== link) return;
    if (message.event === 'removed' || message.event === 'detached') { this.dropTab(message.tabId); return; }
    if (message.event === 'updated') {
      if (typeof message.url === 'string') tab.url = message.url; if (typeof message.title === 'string') tab.title = message.title;
      for (const client of this.clients) if (client.discover || client.autoAttach) this.emit(client, 'Target.targetInfoChanged', { targetInfo: this.targetInfo(tab) });
      return;
    }
    if (message.event !== 'cdp' || typeof message.method !== 'string') return;
    const params = message.params || {};
    if (message.method === 'Target.attachedToTarget' && params.sessionId) this.children.set(params.sessionId, tab.tabId);
    if (message.method === 'Target.detachedFromTarget' && params.sessionId) this.children.delete(params.sessionId);
    // Frames of Helm's own recording are answered here and never reach the driver.
    if (message.method === 'Page.screencastFrame' && !message.sessionId && tab.casting && !tab.driverCast) {
      void this.call('cdp', { tabId: tab.tabId, method: 'Page.screencastFrameAck', params: { sessionId: params.sessionId } }).catch(() => {});
      return;
    }
    const main = message.method === 'Page.frameNavigated' && !message.sessionId && !params.frame?.parentId && params.frame?.url;
    if (main) {
      tab.url = params.frame.url;
      // Back from the first page must not reach the blank start page.
      if (tab.forgetBlank && tab.url !== 'about:blank') { tab.forgetBlank = false; void this.call('cdp', { tabId: tab.tabId, method: 'Page.resetNavigationHistory', params: {} }).catch(() => {}); }
      // A new document can drop the focus emulation that keeps a background tab drawing.
      void this.call('cdp', { tabId: tab.tabId, method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } }).catch(() => {});
    }
    const sessionId = message.sessionId || tab.sessionId;
    const viewers = [...this.clients].filter(client => client.announced.has(tab.sessionId));
    for (const client of viewers) this.emit(client, message.method, params, sessionId);
    // A page restored from the back-forward cache sends no load events; the driver waits for them (Browse found this).
    if (message.method === 'Page.frameNavigated' && params.type === 'BackForwardCacheRestore' && params.frame?.id) {
      const timestamp = performance.now() / 1000;
      for (const name of ['DOMContentLoaded', 'load']) for (const client of viewers) this.emit(client, 'Page.lifecycleEvent', { frameId: params.frame.id, loaderId: params.frame.loaderId || '', name, timestamp }, sessionId);
    }
  }

  // ---------- The driver ----------
  acceptClient(ws) {
    const client = { ws, autoAttach: false, discover: false, announced: new Set(), aliases: new Set(), tabAliases: new Map() };
    this.clients.add(client);
    if (!this.connected) { ws.close(); return; }
    ws.on('message', raw => {
      let message; try { message = JSON.parse(raw); } catch { return; }
      if (typeof message?.method !== 'string' || message.id == null) return;
      void this.command(client, message).then(
        result => this.reply(client, { id: message.id, result, ...(message.sessionId ? { sessionId: message.sessionId } : {}) }),
        error => this.reply(client, { id: message.id, error: { code: -32000, message: String(error?.message || error) }, ...(message.sessionId ? { sessionId: message.sessionId } : {}) }));
    });
    ws.on('close', () => this.clients.delete(client));
  }
  reply(client, message) { if (client.ws.readyState === 1) client.ws.send(JSON.stringify(message)); }
  emit(client, method, params, sessionId) { this.reply(client, { method, params, ...(sessionId ? { sessionId } : {}) }); }
  targetInfo(tab) { return { targetId: tab.targetId, type: 'page', title: tab.title, url: tab.url, attached: true, canAccessOpener: false, browserContextId: CONTEXT, ...(tab.openerId ? { openerId: tab.openerId } : {}) }; }
  announce(client, tab, waiting) {
    if (client.announced.has(tab.sessionId)) return;
    client.announced.add(tab.sessionId);
    this.emit(client, 'Target.attachedToTarget', { sessionId: tab.sessionId, targetInfo: this.targetInfo(tab), waitingForDebugger: waiting });
  }
  tabBySession(sessionId) { for (const tab of this.tabs.values()) if (tab.sessionId === sessionId) return tab; return null; }

  async command(client, { method, params = {}, sessionId }) {
    if (REFUSED.has(method)) throw new Error(`Helm does not run ${method} in your own browser.`);
    if (IGNORED.has(method)) return {};
    if (!sessionId || client.aliases.has(sessionId)) return this.browserCommand(client, method, params);
    const tab = this.tabBySession(sessionId) || this.tabs.get(client.tabAliases.get(sessionId));
    if (tab) {
      if (method === 'Target.getTargetInfo') return { targetInfo: this.targetInfo(tab) };
      if (method === 'Target.detachFromTarget' || method === 'Target.closeTarget') return this.browserCommand(client, method, params);
      // The driver has set the new page up: now it may go to its address.
      if (method === 'Runtime.runIfWaitingForDebugger' && sessionId === tab.sessionId) {
        const url = tab.goTo; tab.goTo = null;
        if (url) { tab.forgetBlank = true; void this.call('cdp', { tabId: tab.tabId, method: 'Page.navigate', params: { url } }).catch(() => {}); }
        return {};
      }
      if (method === 'Page.captureScreenshot') return this.screenshot(tab, params);
      if (method === 'Page.startScreencast') tab.driverCast = true;
      if (method === 'Page.stopScreencast') tab.driverCast = false;
      this.keepDrawing(tab);
      return this.call('cdp', { tabId: tab.tabId, method, params });
    }
    const owner = this.children.get(sessionId);
    if (owner != null) { const parent = this.tabs.get(owner); if (parent) this.keepDrawing(parent); return this.call('cdp', { tabId: owner, sessionId, method, params }); }
    throw new Error(`No tab for session ${sessionId}.`);
  }
  /**
   * A background tab draws no frames, so the driver's click waits for a
   * frame that never comes. A tiny screen recording of the tab makes it draw
   * while an agent works on it, and stops 5 s after the last step.
   */
  keepDrawing(tab) {
    if (!tab.casting && !tab.driverCast) {
      tab.casting = true;
      void this.call('cdp', { tabId: tab.tabId, method: 'Page.startScreencast', params: { format: 'jpeg', quality: 1, maxWidth: 8, maxHeight: 8 } }).catch(() => { tab.casting = false; });
    }
    clearTimeout(tab.castTimer);
    tab.castTimer = setTimeout(() => {
      if (!tab.casting || !this.tabs.has(tab.tabId)) return;
      tab.casting = false;
      void this.call('cdp', { tabId: tab.tabId, method: 'Page.stopScreencast', params: {} }).catch(() => {});
    }, 5000);
    tab.castTimer.unref?.();
  }
  /**
   * A background tab draws nothing, so its screenshot can wait forever. A
   * second capture releases the first (Browse found this). The nudge keeps
   * the size asked for, or Chromium returns a blank picture.
   */
  async screenshot(tab, params) {
    const nudge = { ...params, format: 'jpeg', quality: 1 }; if (nudge.clip) delete nudge.captureBeyondViewport;
    let stop = false; const timers = [];
    const first = this.call('cdp', { tabId: tab.tabId, method: 'Page.captureScreenshot', params });
    for (const ms of [150, 400, 800, 1400, 2200, 3500, 5500, 8500, 13000]) { const timer = setTimeout(() => { if (!stop) void this.call('cdp', { tabId: tab.tabId, method: 'Page.captureScreenshot', params: nudge }).catch(() => {}); }, ms); timer.unref?.(); timers.push(timer); }
    try { return await first; } finally { stop = true; timers.forEach(clearTimeout); }
  }
  async browserCommand(client, method, params) {
    const tabs = [...this.tabs.values()];
    switch (method) {
      case 'Browser.getVersion': {
        const version = /Chrome\/([\d.]+)/.exec(this.info.userAgent)?.[1] || '0';
        return { protocolVersion: '1.3', product: `Chrome/${version}`, revision: '', userAgent: this.info.userAgent, jsVersion: '' };
      }
      case 'Target.setDiscoverTargets':
        client.discover = !!params.discover;
        if (client.discover) for (const tab of tabs) this.emit(client, 'Target.targetCreated', { targetInfo: this.targetInfo(tab) });
        return {};
      case 'Target.setAutoAttach':
        client.autoAttach = !!params.autoAttach;
        if (client.autoAttach) for (const tab of tabs) this.announce(client, tab, false);
        return {};
      case 'Target.getTargets': return { targetInfos: tabs.map(tab => this.targetInfo(tab)) };
      case 'Target.getBrowserContexts': return { browserContextIds: [] };
      case 'Target.getTargetInfo': {
        const tab = params.targetId && tabs.find(t => t.targetId === params.targetId);
        return { targetInfo: tab ? this.targetInfo(tab) : { targetId: 'helm-browser', type: 'browser', title: '', url: '', attached: true, canAccessOpener: false } };
      }
      case 'Target.attachToBrowserTarget': { const alias = `helm-browser-${++this.serial}`; client.aliases.add(alias); return { sessionId: alias }; }
      case 'Target.attachToTarget': {
        const tab = tabs.find(t => t.targetId === params.targetId); if (!tab) throw new Error(`No target ${params.targetId}.`);
        if (!client.announced.has(tab.sessionId)) { this.announce(client, tab, false); return { sessionId: tab.sessionId }; }
        // A second session on a page the driver already drives: its own name,
        // so detaching it leaves the page's main session alone.
        const alias = `helm-alias-${++this.serial}`; client.tabAliases.set(alias, tab.tabId); return { sessionId: alias };
      }
      case 'Target.detachFromTarget':
        if (!client.tabAliases.delete(params.sessionId) && !client.aliases.delete(params.sessionId)) client.announced.delete(params.sessionId);
        return {};
      case 'Target.createTarget': {
        // Helm names the profile (helmProfile); else the first connected one.
        const link = this.links.get(params.helmProfile) || (params.helmProfile ? null : this.links.values().next().value);
        if (!link) throw new Error('That profile of your browser is not connected to Helm.');
        const info = await this.send(link, 'tabs.create', {});
        const url = String(params.url || 'about:blank');
        // The tab waits on a blank page until the driver has set it up.
        const tab = this.addTab(info, true, link);
        if (!tab) throw new Error('Your browser did not open a tab.');
        if (url !== 'about:blank') tab.goTo = url;
        return { targetId: tab.targetId };
      }
      case 'Target.closeTarget': {
        const tab = tabs.find(t => t.targetId === params.targetId); if (!tab) return { success: false };
        await this.call('tabs.close', { tabId: tab.tabId }); this.dropTab(tab.tabId); return { success: true };
      }
      case 'Browser.getWindowForTarget': return { windowId: 1, bounds: { windowState: 'normal' } };
      default: throw new Error(`${method} is not available in your own browser through Helm.`);
    }
  }
}
