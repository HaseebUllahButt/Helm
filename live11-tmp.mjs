import { writeFileSync } from 'node:fs';
import { WebSocket } from 'ws';
const SB = process.env.SB, HOME = process.env.HOME;
const t = (await (await fetch('http://127.0.0.1:9334/json/list')).json()).find(x=>x.type==='page');
const ws = new WebSocket(t.webSocketDebuggerUrl,{maxPayload:256*1024*1024});
let id=0; const w=new Map();
ws.on('message',(r)=>{const m=JSON.parse(r); if(m.id&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id);}});
await new Promise(r=>ws.on('open',r));
const cmd=(me,p={})=>new Promise((res,rej)=>{const i=++id;const to=setTimeout(()=>rej(new Error(me+' timeout')),90000);w.set(i,(x)=>{clearTimeout(to);x.error?rej(new Error(JSON.stringify(x.error))):res(x.result)});ws.send(JSON.stringify({id:i,method:me,params:p}))});
const ev=async(e)=>(await cmd('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true})).result?.value;
const shot=async(n)=>{const s=await cmd('Page.captureScreenshot',{format:'png'});writeFileSync(`${SB}/shots/${n}`,Buffer.from(s.data,'base64'));console.log('saved',n);};
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
const main=async(n=700)=>(await ev(`document.querySelector('.main')?.innerText`))?.replace(/\n+/g,' | ').slice(0,n);
await cmd('Page.enable'); await cmd('Runtime.enable'); await cmd('DOM.enable'); await cmd('Network.enable');
await cmd('Network.setCacheDisabled',{cacheDisabled:true});
await cmd('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});
await cmd('Page.reload',{ignoreCache:true});
await wait(9000);
await ev(`(()=>{const e=[...document.querySelectorAll('.rt')].find(x=>x.textContent.trim()==='haseeb'); e?.closest('button')?.click(); return !!e;})()`);
await wait(5000);
// open the existing Devin thread
console.log('open devin thread:', await ev(`(()=>{const e=[...document.querySelectorAll('.rt')].find(x=>x.textContent.trim()==='helm-image-check'); e?.closest('button')?.click(); return !!e;})()`));
await wait(7000);
console.log('in session:', await main(200));

const doc = await cmd('DOM.getDocument', { depth: -1 });
const node = await cmd('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
await cmd('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [`${HOME}/helm-image-check/dot.png`] });
await wait(3500);
console.log('previews:', await ev(`document.querySelectorAll('.attach-preview img').length`));
console.log('error line:', await ev(`document.querySelector('.error')?.innerText ?? '(none)'`));
await shot('e1-attached.png');
if (await ev(`document.querySelectorAll('.attach-preview img').length`) > 0) {
  await ev(`(()=>{const ta=document.querySelector('.slab textarea');
    const set=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
    set.call(ta,'Describe ONLY the image I just attached, in exactly two words: background colour, then the shape. Do not read any files.');
    ta.dispatchEvent(new Event('input',{bubbles:true})); return true;})()`);
  await wait(600);
  await ev(`document.querySelector('button.send')?.click()`);
  console.log('sent');
  for (let i=0;i<12;i++) {
    await wait(6000);
    const done = await ev(`!!document.querySelector('.turn .turnfoot, .turn-done') || document.body.innerText.includes('Red circle') || document.body.innerText.includes('red circle')`);
    if (done) break;
  }
  console.log('--- after ---'); console.log(await main(900));
  console.log('user bubbles:', await ev(`document.querySelectorAll('.turn.user').length`));
  console.log('images shown:', await ev(`document.querySelectorAll('.turn-image').length`));
  await shot('e2-reply.png');
}
ws.close(); process.exit(0);
