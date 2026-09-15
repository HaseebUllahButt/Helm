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
const main=async(n=600)=>(await ev(`document.querySelector('.main')?.innerText`))?.replace(/\n+/g,' | ').slice(0,n);
await cmd('Page.enable'); await cmd('Runtime.enable'); await cmd('DOM.enable');

// put the file straight on the hidden input the clip drives
const doc = await cmd('DOM.getDocument', { depth: -1 });
const node = await cmd('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
console.log('file input nodeId:', node.nodeId);
await cmd('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [`${HOME}/helm-image-check/dot.png`] });
await wait(3000);
console.log('previews:', await ev(`document.querySelectorAll('.attach-preview img').length`));
await shot('d3-attached.png');

// type and send
await ev(`(()=>{const ta=document.querySelector('.slab textarea');
  const set=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
  set.call(ta,'Look at the attached image. Reply with exactly two words: the background colour, then the shape in the middle. Nothing else.');
  ta.dispatchEvent(new Event('input',{bubbles:true})); return true;})()`);
await wait(600);
await ev(`document.querySelector('button.send')?.click()`);
console.log('sent');
for (let i=0;i<12;i++) {
  await wait(6000);
  const txt = await main(900);
  if (/circle|Circle|red|Red/.test(txt.split('Nothing else.')[1] ?? '')) { console.log('--- reply ---'); console.log(txt); break; }
  if (i===11) { console.log('--- last seen ---'); console.log(txt); }
}
console.log('user bubbles:', await ev(`document.querySelectorAll('.turn.user').length`));
console.log('images:', await ev(`document.querySelectorAll('.turn-image').length`));
await shot('d4-reply.png');
ws.close(); process.exit(0);
