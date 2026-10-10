import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ModeFooter } from '../packages/connect/src/native-mode.js';

// Recorded from a real Claude Code 2.1.295 in a pty: its start screen, then
// what it drew after each shift+tab.
const frames = JSON.parse(readFileSync(new URL('./fixtures/claude/shift-tab-footer.json', import.meta.url), 'utf8'));

test("Claude's own footer bytes read as the mode it moved to after each press", () => {
  const footer = new ModeFooter();
  footer.feed(frames.start);
  assert.equal(footer.label(), 'auto mode', 'the start screen names the mode it opened in');
  const seen = frames.presses.map((bytes) => { footer.mark(); footer.feed(bytes); return footer.label(); });
  assert.deepEqual(seen, ['default', 'accept edits', 'plan mode', 'auto mode', 'default']);
});

test('a redraw that skips unchanged characters still reads whole', () => {
  // Claude jumps over a run that matches what is already there: "bypass
  // permissions" drawn over "auto mode" can skip the "e" both have at
  // the same column. The bytes alone read "bypass p" … "rmissions".
  const footer = new ModeFooter();
  footer.feed('\x1b[H\r\x1b[2C\x1b[35B⏵⏵ auto mode on (shift+tab to cycle)');
  footer.mark();
  footer.feed('\x1b[H\r\x1b[2C\x1b[35B⏵⏵ bypass p\x1b[15Grmissions on\x1b[K');
  assert.equal(footer.label(), 'bypass permissions');
  // Split anywhere, even inside an escape, it reads the same.
  const split = new ModeFooter();
  const bytes = frames.start + frames.presses[0];
  for (let i = 0; i < bytes.length; i += 7) split.feed(bytes.slice(i, i + 7));
  assert.equal(split.label(), 'default');
});

test('only rows drawn since the mark count', () => {
  const footer = new ModeFooter();
  footer.feed('\x1b[1;1Hplan mode on\r\n\x1b[5;1Hsomething else');
  footer.mark();
  footer.feed('\x1b[5;1Hstill something');
  assert.equal(footer.label(), null, 'an old line elsewhere is not the answer');
});
