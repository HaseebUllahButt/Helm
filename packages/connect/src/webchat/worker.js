// `helm webchat worker`: the program a web chat account runs as. The driver
// (drivers/webchat.js) starts it on the process host, so it lives through a
// Helm restart. It reads one JSON line per request and writes one per event:
//
//   in   {type:'ask', turnId, text, conversation, tab, history}
//        {type:'stop'}
//   out  {type:'ready'}
//        {type:'sent', turnId, tab}
//        {type:'progress', turnId, text}
//        {type:'answer', turnId, text, conversation, tab, model, restarted}
//        {type:'stopped', turnId, text}
//        {type:'error', turnId, message}
//
// Each step is a browser call for the chat, like `helm browser` makes, so
// the service keeps its checks and this program gets no new power.
import { readJsonLines } from '../drivers/index.js';
import { guestId } from '../browser-cli.js';
import { webchatConfig } from './config.js';
import { siteFor } from './sites/index.js';
import { askSite, stopSite } from './turn.js';

/**
 * The four browser calls a turn needs, for chat `sessionId`. With
 * `machineName`, the tabs open in that machine's browser, as a guest of
 * this chat (the same as helm browser --machine).
 */
export async function browserFor({ rpc, self, findSession, machine, sessionId, machineName = null }) {
  let env = self(), id = sessionId, send = rpc;
  const there = machineName ? machine(machineName) : null;
  if (there && there !== env) {
    const own = (await findSession(sessionId).catch(() => null))?.session || { id: sessionId };
    const guest = { chat: sessionId, from: env, mode: own.mode || null, title: own.title || own.name || null };
    env = there; id = guestId(self(), sessionId);
    send = (target, method, params, ms) => rpc(target, method, { ...params, guest }, ms);
  }
  const call = (method, params, ms) => send(env, method, { id, ...params }, ms);
  const act = async (tabId, action) => {
    const result = await call('browser.action', { tabId, action: { ...action, look: false } }, 75_000);
    if (result?.error) throw new Error(result.error);
    return result;
  };
  return {
    tabs: async () => (await call('browser.list', {}, 60_000)).tabs ?? [],
    open: async (url, { profile } = {}) => ({ tab: (await call('browser.open', { url, ...(profile ? { profile } : {}) }, profile ? 50_000 : 30_000)).tab }),
    tab: (tabId) => ({
      evaluate: async (script) => (await act(tabId, { evaluate: script })).value,
      goto: (url) => act(tabId, { goto: url }),
    }),
  };
}

export async function runWebchatWorker({ rpc, self, findSession, machine, env = process.env, input = process.stdin, write = (line) => process.stdout.write(line), ask = askSite, stop = stopSite }) {
  const config = webchatConfig(env);
  const site = siteFor(config.site);
  const sessionId = env.HELM_SESSION_ID;
  if (!sessionId) throw new Error('helm webchat worker runs only for a Helm chat');
  const out = (message) => write(`${JSON.stringify(message)}\n`);
  let browser = null;
  const browserReady = async () => (browser ??= await browserFor({ rpc, self, findSession, machine, sessionId, machineName: config.machine }));
  let current = null, lastTab = null;
  const queue = [];

  async function handle(m) {
    const turn = { turnId: m.turnId, stopped: false };
    current = turn;
    try {
      const b = await browserReady();
      const result = await ask(b, {
        site, question: String(m.text ?? ''), profile: config.profile, model: config.model, temporary: config.temporary,
        conversation: m.conversation ?? null, tabId: m.tab ?? lastTab, history: Array.isArray(m.history) ? m.history : [],
        stopped: () => turn.stopped,
        onProgress: (p) => {
          if (p.sent) { lastTab = p.tab; out({ type: 'sent', turnId: m.turnId, tab: p.tab, ...(p.restarted ? { restarted: true } : {}) }); }
          if (p.text != null) out({ type: 'progress', turnId: m.turnId, text: p.text });
        },
      });
      if (result.tab) lastTab = result.tab;
      if (result.stopped) out({ type: 'stopped', turnId: m.turnId, text: result.text });
      else out({ type: 'answer', turnId: m.turnId, text: result.text, conversation: result.conversation, tab: result.tab, model: result.model, restarted: result.restarted });
    } catch (error) {
      if (turn.stopped) out({ type: 'stopped', turnId: m.turnId, text: error.partial ?? '' });
      else out({ type: 'error', turnId: m.turnId, message: error.message, ...(error.partial ? { partial: error.partial } : {}) });
    } finally { current = null; }
  }

  let chain = Promise.resolve();
  const done = new Promise((resolve) => {
    readJsonLines(input, (m) => {
      if (m?.type === 'stop') {
        if (current) current.stopped = true;
        queue.length = 0;
        // Press stop now: the turn loop may wait a moment before it looks again.
        void browserReady().then((b) => stop(b, { site, tabId: lastTab })).catch(() => {});
        return;
      }
      if (m?.type !== 'ask') return;
      queue.push(m);
      chain = chain.then(async () => { const next = queue.shift(); if (next) await handle(next); });
    });
    input.on('end', resolve);
    input.on('close', resolve);
  });
  out({ type: 'ready' });
  await done;
  await chain;
}
