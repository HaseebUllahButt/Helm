import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'helm-native-chat-'));
process.env.HELM_DIR = join(root, 'helm');
process.env.HELM_NATIVE_SOCKET = join(root, 'native.sock');
process.env.HELM_NO_SERVICE = '1';
mkdirSync(process.env.HELM_DIR);
const { Sessions } = await import('../packages/connect/src/sessions.js');
const { sendHook } = await import('../packages/connect/src/claude-hooks.js');

class Host extends EventEmitter {
  writes = [];
  renewals = [];
  nativeSessions() { return [{ id: 'native-test', engine: 'claude', nativeChat: true, cwd: root, createdAt: 1 }]; }
  has() { return true; }
  async write(id, text) { this.writes.push(text); }
  async renew(id) { this.renewals.push(id); }
  async view() { return ''; }
  unview() {}
  detach() {}
}
const create = (host = new Host()) => new Sessions(new EventEmitter(), { nativeHost: host, nativeDiscovery: false });
async function until(fn) {
  const end = Date.now() + 3000;
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('timed out');
}
test.after(() => rmSync(root, { recursive: true, force: true }));

test('two app messages keep their paste and submit paired', async () => {
  const host = new Host(), sessions = create(host);
  try {
    await sessions.hooks;
    await Promise.all([sessions.input('native-test', 'first'), sessions.input('native-test', 'second')]);
    assert.deepEqual(host.writes, ['\x1b[200~first\x1b[201~', '\r', '\x1b[200~second\x1b[201~', '\r']);
  } finally { await sessions.stop(); }
});

// Recorded screens of a real Claude's typing box (see native-mode.test.mjs).
const box = JSON.parse(readFileSync(new URL('./fixtures/claude/typing-box.json', import.meta.url), 'utf8'));

/** A terminal whose screen changes as keys arrive, the way Claude redraws. */
class Screen extends Host {
  constructor(screen, react) { super(); this.screen = screen; this.react = react; }
  async view() { return this.screen; }
  async write(id, text) { this.writes.push(text); this.screen = this.react(text, this.screen) ?? this.screen; }
}

test('a draft in the box is stashed before the message, so Claude puts it back after', async () => {
  const host = new Screen(box.draft, (key) => key === '\x13' ? box.stashed : null), sessions = create(host);
  try {
    await sessions.hooks;
    await sessions.input('native-test', 'from the app');
    assert.deepEqual(host.writes, ['\x13', '\x1b[200~from the app\x1b[201~', '\r']);
  } finally { await sessions.stop(); }
});

test('with a draft already stashed, the box is cut line by line instead of replacing it', async () => {
  let cuts = 0;
  const host = new Screen(box.draftAndStashed, (key) => key === '\x7f' && ++cuts === 2 ? box.stashed : null), sessions = create(host);
  try {
    await sessions.hooks;
    await sessions.input('native-test', 'from the app');
    assert.ok(!host.writes.includes('\x13'), 'a second Ctrl+S would throw the stashed draft away');
    assert.deepEqual(host.writes, ['\x15', '\x0b', '\x7f', '\x15', '\x0b', '\x7f', '\x1b[200~from the app\x1b[201~', '\r'],
      'each key is its own write: Claude drops a Ctrl+U that arrives in a burst');
  } finally { await sessions.stop(); }
});

test('an empty box gets no keys before the message', async () => {
  const host = new Screen(box.empty, () => null), sessions = create(host);
  try {
    await sessions.hooks;
    await sessions.input('native-test', 'from the app');
    assert.deepEqual(host.writes, ['\x1b[200~from the app\x1b[201~', '\r']);
  } finally { await sessions.stop(); }
});

test('watching native chat renews its terminal lease; a blocked chat keeps it after the viewer leaves', async () => {
  const host = new Host(), sessions = create(host);
  try {
    await sessions.hooks;
    sessions.watch('native-test', 'phone');
    assert.deepEqual(host.renewals, ['native-test']);
    sessions.unwatch('native-test', 'phone');
    sessions.get('native-test').status = 'blocked';
    await until(() => host.renewals.length > 1);
  } finally { await sessions.stop(); }
});

test('native question answers round trip, block messages, and disappear when the process exits', async () => {
  const host = new Host(), sessions = create(host);
  try {
    await sessions.hooks;
    const waiting = sendHook('native-test', { hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which color?', options: [{ label: 'Blue' }] }] } });
    await until(() => sessions.events.pending('native-test').length === 1);
    assert.equal(sessions.get('native-test').status, 'blocked');
    await assert.rejects(sessions.input('native-test', 'do not press Enter'), /question first/);
    const request = sessions.events.pending('native-test')[0];
    await sessions.answer('native-test', request.requestId, { option: 'allow', answers: { 'Which color?': 'Blue' } });
    const output = await waiting;
    assert.deepEqual(output.hookSpecificOutput.decision.updatedInput.answers, { 'Which color?': 'Blue' });
    assert.equal(sessions.events.pending('native-test').length, 0);
    const next = sendHook('native-test', { hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: { file_path: '/tmp/test' } });
    await until(() => sessions.events.pending('native-test').length === 1);
    host.emit('exit', { id: 'native-test', code: 0 });
    assert.equal(await next, null);
    assert.equal(sessions.events.pending('native-test').length, 0);
  } finally { await sessions.stop(); }
});

test('a native approval keeps its one card through Helm restarts and is answered after them', async () => {
  let sessions = create();
  await sessions.hooks;
  const waiting = sendHook('native-test', { hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: { file_path: '/tmp/x' } });
  await until(() => sessions.events.pending('native-test').length === 1);
  const { requestId } = sessions.events.pending('native-test')[0];
  try {
    for (let restart = 0; restart < 2; restart++) {
      await sessions.stop();
      sessions = create();
      assert.deepEqual(sessions.events.pending('native-test').map((p) => p.requestId), [requestId]);
      await sessions.hooks;
    }
    const end = Date.now() + 3000;
    for (;;) {
      try { await sessions.answer('native-test', requestId, { option: 'allow' }); break; }
      catch (err) { if (Date.now() > end) throw err; await new Promise((r) => setTimeout(r, 50)); }
    }
    assert.equal((await waiting).hookSpecificOutput.decision.behavior, 'allow');
    assert.equal(sessions.events.pending('native-test').length, 0);
    const cards = sessions.events.tail('native-test', 0).filter((e) => e.requestId === requestId);
    assert.deepEqual(cards.map((e) => e.type), ['permission.request', 'permission.resolved']);
  } finally { await sessions.stop(); }
});

test('a restart clears an orphaned native approval card', async () => {
  const first = create();
  await first.hooks;
  first.events.append('native-test', { type: 'permission.request', requestId: 'orphan', title: 'Old question' });
  await first.stop();
  const second = create();
  try {
    await second.hooks;
    assert.equal(second.events.pending('native-test').length, 0);
  } finally { await second.stop(); }
});


test('native images are stored on the thread host and referenced in the same serialized prompt', async () => {
  const host = new Host(), sessions = create(host);
  const data = 'iVBORw0KGgo=';
  try {
    await sessions.hooks;
    await Promise.all([
      sessions.input('native-test', 'look at [Image #1]', { attachments: [{ filename: '../../remote.png', mime: 'image/png', data }] }),
      sessions.input('native-test', '' , { attachments: [{ filename: 'second.jpg', mime: 'image/jpeg', data }] }),
    ]);
    assert.equal(host.writes.length, 4);
    for (const index of [0, 2]) {
      const path = JSON.parse(host.writes[index].match(/\[Image #1\]: ("[^\n]+")/)[1]);
      assert.ok(path.startsWith(join(process.env.HELM_DIR, 'native-images')));
      assert.deepEqual(readFileSync(path), Buffer.from(data, 'base64'));
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(host.writes[index + 1], '\r');
    }
    assert.match(host.writes[0], /look at \[Image #1\]/);
    assert.match(host.writes[2], /Read the attached image files/);
    const transcript = join(root, 'native-images.jsonl');
    const prompt = host.writes[0].slice('\x1b[200~'.length, -'\x1b[201~'.length);
    writeFileSync(transcript, JSON.stringify({type:'user',message:{role:'user',content:prompt},timestamp:new Date().toISOString()})+'\n');
    sessions.get('native-test').transcript = transcript;
    const history = await sessions.messages('native-test');
    assert.equal(history.messages[0].text, 'look at [Image #1]');
    assert.equal(history.messages[0].attachments[0].data, data);

  } finally { await sessions.stop(); }
});

test('invalid native images fail before any terminal input', async () => {
  const host = new Host(), sessions = create(host);
  try {
    await sessions.hooks;
    await assert.rejects(sessions.input('native-test', 'look', { attachments: [{ mime: 'image/png', data: 'bad!' }] }), /valid base64/);
    await assert.rejects(sessions.input('native-test', 'look', { attachments: [{ mime: 'image/svg+xml', data: 'aGk=' }] }), /JPEG, PNG/);
    assert.deepEqual(host.writes, []);
  } finally { await sessions.stop(); }
});

test('native controls and slash commands share the live terminal without claiming settings were accepted', async () => {
  const host = new Host(), sessions = create(host);
  try {
    await sessions.hooks;
    const original = { model: sessions.get('native-test').model, effort: sessions.get('native-test').effort };
    const results = await Promise.all([
      sessions.setModel('native-test', 'claude-opus-5-5[1m]'),
      sessions.setEffort('native-test', 'high'),
      sessions.input('native-test', '/permissions'),
    ]);
    assert.ok(results.every(result => result.terminal === true));
    assert.deepEqual(host.writes, [
      '\x1b[200~/model claude-opus-5-5[1m]\x1b[201~', '\r',
      '\x1b[200~/effort high\x1b[201~', '\r',
      '\x1b[200~/permissions\x1b[201~', '\r',
    ]);
    assert.deepEqual({ model: sessions.get('native-test').model, effort: sessions.get('native-test').effort }, original);
    assert.ok((await sessions.commands('native-test')).some(command => command.name === 'model'));
    assert.equal(sessions.get('native-test').driver, undefined);
  } finally { await sessions.stop(); }
});

test('invalid native controls and slash commands with images never write to the terminal', async () => {
  const host = new Host(), sessions = create(host);
  try {
    await sessions.hooks;
    for (const model of ['opus\n/clear', 'opus\x1b[201~', {}, ' opus']) {
      await assert.rejects(sessions.setModel('native-test', model), /invalid Claude model/);
    }
    await assert.rejects(sessions.setEffort('native-test', 'high\n/clear'), /invalid Claude thinking effort/);
    await assert.rejects(sessions.input('native-test', '/model', { attachments: [{ mime: 'image/png', data: 'iVBORw0KGgo=' }] }), /without images/);
    assert.deepEqual(host.writes, []);
  } finally { await sessions.stop(); }
});

test('a pending native approval blocks settings as well as ordinary messages', async () => {
  const host = new Host(), sessions = create(host);
  try {
    await sessions.hooks;
    const waiting = sendHook('native-test', { hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: {} });
    await until(() => sessions.events.pending('native-test').length === 1);
    await assert.rejects(sessions.setModel('native-test', 'opus'), /question first/);
    await assert.rejects(sessions.setEffort('native-test', 'low'), /question first/);
    assert.deepEqual(host.writes, []);
    host.emit('exit', { id: 'native-test', code: 0 });
    await waiting;
  } finally { await sessions.stop(); }
});

test('native commands fail when the original process is gone', async () => {
  const host = new Host(); host.has = () => false;
  const sessions = create(host);
  try {
    await sessions.hooks;
    await assert.rejects(sessions.setModel('native-test', 'opus'), /no longer running/);
    assert.deepEqual(host.writes, []);
  } finally { await sessions.stop(); }
});

test('Claude model hooks update the reported setting only after the provider switches', async () => {
  const sessions = create();
  try {
    await sessions.hooks;
    await sendHook('native-test', { hook_event_name: 'SessionStart', model: 'claude-opus-5-5' });
    assert.equal(sessions.get('native-test').engineModel, 'claude-opus-5-5');
    await sessions.setModel('native-test', 'sonnet');
    assert.equal(sessions.get('native-test').engineModel, 'claude-opus-5-5');
    await sendHook('native-test', { hook_event_name: 'PostModelSwitch', to_model: 'claude-sonnet-5', source: 'command' });
    assert.equal(sessions.get('native-test').engineModel, 'claude-sonnet-5');
    assert.equal(sessions.get('native-test').model, null);
    assert.equal(sessions.get('native-test').status, 'idle');
  } finally { await sessions.stop(); }
});

test('a model picked in the app is checked with Claude first; a warm cache asks with its figures', async () => {
  // Claude runs PreModelSwitch when `/model` is entered (fields from a real 2.1.302 run).
  const host = new Host(), outputs = [];
  let hook = {};
  host.write = async (id, text) => {
    host.writes.push(text);
    if (text === '\r') outputs.push(await sendHook('native-test', { hook_event_name: 'PreModelSwitch', from_model: 'claude-opus-5-5',
      to_model: 'claude-sonnet-5-5', source: 'command', context_tokens: 300008, prompt_cache_warm: true,
      cache_ttl: '1h', estimated_cache_write_usd: 0.75, pricing: 'catalog', ...hook }));
  };
  const sessions = create(host);
  try {
    await sessions.hooks;
    const warm = await sessions.setModel('native-test', 'sonnet', { pick: true, ask: true });
    assert.deepEqual(warm.ask, { tokens: 300008, costUsd: 0.75, ttl: '1h' });
    assert.equal(outputs.at(-1).hookSpecificOutput.permissionDecision, 'deny');
    // Confirmed: Claude's own question, hidden behind the chat, is skipped.
    const confirmed = await sessions.setModel('native-test', 'sonnet', { pick: true });
    assert.equal(confirmed.ask, undefined);
    assert.equal(outputs.at(-1).hookSpecificOutput.permissionDecision, 'allow');
    hook = { prompt_cache_warm: false, estimated_cache_write_usd: 0 };
    const cold = await sessions.setModel('native-test', 'sonnet', { pick: true, ask: true });
    assert.equal(cold.ask, undefined);
    assert.equal(outputs.at(-1).hookSpecificOutput.permissionDecision, 'allow');
    // Typed at the keyboard, not picked in the app: Claude decides there itself.
    hook = {};
    await sessions.setModel('native-test', 'sonnet');
    assert.equal(outputs.at(-1), null);
  } finally { await sessions.stop(); }
});

test("a terminal Claude's own busy/idle word fixes what hooks miss, never a newer hook", async (t) => {
  // Stop does not run when a turn is interrupted, and nothing marks a turn
  // Claude starts by itself. Claude's session file says both.
  const { spawn } = await import('node:child_process');
  const home = join(root, 'claude-home');
  mkdirSync(join(home, 'sessions'), { recursive: true });
  const fake = spawn('bash', ['-c', 'exec -a claude sleep 30'], { cwd: root, stdio: 'ignore' });
  t.after(() => fake.kill());
  await until(() => { try { return readFileSync(`/proc/${fake.pid}/cmdline`, 'utf8').startsWith('claude\0'); } catch { return false; } });
  const say = (status, statusUpdatedAt) => writeFileSync(join(home, 'sessions', `${fake.pid}.json`), JSON.stringify({
    pid: fake.pid, sessionId: 'conv-live', cwd: root, kind: 'interactive', status, statusUpdatedAt }));
  const host = new Host(), sessions = create(host);
  try {
    await sessions.hooks;
    Object.assign(sessions.get('native-test'), { nativeHome: home, nativePid: process.pid, engineSessionId: 'conv-live' });
    // An older file never undoes a fresh hook.
    say('idle', Date.now() - 60_000);
    await sendHook('native-test', { hook_event_name: 'UserPromptSubmit' });
    assert.equal(sessions.get('native-test').status, 'working');
    await new Promise((r) => setTimeout(r, 2700));
    assert.equal(sessions.get('native-test').status, 'working');
    // Interrupted at the keyboard: no Stop hook, but Claude writes idle.
    say('idle', Date.now() + 1);
    await until(() => sessions.get('native-test').status === 'idle');
    // A turn Claude starts by itself.
    say('busy', Date.now() + 1);
    await until(() => sessions.get('native-test').status === 'working');
  } finally { await sessions.stop(); }
});

test('a terminal Claude stays blank until the first message', async () => {
  class FreshHost extends Host { nativeSessions() { return [{ id: 'native-blank', engine: 'claude', nativeChat: true, cwd: root, createdAt: 1 }]; } }
  const sessions = create(new FreshHost());
  try {
    await sessions.hooks;
    assert.equal(sessions.get('native-blank').blank, true);
    await sendHook('native-blank', { hook_event_name: 'SessionStart', session_id: 'conv-blank', transcript_path: join(root, 'conv-blank.jsonl') });
    assert.equal(sessions.get('native-blank').blank, true);
    await sendHook('native-blank', { hook_event_name: 'UserPromptSubmit' });
    assert.equal(sessions.get('native-blank').blank, false);
    await sendHook('native-blank', { hook_event_name: 'Stop' });
    assert.equal(sessions.get('native-blank').blank, false);
  } finally { await sessions.stop(); }
});

/** Claude's own shift+tab ring, drawing its footer the way 2.1.295 does. */
class CycleHost extends Host {
  ring = ['auto mode', 'manual mode', 'accept edits', 'plan mode'];
  at = 0;
  views = 0;
  async view() { this.views++; return ''; }
  unview() { this.views--; }
  async write(id, text) {
    this.writes.push(text);
    if (text !== '\x1b[Z') return;
    this.at = (this.at + 1) % this.ring.length;
    setTimeout(() => this.emit('data', { id, text: `\x1b[38;2;1;2;3m\x1b[2K ⏵⏵ ${this.ring[this.at]} on\x1b[39m (shift+tab to cycle)` }), 20);
  }
}

test('a terminal Claude reports its permission mode, and the chip changes it the way the keyboard does', async () => {
  const host = new CycleHost(), sessions = create(host);
  try {
    await sessions.hooks;
    await sendHook('native-test', { hook_event_name: 'SessionStart', permission_mode: 'auto', session_id: 'conv-mode' });
    assert.equal(sessions.get('native-test').mode, 'auto');
    const result = await sessions.setMode('native-test', 'acceptEdits');
    assert.equal(result.session.mode, 'acceptEdits');
    assert.equal(sessions.get('native-test').mode, 'acceptEdits');
    assert.deepEqual(host.writes, ['\x1b[Z', '\x1b[Z'], 'two presses: auto → manual → accept edits');
    assert.equal(host.ring[host.at], 'accept edits');
    assert.equal(host.views, 0, 'it stops watching the screen afterwards');
    // Back to the default: "manual mode" is what this build calls it.
    host.writes = [];
    await sessions.setMode('native-test', 'default');
    assert.equal(sessions.get('native-test').mode, 'default');
    assert.equal(host.ring[host.at], 'manual mode');
  } finally { await sessions.stop(); }
});

test('a permission mode the terminal Claude does not offer fails and leaves the mode where it was', async () => {
  const host = new CycleHost(), sessions = create(host);
  try {
    await sessions.hooks;
    await sendHook('native-test', { hook_event_name: 'UserPromptSubmit', permission_mode: 'auto' });
    await assert.rejects(sessions.setMode('native-test', 'bypassPermissions'), /allow-dangerously-skip-permissions/);
    assert.equal(host.ring[host.at], 'auto mode', 'back where it started');
    assert.equal(sessions.get('native-test').mode, 'auto');
    // A question on screen: shift+tab there would pick an answer.
    const waiting = sendHook('native-test', { hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: { file_path: '/tmp/x' } });
    await until(() => sessions.events.pending('native-test').length === 1);
    host.writes = [];
    await assert.rejects(sessions.setMode('native-test', 'acceptEdits'), /question first/);
    assert.deepEqual(host.writes, []);
    host.emit('exit', { id: 'native-test', code: 0 });
    await waiting;
  } finally { await sessions.stop(); }
});


test('concurrent native permission changes apply in order against the current mode', async () => {
  const host = new CycleHost(), sessions = create(host);
  try {
    await sessions.hooks;
    await sendHook('native-test', {hook_event_name:'UserPromptSubmit',permission_mode:'auto'});
    await Promise.all([sessions.setMode('native-test','acceptEdits'), sessions.setMode('native-test','auto')]);
    assert.equal(sessions.get('native-test').mode,'auto');
    assert.equal(host.ring[host.at],'auto mode');
    assert.equal(host.views,0);
  } finally { await sessions.stop(); }
});

test('native permission changes with no reported mode reject before sending keys', async () => {
  const host = new CycleHost(), sessions = create(host);
  try {
    await sessions.hooks;
    delete sessions.get('native-test').mode;
    await assert.rejects(sessions.setMode('native-test','acceptEdits'), /not reported/);
    assert.deepEqual(host.writes,[]);
    assert.equal(host.views,0);
  } finally { await sessions.stop(); }
});


test('native mode changes preserve an existing terminal viewer', async () => {
  const host = new CycleHost(), sessions = create(host);
  try {
    await sessions.hooks;
    await sendHook('native-test', {hook_event_name:'UserPromptSubmit',permission_mode:'auto'});
    sessions.watch('native-test','terminal-view');
    await sessions.setMode('native-test','acceptEdits');
    assert.equal(host.views,1,'the shared viewer stays attached');
    sessions.detach('native-test','terminal-view');
    assert.equal(host.views,0);
  } finally { await sessions.stop(); }
});

test('native status-line quotas arrive as limits without changing permission mode or status', async () => {
  const sessions=create();
  const before={mode:sessions.get('native-test').mode,status:sessions.get('native-test').status};
  try {
    await sessions.hooks;
    await sendHook('native-test',{hook_event_name:'HelmUsage',rate_limits:{five_hour:{used_percentage:18,resets_at:2000000000},seven_day:{used_percentage:0,resets_at:2000000001}}});
    const event=sessions.events.tail('native-test',0).find(e=>e.type==='limits');
    assert.deepEqual(event.claude.unifiedWindows,{five_hour:{utilization:0.18,resetsAt:2000000000},seven_day:{utilization:0,resetsAt:2000000001}});
    assert.deepEqual({mode:sessions.get('native-test').mode,status:sessions.get('native-test').status},before);
  } finally { await sessions.stop(); }
});


test('native status-line context fullness lands on the chat record', async () => {
  const sessions=create();
  try {
    await sessions.hooks;
    await sendHook('native-test',{hook_event_name:'HelmContext',used:150500,window:383000});
    const {used,window}=sessions.get('native-test').context;
    assert.deepEqual({used,window},{used:150500,window:383000});
    assert.equal(sessions.events.tail('native-test',0).some(e=>e.type==='context'),false,'never a line in the transcript');
  } finally { await sessions.stop(); }
});

test('Claude takeover can select and leave dangerously-skip-permissions after the native footer confirms it',async()=>{
  const host=new CycleHost();host.ring=['auto mode','bypass permissions','manual mode','accept edits','plan mode'];
  const sessions=create(host);
  try{
    await sessions.hooks;
    await sendHook('native-test',{hook_event_name:'SessionStart',permission_mode:'auto'});
    assert.equal((await sessions.setMode('native-test','bypassPermissions')).session.mode,'bypassPermissions');
    assert.equal(host.ring[host.at],'bypass permissions');
    assert.equal((await sessions.setMode('native-test','default')).session.mode,'default');
  } finally{await sessions.stop();}
});

test('a native chat read that the app already holds answers unchanged, without the messages', async () => {
  const host = new Host(), sessions = create(host);
  try {
    await sessions.hooks;
    const transcript = join(root, 'native-unchanged.jsonl');
    const line = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: new Date().toISOString() }) + '\n';
    writeFileSync(transcript, line('first question'));
    sessions.get('native-test').transcript = transcript;
    const full = await sessions.messages('native-test');
    assert.equal(full.messages[0].text, 'first question');
    assert.match(full.version, /^[\w-]{22}$/);
    const same = await sessions.messages('native-test', { known: full.version });
    assert.equal(same.unchanged, true);
    assert.equal(same.messages, undefined);
    assert.equal(same.version, full.version);
    // A new message changes the version, and the list comes back whole.
    writeFileSync(transcript, line('first question') + line('second question'));
    const grown = await sessions.messages('native-test', { known: full.version });
    assert.equal(grown.unchanged, undefined);
    assert.deepEqual(grown.messages.map(m => m.text), ['first question', 'second question']);
    assert.notEqual(grown.version, full.version);
  } finally { await sessions.stop(); }
});
