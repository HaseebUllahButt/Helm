import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
const HOME = process.env.HOME;
const b64 = readFileSync(`${HOME}/helm-image-check/dot.png`).toString('base64');
const t = (await (await fetch('http://127.0.0.1:9334/json/list')).json()).find(x=>x.type==='page');
const ws = new WebSocket(t.webSocketDebuggerUrl,{maxPayload:256*1024*1024});
let id=0; const w=new Map();
ws.on('message',(r)=>{const m=JSON.parse(r); if(m.id&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id);}});
await new Promise(r=>ws.on('open',r));
const cmd=(me,p={})=>new Promise((res,rej)=>{const i=++id;const to=setTimeout(()=>rej(new Error(me+' timeout')),40000);w.set(i,(x)=>{clearTimeout(to);x.error?rej(new Error(JSON.stringify(x.error))):res(x.result)});ws.send(JSON.stringify({id:i,method:me,params:p}))});
const ev=async(e)=>(await cmd('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true})).result?.value;
const expr = `(async () => {
  const bin = atob(${JSON.stringify(b64)});
  const u8 = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i);
  const out = {};
  // 1. as a data URL
  out.dataUrl = await new Promise(r=>{const im=new Image();im.onload=()=>r('ok '+im.naturalWidth+'x'+im.naturalHeight);im.onerror=()=>r('FAILED');im.src='data:image/png;base64,${b64}';});
  // 2. as an object URL from a Blob, the way prepareImage does it
  const blob = new Blob([u8], {type:'image/png'});
  const url = URL.createObjectURL(blob);
  out.objectUrl = await new Promise(r=>{const im=new Image();im.onload=()=>r('ok '+im.naturalWidth+'x'+im.naturalHeight);im.onerror=()=>r('FAILED');im.src=url;});
  // 3. createImageBitmap
  try { const bm = await createImageBitmap(blob); out.bitmap = 'ok '+bm.width+'x'+bm.height; } catch(e) { out.bitmap = 'FAILED '+e.message; }
  // 4. what the file input actually holds
  const inp = document.querySelector('input[type=file]');
  const f = inp?.files?.[0];
  out.fileOnInput = f ? {name:f.name, type:f.type, size:f.size} : null;
  if (f) {
    const u = URL.createObjectURL(f);
    out.fromInput = await new Promise(r=>{const im=new Image();im.onload=()=>r('ok '+im.naturalWidth+'x'+im.naturalHeight);im.onerror=()=>r('FAILED');im.src=u;});
  }
  return JSON.stringify(out);
})()`;
console.log(await ev(expr));
ws.close(); process.exit(0);
