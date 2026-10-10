import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'helm-native-controls-'));
process.env.HELM_DIR = root;
process.env.HELM_SSH_DIR = join(root, 'ssh');
process.env.HELM_NO_SERVICE = '1';
const { Daemon } = await import('../packages/connect/src/agent.js');
const { primeModels } = await import('../packages/connect/src/models.js');
const { createNetwork } = await import('@helm/protocol/network');
const { M } = await import('@helm/protocol');
const { CLAUDE_NATIVE_COMMANDS } = await import('../packages/connect/src/commands.js');
test.after(() => rmSync(root, {recursive:true, force:true}));
createNetwork({name:'Test'});
writeFileSync(join(root, 'profiles.json'), JSON.stringify({profiles:[{
  id:'unrelated', engine:'claude', env:{CLAUDE_CONFIG_DIR:join(root,'other-account')},
}]}));

test('native model catalog uses the actual account home even without a profile and never claims account defaults are live settings', async () => {
  // The permission picker is offered (a taken-over chat has the whole tray),
  // but no default mode stands in for what Claude reports.
  const home = join(root, 'native-account');
  primeModels('claude', home, null, {default:'native-default', models:['native-model'], effort:'high', efforts:['low','high']});
  primeModels('claude', join(root,'other-account'), null, {default:'wrong-account', models:['wrong-model']});
  const daemon = new Daemon();
  daemon.sessions = { get: () => ({id:'native-test', engine:'claude', nativeChat:true, nativeHome:home}) };
  for (const profileId of [null, 'unrelated']) {
    const result = await daemon.dispatch(M.MODEL_LIST, {id:'native-test', profileId});
    assert.deepEqual(result.models, ['native-model']);
    assert.equal(result.default, null); assert.equal(result.effort, null);
    assert.deepEqual(result.modes.map((mode) => mode.id), ['default', 'acceptEdits', 'auto', 'bypassPermissions']);
    assert.equal(result.defaultMode, null);
    // Another account's favorites and defaults are not this terminal's.
    assert.equal(result.profileId, undefined);
  }
});

test('native slash menu reads the terminal account commands and lets Claude own compact', async () => {
  const home = join(root,'native-account');
  mkdirSync(join(home,'commands'), {recursive:true});
  writeFileSync(join(home,'commands','account-task.md'), 'Only in the native account');
  const daemon = new Daemon();
  daemon.sessions = {
    get: () => ({engine:'claude', nativeChat:true, nativeHome:home, profileId:'unrelated', cwd:root}),
    commands: async () => CLAUDE_NATIVE_COMMANDS,
  };
  const result = await daemon.dispatch(M.SESSION_COMMANDS, {id:'native-test'});
  assert.equal(result.commands.find(command => command.name === 'account-task')?.source, 'yours');
  assert.equal(result.commands.find(command => command.name === 'compact')?.source, 'claude');
});
