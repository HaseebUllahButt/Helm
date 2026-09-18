import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const fixture = (engine, name) => join(HERE, 'fixtures', engine, `${name}.ndjson`);

/**
 * A fake `claude` or `codex` binary that replays one recorded stream.
 * Returns the command to spawn and where its stdin is logged.
 */
export function fakeCli(engine, name) {
  const dir = mkdtempSync(join(tmpdir(), `con-fake-${engine}-`));
  const cmd = join(dir, engine);
  const stdin = join(dir, 'stdin.ndjson');
  writeFileSync(cmd, `#!/bin/sh\nFAKE_FIXTURE=${JSON.stringify(fixture(engine, name))} FAKE_STDIN=${JSON.stringify(stdin)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(HERE, 'fake-cli.mjs'))} ${engine} "$@"\n`);
  chmodSync(cmd, 0o755);
  return {
    cmd, dir,
    stdinLines: () => (existsSync(stdin) ? readFileSync(stdin, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}

/** Collect a driver's events; `until(pred)` resolves when one matches. */
export function collect(driver) {
  const events = [];
  const waiters = [];
  driver.on('event', (e) => {
    events.push(e);
    for (const w of [...waiters]) if (w.pred(e)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e); }
  });
  return {
    events,
    until: (pred, ms = 10_000) => {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for event; saw ${events.map((e) => e.type).join(',')}`)), ms);
        waiters.push({ pred, resolve: (e) => { clearTimeout(t); resolve(e); } });
      });
    },
    types: () => events.map((e) => e.type),
    of: (type) => events.filter((e) => e.type === type),
  };
}
