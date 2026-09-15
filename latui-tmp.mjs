import { WebSocket } from 'ws';
const t = (await (await fetch('http://127.0.0.1:9334/json/list')).json()).find(x=>x.type==='page');
const ws = new WebSocket(t.webSocketDebuggerUrl,{maxPayload:256*1024*1024});
let id=0; const w=new Map();
ws.on('message',(r)=>{const m=JSON.parse(r); if(m.id&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id);}});
await new Promise(r=>ws.on('open',r));
const cmd=(me,p={})=>new Promise((res,rej)=>{const i=++id;const to=setTimeout(()=>rej(new Error(me+' timeout')),120000);w.set(i,(x)=>{clearTimeout(to);x.error?rej(new Error(JSON.stringify(x.error))):res(x.result)});ws.send(JSON.stringify({id:i,method:me,params:p}))});
const ev=async(e)=>(await cmd('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true})).result?.value;
console.log(await ev(`(async () => {
  const c = window.__helmClient;
  if (!c) return 'no client handle on window';
  const envs = (await c.environments()).environments;
  const me = envs.find(e => e.name === 'haseeb') || envs[0];
  const out = { env: me.name, direct: c.directTo(me.id) };
  const t = [];
  for (let i = 0; i < 10; i++) { const s = performance.now(); await c.rpc(me.id, 'session.list'); t.push(Math.round(performance.now() - s)); }
  t.sort((a,b)=>a-b);
  out.rpcMedian = t[5]; out.rpcMin = t[0]; out.rpcMax = t[9];
  return JSON.stringify(out);
})()`));
ws.close(); process.exit(0);
