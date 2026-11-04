import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeDriver } from '../packages/connect/src/drivers/claude.js';
import { CodexDriver } from '../packages/connect/src/drivers/codex.js';
import { AcpDriver } from '../packages/connect/src/drivers/acp.js';
import { PiDriver } from '../packages/connect/src/drivers/pi.js';

for (const Driver of [ClaudeDriver, CodexDriver, AcpDriver, PiDriver]) {
  test(`${Driver.name} refuses a closed approval before contacting the agent`, async () => {
    const driver = new Driver({ cmd: '/does-not-run', cwd: '/tmp', env: {} });
    await assert.rejects(driver.answer('closed-request', {option:'allow'}), error => {
      assert.equal(error.message, 'This request is no longer open.');
      assert.equal(error.deliveryNotSent, true);
      return true;
    });
  });
}
