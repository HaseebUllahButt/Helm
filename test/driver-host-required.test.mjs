import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeCli } from './helpers.mjs';
import { DevinDriver } from '../packages/connect/src/drivers/devin.js';
import { AgyDriver } from '../packages/connect/src/drivers/agy.js';
import { PiDriver } from '../packages/connect/src/drivers/pi.js';

// A configured host is a lifecycle promise, not an optional optimization.
// Losing it must leave the prompt unsent, rather than start a process that
// the next daemon replacement would terminate.
for (const [engine, Driver] of [['devin', DevinDriver], ['agy', AgyDriver], ['pi', PiDriver]]) {
  for (const missingPipe of [false, true]) test(`${engine}: ${missingPipe ? 'missing pipe' : 'host failure'} never starts an unprotected agent`, async () => {
    const fake = fakeCli(engine, 'plain');
    let opened = 0;
    const driver = new Driver({ cmd: fake.cmd, env: {}, cwd: fake.dir, procId: 'host-required',
      procHost: {
        hasProc: () => false,
        async openProc() { opened++; if (!missingPipe) throw new Error('host unavailable'); },
        procPipe: () => null,
      },
    });
    await assert.rejects(driver.start(), missingPipe ? /could not attach/ : /host unavailable/);
    assert.equal(opened, 1);
    assert.deepEqual(fake.stdinLines(), []);
    await driver.kill();
  });
}
