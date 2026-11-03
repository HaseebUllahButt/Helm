import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';

const bundle=await build({stdin:{contents:"export { useDraftStorage } from './apps/web/src/useDraftStorage'; export { reportDraftFailure } from './apps/web/src/draftStore';",resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'cjs',external:['react']});
function fixture(readDenied=false) {
  const saved=new Map([['helm-draft:pc:chat','older words']]), hooks=[], listeners=new Map();
  let cursor=0, denyRead=readDenied, denyWrite=false, denyClear=false;
  const react={
    useState(v){const i=cursor++; if(!(i in hooks))hooks[i]=typeof v==='function'?v():v;return [hooks[i],n=>{hooks[i]=typeof n==='function'?n(hooks[i]):n;}];},
    useRef(v){const i=cursor++; return hooks[i] ??= {current:v};},
    useCallback(fn){cursor++;return fn;},
    useEffect(fn){const i=cursor++;if(!(i in hooks)){hooks[i]=true;fn();}},
  };
  const localStorage={getItem:k=>{if(denyRead)throw Error();return saved.get(k)??null;},setItem:(k,v)=>{if(denyWrite)throw Error();saved.set(k,v);},removeItem:k=>{if(denyClear)throw Error();saved.delete(k);}};
  const window={addEventListener:(k,v)=>listeners.set(k,v),removeEventListener:k=>listeners.delete(k),dispatchEvent:e=>listeners.get(e.type)?.(e)};
  const module={exports:{}};
  vm.runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require:()=>react,localStorage,window,CustomEvent:class{constructor(type,opts){this.type=type;this.detail=opts.detail;}}});
  return {render(){cursor=0;return module.exports.useDraftStorage('pc','chat');},remount(){hooks.length=0;listeners.clear();},saved,setRead:v=>{denyRead=v;},setWrite:v=>{denyWrite=v;},setClear:v=>{denyClear=v;},report:module.exports.reportDraftFailure};
}

test('a failed read stays visible and does not overwrite unseen words',()=>{
  const f=fixture(true); const draft=f.render(); assert.match(draft.error,/read.*draft/i);
  f.setRead(false); draft.save('new words');
  assert.equal(f.saved.get('helm-draft:pc:chat'),'older words');
  assert.match(f.render().error,/read.*draft/i);
});

test('save and clear failures stay visible until a save succeeds',()=>{
  const f=fixture(); let draft=f.render();
  f.setWrite(true); draft.save('new words'); assert.match(f.render().error,/save.*draft/i);
  f.setWrite(false); draft.save('new words'); assert.equal(f.render().error,'');
  f.setClear(true); draft.save(''); assert.match(f.render().error,/clear.*draft/i);
  f.setClear(false); draft.save(''); assert.equal(f.render().error,'');
});

test('an unsaved draft stays visible after leaving and returning',()=>{
  const f=fixture(); const draft=f.render();
  f.setWrite(true); draft.save('unfinished words');
  f.remount(); const returned=f.render();
  assert.equal(returned.initial,'unfinished words');
  assert.match(returned.error,/save.*draft/i);
  assert.equal(f.saved.get('helm-draft:pc:chat'),'older words');
});

test('words that could not move from a starting chat appear on entry',()=>{
  const f=fixture(); f.report('pc','chat','Cannot save this draft.','unfinished words');
  const draft=f.render();
  assert.equal(draft.initial,'unfinished words');
  assert.equal(draft.isSaved(),false);
  draft.save('edited words');
  assert.equal(draft.isSaved(),true);
  assert.equal(f.saved.get('helm-draft:pc:chat'),'edited words');
});
