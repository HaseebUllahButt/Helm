import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
const HOME = process.env.HOME;
const net = JSON.parse(readFileSync(`${HOME}/.helm/network.json`,'utf8'));
const envId = net.self;
const HUB = process.env.HUB;
const auth = await (await fetch(`${HUB}/api/auth/login`, {
  method:'POST', headers:{'content-type':'application/json'},
  body: JSON.stringify({ password: process.env.PASS, label:'latency' }),
})).json();
if (!auth.token) { console.log('login failed', JSON.stringify(auth)); process.exit(1); }
const ws = new WebSocket(`${HUB.replace('http','ws')}/ws`, ['helm', auth.token]);
let id=0; const w=new Map(); const onData=[];
ws.on('message',(r)=>{const m=JSON.parse(r);
  if(m.t==='rpcResult'&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id);return;}
  if(m.t==='event'&&m.kind==='session.data') onData.forEach(f=>f(m.payload));
});
await new Promise(r=>ws.on('open',r));
const rpc=(method,params={},ms=30000)=>new Promise((res,rej)=>{const i=++id;const to=setTimeout(()=>rej(new Error(method+' timeout')),ms);w.set(i,(m)=>{clearTimeout(to);m.ok?res(m.result):rej(new Error(m.error?.message||'fail'))});ws.send(JSON.stringify({t:'rpc',id:i,env:envId,method,params}))});

// bare RPC round trip through this hub
const rtts=[];
for (let i=0;i<12;i++){ const t=Date.now(); await rpc('session.list'); rtts.push(Date.now()-t); }
rtts.sort((a,b)=>a-b);
console.log(`${HUB} RPC round trip: median ${rtts[6]}ms  min ${rtts[0]}ms  max ${rtts[11]}ms`);

// now a real terminal echo
const { session } = await rpc('session.start', { cwd: HOME, profileId: 'shell' });
await rpc('session.attach', { id: session.id, cols: 80, rows: 24 });
await new Promise(r=>setTimeout(r,1200));
const echoes=[];
for (let i=0;i<10;i++){
  await new Promise(r=>setTimeout(r,350));
  const ch = String.fromCharCode(97 + i);
  const t0 = Date.now();
  const seen = new Promise((res)=>{ const f=(p)=>{ if(p.id===session.id && String(p.text??'').includes(ch)){ onData.splice(onData.indexOf(f),1); res(Date.now()-t0);} }; onData.push(f); setTimeout(()=>res(-1), 4000); });
  rpc('session.input', { id: session.id, data: ch, raw: true }).catch(()=>{});
  const ms = await seen;
  if (ms>=0) echoes.push(ms);
}
echoes.sort((a,b)=>a-b);
console.log(`terminal echo: median ${echoes[Math.floor(echoes.length/2)]}ms  min ${echoes[0]}ms  max ${echoes[echoes.length-1]}ms  (n=${echoes.length})`);
await rpc('session.kill',{id:session.id}).catch(()=>{});
ws.close(); process.exit(0);
