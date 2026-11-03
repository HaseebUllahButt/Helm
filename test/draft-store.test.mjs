import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';

const bundle = await build({ entryPoints:['apps/web/src/draftStore.ts'], bundle:true, write:false, format:'cjs' });
function fixture() {
  const saved=new Map(); let deny='';
  const localStorage={getItem(key){if(deny==='read')throw new Error('denied'); return saved.get(key)??null;},setItem(key,value){if(deny==='write')throw new Error('full'); saved.set(key,value);},removeItem(key){if(deny==='clear')throw new Error('denied'); saved.delete(key);}};
  const module={exports:{}};
  vm.runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,localStorage});
  return {...module.exports,saved,deny:value=>{deny=value;}};
}

test('draft storage reports read, write and clear failures', () => {
  const f=fixture(); f.saveDraft('pc','chat','saved');
  f.deny('read'); assert.throws(()=>f.loadDraft('pc','chat'),/read.*draft/i);
  f.deny('write'); assert.throws(()=>f.saveDraft('pc','chat','new'),/save.*draft/i);
  f.deny('clear'); assert.throws(()=>f.saveDraft('pc','chat',''),/clear.*draft/i);
  f.deny(''); assert.equal(f.loadDraft('pc','chat'),'saved');
});
