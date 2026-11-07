// Helm in the owner's own browser. Helm's agents open tabs here, in the
// background, in a folded "Helm" tab group, and drive them through Chromium's
// debugger channel. The owner's own tabs stay theirs: this add-on attaches
// only to tabs Helm opened, and to popups those tabs open.
//
// Helm writes helm-link.json into this folder: the port of its local link
// and a key. Each connection proves both sides hold the key before this
// add-on obeys anything.

const GROUP = 'Helm';
const STORE = 'helmTabs';
const enc = new TextEncoder();
/** Tabs Helm drives: tabId -> { targetId }. Kept in session storage, so a worker restart keeps them. */
const tabs = new Map();
let socket = null, ready = false, key = null, retryAt = 0, quickUntil = 0, timer = null;

const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
const nonce = () => hex(crypto.getRandomValues(new Uint8Array(16)));
async function sign(text) {
  const raw = new Uint8Array(key.match(/../g).map(pair => parseInt(pair, 16)));
  const secret = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', secret, enc.encode(text)));
}
const send = message => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
const say = (event, fields) => { if (ready) send({ event, ...fields }); };
const save = () => chrome.storage.session.set({ [STORE]: [...tabs].map(([tabId, value]) => ({ tabId, ...value })) }).catch(() => {});

async function targetOf(tabId) {
  const targets = await chrome.debugger.getTargets();
  return targets.find(t => t.tabId === tabId)?.id || `tab-${tabId}`;
}

async function attach(tabId) {
  try { await chrome.debugger.attach({ tabId }, '1.3'); }
  catch (error) {
    if (!/already attached/i.test(String(error?.message || error))) throw error;
    // A worker restart keeps the attachment; start it fresh so nothing half done stays on it.
    await chrome.debugger.detach({ tabId }).catch(() => {});
    await chrome.debugger.attach({ tabId }, '1.3');
  }
  // A background tab would otherwise slow its timers and stop drawing.
  await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: 'ON' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#6d5efc' }).catch(() => {});
  chrome.action.setTitle({ tabId, title: 'A Helm agent uses this tab' }).catch(() => {});
}

/** Agent tabs sit together in one folded group per window, out of the owner's way. */
async function group(tab) {
  try {
    const [existing] = await chrome.tabGroups.query({ windowId: tab.windowId, title: GROUP });
    const groupId = await chrome.tabs.group({ tabIds: [tab.id], ...(existing ? { groupId: existing.id } : { createProperties: { windowId: tab.windowId } }) });
    const [active] = await chrome.tabs.query({ windowId: tab.windowId, active: true });
    await chrome.tabGroups.update(groupId, { title: GROUP, color: 'purple', collapsed: active?.groupId !== groupId });
  } catch { /* the browser has no tab groups */ }
}

async function adopt(tab, fields = {}) {
  await attach(tab.id);
  const targetId = await targetOf(tab.id);
  tabs.set(tab.id, { targetId }); save();
  void group(tab);
  return { tabId: tab.id, targetId, url: tab.pendingUrl || tab.url || 'about:blank', title: tab.title || '', ...fields };
}

const commands = {
  async 'tabs.create'() {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
    let tab;
    if (win?.id != null) tab = await chrome.tabs.create({ windowId: win.id, url: 'about:blank', active: false });
    else tab = (await chrome.windows.create({ url: 'about:blank', focused: false, state: 'normal' })).tabs[0];
    return adopt(tab);
  },
  async 'tabs.close'({ tabId }) {
    if (!tabs.has(tabId)) return { closed: false };
    tabs.delete(tabId); save();
    await chrome.tabs.remove(tabId).catch(() => {});
    return { closed: true };
  },
  async cdp({ tabId, sessionId, method, params }) {
    if (!tabs.has(tabId)) throw new Error('Helm does not use this tab');
    return await chrome.debugger.sendCommand(sessionId ? { tabId, sessionId } : { tabId }, method, params || {}) || {};
  },
  async ping() { return {}; },
  async reload() { setTimeout(() => chrome.runtime.reload(), 100); return {}; },
};

async function hello(challenge) {
  const answer = nonce();
  const known = [];
  for (const [tabId, value] of tabs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab) known.push({ tabId, targetId: value.targetId, url: tab.url || 'about:blank', title: tab.title || '' });
  }
  send({ type: 'hello', proof: await sign(`helm-extension:${challenge}`), nonce: answer, version: chrome.runtime.getManifest().version, userAgent: navigator.userAgent, tabs: known });
  return answer;
}

async function connect() {
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  if (Date.now() < retryAt) return;
  let link;
  try { link = await (await fetch(chrome.runtime.getURL('helm-link.json'), { cache: 'no-store' })).json(); } catch { retryAt = Date.now() + 5000; return; }
  if (!Number.isInteger(link?.port) || !/^[0-9a-f]{64}$/.test(link?.key || '')) { retryAt = Date.now() + 5000; return; }
  key = link.key; ready = false;
  const ws = new WebSocket(`ws://127.0.0.1:${link.port}/extension`);
  socket = ws;
  let expected = null;
  ws.onmessage = async ({ data }) => {
    let message; try { message = JSON.parse(data); } catch { return; }
    if (message.type === 'challenge') { expected = await sign(`helm-relay:${await hello(message.nonce)}`); return; }
    if (message.type === 'welcome') { ready = !!expected && message.proof === expected; if (!ready) ws.close(); else quickUntil = 0; return; }
    if (!ready || message.id == null) return;
    const run = commands[message.method];
    try { if (!run) throw new Error(`unknown command ${message.method}`); send({ id: message.id, result: await run(message.params || {}) }); }
    catch (error) { send({ id: message.id, error: String(error?.message || error) }); }
  };
  ws.onclose = event => {
    if (socket !== ws) return;
    socket = null; ready = false;
    // Helm restarts after every update: try again quickly for a minute.
    if (event.code === 4001) retryAt = Date.now() + 25000; else if (!quickUntil) quickUntil = Date.now() + 60000;
    soon();
  };
  ws.onerror = () => {};
}

/** Try again in a second while Helm is restarting; the alarm covers longer gaps. */
function soon() {
  clearTimeout(timer);
  if (Date.now() > quickUntil) return;
  timer = setTimeout(() => { chrome.runtime.getPlatformInfo(() => {}); void connect().finally(soon); }, 1000);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (tabs.has(source.tabId)) say('cdp', { tabId: source.tabId, sessionId: source.sessionId, method, params });
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (!tabs.has(source.tabId)) return;
  tabs.delete(source.tabId); save();
  chrome.action.setBadgeText({ tabId: source.tabId, text: '' }).catch(() => {});
  say('detached', { tabId: source.tabId, reason });
});
chrome.tabs.onRemoved.addListener(tabId => {
  if (!tabs.has(tabId)) return;
  tabs.delete(tabId); save();
  say('removed', { tabId });
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (tabs.has(tabId) && (change.url || change.title)) say('updated', { tabId, url: tab.url, title: tab.title || '' });
  // The badge clears on each page load.
  if (tabs.has(tabId) && change.status === 'loading') chrome.action.setBadgeText({ tabId, text: 'ON' }).catch(() => {});
});
// A popup an agent tab opens belongs to the same agent.
chrome.tabs.onCreated.addListener(tab => {
  if (!ready || tab.openerTabId == null || !tabs.has(tab.openerTabId)) return;
  void adopt(tab, { openerTabId: tab.openerTabId }).then(info => say('added', info)).catch(() => {});
});

chrome.alarms.create('helm-connect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => void connect());
chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => void connect());

(async () => {
  const stored = (await chrome.storage.session.get(STORE).catch(() => ({})))[STORE] || [];
  for (const { tabId, targetId } of stored) if (await chrome.tabs.get(tabId).catch(() => null)) tabs.set(tabId, { targetId });
  quickUntil = Date.now() + 60000;
  await connect(); soon();
})();
