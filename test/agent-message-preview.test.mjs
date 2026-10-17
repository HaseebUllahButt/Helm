import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=await build({entryPoints:['apps/web/src/session/agentMessage.ts'],bundle:true,write:false,format:'esm',platform:'browser'});
const {splitAgentMessage}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const id='a'.repeat(32);
const header=`[Helm agent message ${id}]\nFrom claude agent UI review (local/helper).\n`;
const instruction='This is a message, not a transfer of their conversation. Keep working in your own context.\nIf a reply is needed, send it with: helm reply id "answer".\n\n';
test('agent queue previews show distinct bodies and keep their sender outside the text',()=>{
 const a=splitAgentMessage(header+instruction+'Tests passed.\n\nDetails here.');
 assert.deepEqual(a,{note:'From claude agent UI review (local/helper).',text:'Tests passed.\n\nDetails here.'});
 assert.equal(splitAgentMessage(header+`Reply to ${id}.\n`+instruction+'Layout fixed.').text,'Layout fixed.');
 assert.equal(splitAgentMessage(header+instruction+'').text,'');
});
test('ordinary text and incomplete envelopes remain intact',()=>{
 for(const text of ['hello',header+'User-provided note.\n\nKeep this.',undefined])assert.deepEqual(splitAgentMessage(text),{text});
});
