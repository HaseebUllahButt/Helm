import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
const HOME=process.env.HOME;
const net=JSON.parse(readFileSync(`${HOME}/.helm/network.json`,'utf8'));
const auth = await (await fetch('http://127.0.0.1:8787/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:process.env.PASS,label:'loop'})})).json();
if(!auth.token){console.log('login failed',JSON.stringify(auth));process.exit(1);}
const ws=new WebSocket('ws://127.0.0.1:8787/ws',['helm',auth.token]);
let id=0;const w=new Map();
ws.on('message',(r)=>{const m=JSON.parse(r);if(m.t==='rpcResult'&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id);}});
await new Promise(r=>ws.on('open',r));
const rpc=(method,params={})=>new Promise((res,rej)=>{const i=++id;const to=setTimeout(()=>rej(new Error('timeout')),30000);w.set(i,(m)=>{clearTimeout(to);m.ok?res(m.result):rej(new Error(m.error?.message))});ws.send(JSON.stringify({t:'rpc',id:i,env:net.self,method,params}))});
for (const m of ['ping','session.list']) {
  const t=[];
  for(let i=0;i<15;i++){const s=performance.now();await rpc(m);t.push(performance.now()-s);}
  t.sort((a,b)=>a-b);
  console.log(`${m.padEnd(14)} loopback: median ${t[7].toFixed(1)}ms  min ${t[0].toFixed(1)}ms  max ${t[14].toFixed(1)}ms`);
}
ws.close();process.exit(0);
