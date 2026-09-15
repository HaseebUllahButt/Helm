import { readFileSync, writeFileSync } from 'node:fs';
import { WebSocket } from 'ws';
const SB = process.env.SB;
const t = (await (await fetch('http://127.0.0.1:9334/json/list')).json()).find(x=>x.type==='page');
const ws = new WebSocket(t.webSocketDebuggerUrl,{maxPayload:256*1024*1024});
let id=0; const w=new Map(); const logs=[];
ws.on('message',(r)=>{const m=JSON.parse(r);
  if(m.id&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id);return;}
  if(m.method==='Runtime.exceptionThrown') logs.push('EXCEPTION: '+(m.params.exceptionDetails?.exception?.description||'').slice(0,200));
});
await new Promise(r=>ws.on('open',r));
const cmd=(me,p={})=>new Promise((res,rej)=>{const i=++id;const to=setTimeout(()=>rej(new Error(me+' timeout')),40000);w.set(i,(x)=>{clearTimeout(to);x.error?rej(new Error(JSON.stringify(x.error))):res(x.result)});ws.send(JSON.stringify({id:i,method:me,params:p}))});
const ev=async(e)=>(await cmd('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true})).result?.value;
const shot=async(n)=>{const s=await cmd('Page.captureScreenshot',{format:'png'});writeFileSync(`${SB}/${n}`,Buffer.from(s.data,'base64'));console.log('saved',n);};
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
await cmd('Page.enable'); await cmd('Runtime.enable');
await cmd('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});
await wait(1500);
await shot('live-2-paired.png');
console.log('text:', (await ev('document.body.innerText'))?.replace(/\n+/g,' | ').slice(0,300));

// open the laptop (haseeb) - it has the usage dashboard
await ev(`(()=>{const el=[...document.querySelectorAll('.rt')].find(e=>e.textContent.trim()==='haseeb'); (el?.closest('button')||el)?.click(); return true;})()`);
await wait(6000);
console.log('--- haseeb machine ---');
console.log((await ev('document.body.innerText'))?.replace(/\n+/g,' | ').slice(0,700));
await shot('live-3-haseeb.png');
console.log('exceptions:', logs.slice(0,5));
ws.close(); process.exit(0);
