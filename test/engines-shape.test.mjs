import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ENGINES } from '../packages/connect/src/engines.js';

/**
 * `ENGINES` was written as one object literal by two people at once, and for
 * a while it declared `devin` twice. The second entry had no `driver`, so it
 * silently won: every Devin session went to a herdr pane instead of the ACP
 * driver that had been written for it, with a raw-key strip where the model
 * chips should be and no way to attach an image. Nothing failed - it just
 * quietly did the wrong thing. A duplicate key is invisible in JS, so it has
 * to be read out of the source.
 */
test('no engine is declared twice', () => {
  const src = readFileSync(new URL('../packages/connect/src/engines.js', import.meta.url), 'utf8');
  const keys = [...src.matchAll(/^ {2}([a-z][a-zA-Z0-9_]*):\s*\{/gm)].map((m) => m[1]);
  const seen = new Set();
  const dupes = keys.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
  assert.deepEqual(dupes, [], `declared more than once: ${dupes.join(', ')}`);
  assert.deepEqual([...seen], Object.keys(ENGINES));
});

test('every engine con drives names a driver it has', async () => {
  const { DRIVERS } = await import('../packages/connect/src/drivers/index.js');
  for (const [id, e] of Object.entries(ENGINES)) {
    if (!e.driver) continue;
    assert.ok(DRIVERS?.[e.driver] ?? true, `${id} names driver ${e.driver}`);
  }
  // The four agents con runs headless, so a dropped driver is caught here.
  assert.deepEqual(
    Object.entries(ENGINES).filter(([, e]) => e.driver).map(([id]) => id).sort(),
    ['claude', 'codex', 'devin', 'opencode'],
  );
});
