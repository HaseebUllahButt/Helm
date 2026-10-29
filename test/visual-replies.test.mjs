import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-visual-test-'));
process.env.HELM_NO_SERVICE = '1';
for (const [key, name] of Object.entries({ HELM_DB: 'test.db', HELM_SSH_DIR: 'ssh', HELM_TERMINALS_SOCKET: 'term.sock', HELM_PROCS_SOCKET: 'proc.sock', HELM_NATIVE_SOCKET: 'native.sock' })) process.env[key] = join(process.env.HELM_DIR, name);
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
const { prepareVisual, preparePdf, validateVisual, MAX_VISUAL_BYTES, MAX_PDF_BYTES, withVisualMessages } = await import('../packages/connect/src/visual.js');
const { runVisualCommand } = await import('../packages/connect/src/visual-cli.js');
const { Sessions } = await import('../packages/connect/src/sessions.js');
const { EventLog, activeTurnFromEvents } = await import('../packages/connect/src/events.js');
const { apply, emptyLog } = await import('../apps/web/src/session/types.ts');
const { helmBrief } = await import('../packages/connect/src/delegation.js');

const file = name => join(process.env.HELM_DIR, name);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=', 'base64');
const params = (n, extra = {}) => ({ renderId: String(n).padStart(24, '0'), html: '<h1>Diagram</h1><button>Adjust</button>', title: 'Saved diagram', height: 420, ...extra });

test('a screenshot renders on its own at chat width; text named .png is still refused', async () => {
  writeFileSync(file('shot.png'), png);
  const html = await prepareVisual(file('shot.png'));
  assert.match(html, /<img src="data:image\/png;base64,[^"]+" alt="" style="display:block;max-width:100%;height:auto">/);
  writeFileSync(file('fake.png'), 'PRIVATE_TOKEN=do-not-embed');
  await assert.rejects(prepareVisual(file('fake.png')), /local visual assets must be/);
});

test('local images become portable snapshots; text disguised as an image is refused', async () => {
  writeFileSync(file('pixel.png'), png);
  writeFileSync(file('page.html'), '<img src="pixel.png"><style>.x{background:url(pixel.png)}</style><img srcset="pixel.png 1x, pixel.png 2x"><svg><image href="pixel.png"/></svg>');
  const html = await prepareVisual(file('page.html'));
  assert.equal((html.match(/data:image\/png;base64,/g) ?? []).length, 5);
  assert.ok(!html.includes('pixel.png'));
  rmSync(file('pixel.png'));
  assert.ok(html.includes(png.toString('base64')), 'the source image is no longer needed');
  writeFileSync(file('secret.png'), 'PRIVATE_TOKEN=do-not-embed');
  writeFileSync(file('bad.html'), '<img src="secret.png">');
  await assert.rejects(prepareVisual(file('bad.html')), /local visual assets must be/);
  writeFileSync(file('repeated.png'), Buffer.concat([png, Buffer.alloc(1024 * 1024)]));
  writeFileSync(file('repeated.html'), '<img srcset="repeated.png 1x, repeated.png 2x, repeated.png 3x, repeated.png 4x">');
  await assert.rejects(prepareVisual(file('repeated.html')), /4 MiB/, 'the budget counts repeated embedded bytes too');
  writeFileSync(file('big.html'), 'x'.repeat(512 * 1024 + 1));
  await assert.rejects(prepareVisual(file('big.html')), /512 KiB/);
  assert.throws(() => validateVisual(params(1, { html: 'x'.repeat(MAX_VISUAL_BYTES + 1) })), /4 MiB/);
});

test('a visual persists across daemon restarts without owning provider work; retries deduplicate', async t => {
  writeFileSync(file('sessions.json'), JSON.stringify({ version: 1, sessions: [
    { id: 'managed1', engine: 'codex', driver: 'codex', status: 'idle', cwd: '/tmp', title: 'Managed' },
    { id: 'native1', engine: 'claude', nativeCli: true, status: 'idle', cwd: '/tmp', title: 'Native' },
  ] }));
  const make = () => new Sessions(new EventEmitter(), { makeDriver: () => { throw new Error('must not start a provider'); } });
  let sessions = make();
  t.after(() => sessions.stop());
  const updates = [];
  sessions.on('event', value => updates.push(value));
  const result = sessions.renderVisual('managed1', params(2));
  const count = updates.length;
  assert.deepEqual(sessions.renderVisual('managed1', params(2)), result);
  assert.equal(updates.length, count);
  assert.throws(() => sessions.renderVisual('managed1', params(2, { title: 'Changed' })), /different visual/);
  assert.equal(sessions.get('managed1').status, 'idle');
  assert.equal(sessions.events.activeTurn('managed1'), null);
  const events = sessions.history('managed1', { tail: 50 }).events;
  assert.ok(JSON.stringify(events).length < 2000, 'the HTML is kept out of history frames');
  const state = emptyLog();
  for (const event of events) apply(state, event);
  assert.equal(state.turns[0].items[0].visual.title, 'Saved diagram');
  assert.equal(state.turns[0].items[0].status, 'ok');
  assert.equal(state.turns[0].local, true);
  assert.equal(state.turns[0].done.status, 'ok');
  const canvas = sessions.renderVisual('native1', params(3, { placement: 'canvas' }));
  assert.equal(canvas.visual.placement, 'canvas');
  assert.equal(sessions.get('native1').canvas.requestId, params(3).renderId);
  assert.deepEqual(sessions.renderVisual('native1', params(3, { placement: 'canvas' })), canvas);
  assert.throws(() => sessions.renderVisual('native1', params(3)), /different visual/);
  assert.throws(() => sessions.renderVisual('native1', params(6, { placement: 'bad' })), /invalid visual placement/);
  const native = await sessions.messages('native1');
  assert.equal(native.messages[0].visual.title, 'Saved diagram');
  assert.equal(native.messages[0].visual.placement, 'canvas');
  assert.equal(sessions.get('native1').status, 'idle');
  assert.throws(() => sessions.readVisual('native1', result.visual.ref + '/../bad'), /no such visual/);
  const live = sessions.renderVisual('native1', params(7, { placement: 'canvas', url: 'https://demo.example/?x=1&y=2' }));
  assert.equal(live.visual.url, 'https://demo.example/?x=1&y=2');
  assert.match(sessions.readVisual('native1', live.visual.ref).html, /x=1&amp;y=2/);
  assert.throws(() => sessions.renderVisual('native1', params(7, { placement: 'canvas', url: 'https://other.example/' })), /different visual/);
  const privateVisual = sessions.renderVisual('managed1', params(5, { html: '<h1>Only this chat</h1>' }));
  assert.throws(() => sessions.readVisual('native1', privateVisual.visual.ref), /no such visual/);
  sessions.stop();
  sessions = make();
  assert.equal(sessions.get('native1').canvas.visual.url, 'https://demo.example/?x=1&y=2');
  assert.equal(sessions.history('native1', { tail: 50 }).events.find(e => e.visual).visual.placement, 'canvas');
  assert.match(sessions.readVisual('managed1', result.visual.ref).html, /<h1>Diagram/);
  sessions.events.append('managed1', { type: 'turn.start', turnId: 'provider-turn', text: 'Working' });
  sessions.get('managed1').status = 'working';
  sessions.renderVisual('managed1', params(4));
  assert.equal(sessions.events.activeTurn('managed1').turnId, 'provider-turn');
  assert.equal(sessions.get('managed1').status, 'working');
  assert.equal(sessions.events.tail('managed1', 0).find(e => e.id === 'visual-' + params(4).renderId).turnId, 'provider-turn');
  sessions.events.remove('managed1');
  assert.equal(existsSync(file(`events/managed1.att/${result.visual.ref}.bin`)), false);
});

test('visual references survive attachment sweeps and cold history anchors', () => {
  const log = new EventLog(file('retention'));
  const visual = { ...log.putAttachment('s', { filename: 'v.html', mime: 'text/html', data: Buffer.from('<html>saved</html>').toString('base64') }), title: 'V', height: 200 };
  const orphan = log.putAttachment('s', { filename: 'old.png', mime: 'image/png', data: png.toString('base64') });
  log.append('s', { type: 'turn.start', turnId: 't', text: '' });
  log.append('s', { type: 'turn.images', turnId: 't', attachments: [orphan] });
  log.append('s', { type: 'item.start', turnId: 't', id: 'v', kind: 'visual', visual });
  for (let i = 0; i < 2100; i++) log.append('s', { type: 'item.update', turnId: 't', id: 'v', output: 'a'.repeat(500) });
  for (const reader of [log, new EventLog(file('retention'))]) {
    const events = reader.window('s', { tail: 10 }).events;
    assert.equal(events.find(e => e.id === 'v' && e.type === 'item.start').visual.ref, visual.ref);
    assert.ok(reader.attachment('s', visual.ref));
    assert.equal(activeTurnFromEvents(events).turnId, 't');
  }
});

test('CLI resolves explicit remote sessions and native session environments without changing network state', async () => {
  writeFileSync(file('cli.html'), '<h1>CLI visual</h1>');
  let call;
  const options = { print: () => {}, self: () => 'local', rpc: async (...args) => { call = args; return { visual: { ref: 'ok' } }; }, findSession: async id => ({ env: 'remote', session: { id: id + '-full' } }), env: { HELM_NATIVE_SESSION: 'native1' } };
  await runVisualCommand('render', [file('cli.html')], options);
  assert.equal(call[0], 'local'); assert.equal(call[2].id, 'native1');
  await runVisualCommand('render', [file('cli.html'), '--session', 'short', '--title', 'Title', '--render-id', params(1).renderId], options);
  assert.equal(call[0], 'remote'); assert.equal(call[2].id, 'short-full'); assert.equal(call[2].title, 'Title');
  await assert.rejects(runVisualCommand('render', [file('cli.html')], { ...options, env: {} }), /inside an agent chat/);
  await assert.rejects(runVisualCommand('render', [file('cli.html'), '--bogus', 'value'], options), /invalid visual option/);
  await runVisualCommand('canvas', [file('cli.html'), '--session', 'short', '--title', 'Side canvas'], options);
  assert.equal(call[0], 'remote');
  assert.equal(call[2].id, 'short-full');
  assert.equal(call[2].placement, 'canvas');
  assert.equal(call[2].title, 'Side canvas');
  await runVisualCommand('canvas', ['https://demo.example/', '--session', 'short'], options);
  assert.equal(call[2].url, 'https://demo.example/');
  assert.equal(call[2].placement, 'canvas');
  await runVisualCommand('canvas', ['notes.md', '--session', 'short'], options);
  assert.equal(call[1], 'session.canvas');
  assert.equal(call[2].path, 'notes.md');
  assert.equal(call[2].id, 'short-full');
  assert.match(helmBrief({}), /helm canvas/);
  assert.match(helmBrief({}), /helm preview/);
});

test('native visuals sit between the messages surrounding publication, not at the end of every refresh', () => {
  const messages = [{ role: 'user', at: '2026-10-12T12:00:00Z' }, { role: 'assistant', at: '2026-10-12T12:00:02Z' }];
  const events = [{ type: 'item.start', kind: 'visual', at: Date.parse('2026-10-12T12:00:01Z'), visual: { title: 'V' }, id: 'v' }];
  assert.deepEqual(withVisualMessages(messages, events).map(m => m.visual?.title ?? m.role), ['user', 'V', 'assistant']);
  assert.equal(messages.length, 2);
});

test('a PDF opens in canvas as its own bytes, read-only; other files named .pdf are refused', async t => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  writeFileSync(file('doc.pdf'), pdf);
  writeFileSync(file('fake.pdf'), 'PRIVATE_TOKEN=do-not-send');
  writeFileSync(file('huge.pdf'), Buffer.concat([pdf, Buffer.alloc(MAX_PDF_BYTES)]));
  let call;
  const options = { print: () => {}, self: () => 'local', rpc: async (...args) => { call = args; return { visual: { ref: 'ok' } }; }, findSession: async () => ({}), env: { HELM_SESSION_ID: 'native1' } };
  await runVisualCommand('canvas', [file('doc.pdf'), '--title', 'Before and Now'], options);
  assert.equal(call[1], 'session.render', 'a PDF is a saved copy, not a project file');
  assert.equal(call[2].pdf, pdf.toString('base64'));
  assert.equal(call[2].html, undefined);
  assert.equal(call[2].placement, 'canvas');
  await assert.rejects(runVisualCommand('canvas', [file('fake.pdf')], options), /not a PDF/);
  await assert.rejects(preparePdf(file('huge.pdf')), /16 MiB/);
  const pdfParams = { renderId: params(9).renderId, pdf: pdf.toString('base64'), title: 'Before and Now', placement: 'canvas' };
  assert.throws(() => validateVisual({ ...pdfParams, pdf: Buffer.from('<h1>no</h1>').toString('base64') }), /PDF file/);
  assert.throws(() => validateVisual({ ...pdfParams, html: '<h1>both</h1>' }), /PDF file/);

  writeFileSync(file('sessions.json'), JSON.stringify({ version: 1, sessions: [{ id: 'pdf1', engine: 'claude', nativeCli: true, status: 'idle', cwd: '/tmp', title: 'PDF' }] }));
  const sessions = new Sessions(new EventEmitter(), { makeDriver: () => { throw new Error('must not start a provider'); } });
  t.after(() => sessions.stop());
  const { visual } = sessions.renderVisual('pdf1', pdfParams);
  assert.equal(visual.kind, 'pdf');
  assert.equal(visual.bytes, pdf.length);
  assert.equal(sessions.get('pdf1').canvas.visual.ref, visual.ref);
  assert.deepEqual(sessions.readVisual('pdf1', visual.ref), { pdf: pdf.toString('base64') });
  assert.deepEqual(sessions.renderVisual('pdf1', pdfParams), { visual }, 'a retry keeps one copy');
  assert.throws(() => sessions.renderVisual('pdf1', { ...params(9), placement: 'canvas' }), /different visual/);
});

test('live canvas accepts only web URLs without credentials and keeps saved HTML separate', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'file:///etc/passwd', 'https://user:secret@example.com/', 'not a URL']) {
    assert.throws(() => validateVisual(params(8, { placement: 'canvas', url })), /canvas URL/);
  }
  assert.throws(() => validateVisual(params(8, { url: 'https://example.com/' })), /must open in canvas/);
  const live = validateVisual(params(8, { placement: 'canvas', url: 'https://example.com/?q=<script>' }));
  assert.equal(live.url, 'https://example.com/?q=%3Cscript%3E');
  assert.ok(!live.html.includes('<script>'));
});

test('agents open project files beside chat with guarded paths, saved selection and unchanged work', async t => {
  const repo = file('canvas-repo');
  mkdirSync(join(repo, 'docs'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'docs', 'notes.md'), '# Project notes');
  writeFileSync(join(repo, '.env'), 'SECRET=private');
  writeFileSync(file('sessions.json'), JSON.stringify({ version: 1, sessions: [
    { id: 'file1', engine: 'codex', driver: 'codex', status: 'working', cwd: join(repo, 'docs') },
    { id: 'quick1', engine: 'codex', driver: 'codex', status: 'idle', cwd: repo, quick: true },
  ] }));
  const make = () => new Sessions(new EventEmitter(), { makeDriver: () => { throw new Error('must not start a provider'); } });
  let sessions = make();
  t.after(() => sessions.stop());
  const pushed = [];
  sessions.on('session', s => pushed.push(s.canvas));
  const request = { path: 'notes.md', requestId: params(9).renderId };
  const result = await sessions.openCanvas('file1', request);
  assert.equal(result.canvas.path, 'docs/notes.md');
  assert.equal(pushed.length, 1);
  assert.equal(sessions.get('file1').status, 'working');
  assert.deepEqual(await sessions.openCanvas('file1', request), result);
  assert.equal(pushed.length, 1, 'retry does not reopen a closed panel');
  await assert.rejects(sessions.openCanvas('file1', { ...request, path: '../../outside.md' }), /inside the folder/);
  await assert.rejects(sessions.openCanvas('file1', { ...request, path: '../.env' }), /passwords or keys/);
  await assert.rejects(sessions.openCanvas('quick1', request), /no project folder/);
  sessions.stop(); sessions = make();
  assert.deepEqual(sessions.get('file1').canvas, result.canvas);
  const changed = await sessions.openCanvas('file1', { path: join(repo, 'docs', 'notes.md'), requestId: params(10).renderId });
  assert.equal(changed.canvas.path, 'docs/notes.md');
  assert.notEqual(changed.canvas.requestId, result.canvas.requestId);
  // Closing on one device is kept on the chat, so no other device reopens it.
  assert.equal(sessions.closeCanvas('file1', result.canvas.requestId).canvas.closed, undefined, 'an older ask changes nothing');
  assert.equal(sessions.closeCanvas('file1', changed.canvas.requestId).canvas.closed, true);
  sessions.stop(); sessions = make();
  assert.equal(sessions.get('file1').canvas.closed, true);
  const again = await sessions.openCanvas('file1', { path: 'notes.md', requestId: params(11).renderId });
  assert.equal(again.canvas.closed, undefined, 'a new ask opens again');
});
