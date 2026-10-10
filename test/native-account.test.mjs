import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeClaudeAccount } from '../packages/connect/src/native-account.js';
const profile = (id, token) => ({id,engine:'claude',env:{CLAUDE_CONFIG_DIR:'~/.claude-shared'},
  envFrom:['CLAUDE_CODE_OAUTH_TOKEN'],secretRefs:{CLAUDE_CODE_OAUTH_TOKEN:token},testEnv:{CLAUDE_CODE_OAUTH_TOKEN:token}});
const first=profile('first','first-login'), second=profile('second','second-login'), alias=profile('alias','second-login');
const profiles=[first,second,alias];
const session={nativeHome:'~/.claude-shared'};
const spec=p=>({env:p.testEnv});

test('native account uses its recorded profile instead of another login in the same folder',()=>{
  assert.equal(nativeClaudeAccount({...session,profileId:'alias'},profiles,{spec}),alias);
});
test('native account resolves the live CLI login, sharing preferences between its aliases',()=>{
  assert.equal(nativeClaudeAccount(session,profiles,{spec,env:{CLAUDE_CODE_OAUTH_TOKEN:'second-login'}}),second);
});
test('unknown native login cannot silently save defaults to the first account',()=>{
  assert.equal(nativeClaudeAccount(session,profiles,{spec}),null);
  assert.equal(nativeClaudeAccount(session,profiles,{spec,env:{CLAUDE_CODE_OAUTH_TOKEN:'other-login'}}),null);
  assert.equal(nativeClaudeAccount({...session,profileId:'missing'},profiles,{spec}),null);
  assert.equal(nativeClaudeAccount({nativeHome:'~/.different-home',profileId:'second'},profiles,{spec}),null);
});
test('a single unambiguous native account remains usable without a readable process',()=>{
  assert.equal(nativeClaudeAccount(session,[second,alias],{spec}),second);
});
