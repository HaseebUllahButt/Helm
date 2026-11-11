import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'esbuild';
import vm from 'node:vm';

const source = readFileSync(new URL('../apps/web/src/NewChat.tsx', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'tsx', format: 'cjs', jsx: 'automatic', target: 'node22' });
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; }
function fixture() {
  const hooks = [], effects = [];
  let cursor = 0, queued = [];
  const react = {
    useState(value) { const i=cursor++; if (!(i in hooks)) hooks[i]=typeof value==='function'?value():value; return [hooks[i], v=>{ hooks[i]=typeof v==='function'?v(hooks[i]):v; }]; },
    useRef(value) { const i=cursor++; return hooks[i] ??= {current:value}; },
    useId() { cursor++; return 'picker'; },
    useMemo(fn) { cursor++; return fn(); },
    useEffect(fn,deps) { const i=cursor++; const prior=effects[i]; if (!prior || !deps || deps.some((v,n)=>v!==prior.deps?.[n])) { queued.push(()=>{ prior?.cleanup?.(); effects[i]={deps,cleanup:fn()}; }); } },
  };
  const jsx={ jsx:(type,props)=>({type,props}), jsxs:(type,props)=>({type,props}), Fragment:'fragment' };
  const pending=[];
  const common={name:'common',path:'~/common',isRepo:false};
  const modules={
    react, 'react/jsx-runtime':jsx, './errors':{errorMessage:e=>e.message}, './useDialog':{useDialog:()=>{}},
    './EngineMark':{EngineMark(){}}, './Icon':{Icon(){}}, './accountsCache':{watchAccounts:()=>()=>{}},
    './AccountLimits':{useAccountLimits:()=>({reports:{},failed:{},now:0})}, './balancer':{balanced:(_,usual)=>({account:usual}),windowsOf:()=>[]},
    '@helm/protocol/balance':{isOut:()=>false,outUntil:()=>null},
    './accounts':{loadPrefs:()=>({}),accountsFrom:()=>[],rememberFolder(){},savePrefs(){}},
    './folderIndex':{knownInside:()=>null, loadFolders:async()=>null, fetchFolders:async()=>({folders:[],count:0,at:1}), searchFolders:()=>[], rememberFolderMade(){},
      listFolder:(_,env,path)=>{ if(path==='~') return Promise.resolve({entries:[common]}); const d=deferred(); pending.push({env,path,...d}); return d.promise; }},
  };
  const module={exports:{}};
  vm.runInNewContext(code,{module,exports:module.exports,require:name=>modules[name]??{},window:{},localStorage:{getItem:()=>null,setItem(){}},setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){},Date,Set});
  const props={client:{},envs:[{id:'a',name:'A',online:true},{id:'b',name:'B',online:true}],onClose(){},onStarting(){},engineOf:()=>({label:'fake'})};
  let tree;
  function render() { cursor=0; queued=[]; tree=module.exports.NewChat(props); for(const fn of queued) fn(); return tree; }
  function nodes(node,out=[]) { if(Array.isArray(node)) { for (const item of node) nodes(item,out); return out; } if(!node||typeof node!=='object') return out; if(node.type) out.push(node); const c=node.props?.children; for(const v of Array.isArray(c)?c:[c]) nodes(v,out); return out; }
  function text(node) { if(Array.isArray(node)) return node.map(text).join(''); if(typeof node==='string') return node; if(!node||typeof node!=='object') return ''; const c=node.props?.children; return (Array.isArray(c)?c:[c]).map(text).join(''); }
  function option(name) { return nodes(tree).find(n=>n.props?.role==='option' && text(n).includes(name)); }
  function label(name) { return nodes(tree).find(n=>n.props?.['aria-label']===name); }
  return {pending,render,option,label,nodes,text};
}
async function flush() { await new Promise(resolve=>setImmediate(resolve)); }

test('late folder replies from another machine cannot replace the current folder', async () => {
  const f=fixture(); f.render(); f.option('A').props.onClick(); f.render(); await flush(); f.render();
  f.label('Open common').props.onClick(); f.render();
  const old=f.pending[0];
  f.label('Search folders on A').props.onKeyDown({key:'Backspace',nativeEvent:{},preventDefault(){}}); f.render();
  f.option('B').props.onClick(); f.render(); await flush(); f.render();
  f.label('Open common').props.onClick(); f.render();
  const current=f.pending[1];
  current.resolve({entries:[{name:'B child',path:'~/common/b',isRepo:false}]}); await flush(); f.render();
  old.resolve({entries:[{name:'A child',path:'~/common/a',isRepo:false}]}); await flush(); f.render();
  assert.ok(f.option('B child'));
  assert.equal(f.option('A child'),undefined);
});

test('late folder errors do not appear on the next machine', async () => {
  const f=fixture(); f.render(); f.option('A').props.onClick(); f.render(); await flush(); f.render();
  f.label('Open common').props.onClick(); f.render(); const old=f.pending[0];
  f.label('Search folders on A').props.onKeyDown({key:'Backspace',nativeEvent:{},preventDefault(){}}); f.render();
  f.option('B').props.onClick(); f.render(); await flush(); f.render();
  old.reject(new Error('Old machine failed')); await flush(); f.render();
  assert.equal(f.nodes(f.render()).some(node=>f.text(node)==='Old machine failed'),false);
});

test('a reply from an earlier visit stays stale after returning to the same machine', async () => {
  const f=fixture(); f.render(); f.option('A').props.onClick(); f.render(); await flush(); f.render();
  f.label('Open common').props.onClick(); f.render(); const old=f.pending[0];
  f.label('Search folders on A').props.onKeyDown({key:'Backspace',nativeEvent:{},preventDefault(){}}); f.render();
  f.option('B').props.onClick(); f.render(); await flush(); f.render();
  f.label('Search folders on B').props.onKeyDown({key:'Backspace',nativeEvent:{},preventDefault(){}}); f.render();
  f.option('A').props.onClick(); f.render(); await flush(); f.render();
  f.label('Open common').props.onClick(); f.render(); const current=f.pending[1];
  current.resolve({entries:[{name:'New child',path:'~/common/new',isRepo:false}]}); await flush(); f.render();
  old.resolve({entries:[{name:'Old child',path:'~/common/old',isRepo:false}]}); await flush(); f.render();
  assert.ok(f.option('New child'));
  assert.equal(f.option('Old child'),undefined);
});
