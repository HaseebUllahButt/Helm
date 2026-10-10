import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeClaudeAccount, nativeAccount } from '../packages/connect/src/native-account.js';
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

test('other native engines match config folders and actual credentials without crossing accounts',()=>{
  const profiles=[{id:'one',engine:'pi',env:{PI_CODING_AGENT_DIR:'~/.pi/shared',API_KEY:'one'}},
    {id:'two',engine:'pi',env:{PI_CODING_AGENT_DIR:'~/.pi/shared',API_KEY:'two'}},
    {id:'elsewhere',engine:'pi',env:{PI_CODING_AGENT_DIR:'~/.pi/other',API_KEY:'two'}}];
  for (const profile of profiles) { profile.envFrom=['API_KEY']; profile.secretRefs={API_KEY:profile.env.API_KEY}; }
  const session={engine:'pi',nativeHome:'~/.pi/shared'};
  const spec=p=>({env:p.env});
  assert.equal(nativeAccount(session,profiles,{spec}),null);
  assert.equal(nativeAccount(session,profiles,{spec,env:{API_KEY:'two'}}),profiles[1]);
  assert.equal(nativeAccount({...session,profileId:'elsewhere'},profiles,{spec,env:{API_KEY:'two'}}),profiles[1]);
  assert.equal(nativeAccount(session,profiles,{spec,env:{API_KEY:'unknown'}}),null);
});

test('a formerly guessed profile cannot override the running native login',()=>{
  assert.equal(nativeClaudeAccount({...session,profileId:'first'},profiles,{spec,env:{CLAUDE_CODE_OAUTH_TOKEN:'second-login'}}),second);
});
