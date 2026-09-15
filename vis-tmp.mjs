import { WebSocket } from 'ws';
const t = (await (await fetch('http://127.0.0.1:9334/json/list')).json()).find(x=>x.type==='page');
const ws = new WebSocket(t.webSocketDebuggerUrl,{maxPayload:64*1024*1024});
let id=0; const w=new Map();
ws.on('message',(r)=>{const m=JSON.parse(r); if(m.id&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id);}});
await new Promise(r=>ws.on('open',r));
const cmd=(me,p={})=>new Promise((res,rej)=>{const i=++id;const to=setTimeout(()=>rej(new Error('t/o')),60000);w.set(i,(x)=>{clearTimeout(to);x.error?rej(new Error(JSON.stringify(x.error))):res(x.result)});ws.send(JSON.stringify({id:i,method:me,params:p}))});
const ev=async(e)=>(await cmd('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true})).result?.value;
console.log('visibilityState:', await ev(`document.visibilityState`));
console.log('hasFocus:', await ev(`document.hasFocus()`));
// how long does a bare setTimeout(0) actually take here?
console.log(await ev(`(async () => {
  const t = [];
  for (let i=0;i<8;i++){ const s=performance.now(); await new Promise(r=>setTimeout(r,0)); t.push(Math.round(performance.now()-s)); }
  return 'setTimeout(0) actual delays: ' + t.join(', ') + ' ms';
})()`));
ws.close(); process.exit(0);
