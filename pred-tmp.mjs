import { WebSocket } from 'ws';
const KEY=process.env.KEY, SB=process.env.SB;
const t = (await (await fetch('http://127.0.0.1:9334/json/list')).json()).find(x=>x.type==='page');
const ws = new WebSocket(t.webSocketDebuggerUrl,{maxPayload:64*1024*1024});
let id=0; const w=new Map();
ws.on('message',(r)=>{const m=JSON.parse(r); if(m.id&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id);}});
await new Promise(r=>ws.on('open',r));
const cmd=(me,p={})=>new Promise((res,rej)=>{const i=++id;const to=setTimeout(()=>rej(new Error('t/o')),90000);w.set(i,(x)=>{clearTimeout(to);x.error?rej(new Error(JSON.stringify(x.error))):res(x.result)});ws.send(JSON.stringify({id:i,method:me,params:p}))});
const ev=async(e)=>(await cmd('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true})).result?.value;
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
const until=async(e,l,n=30)=>{for(let i=0;i<n;i++){if(await ev(e))return true;await wait(1500);}console.log('TIMEOUT:',l);return false;};
const type=async(s)=>ev(`(()=>{const ta=document.querySelector('.xterm-helper-textarea')||document.querySelector('.xterm textarea');
  for (const ch of ${JSON.stringify(s)}) { ta.value=ch; ta.dispatchEvent(new Event('input',{bubbles:true})); }
  return true;})()`);
const key=async(k)=>ev(`(()=>{const ta=document.querySelector('.xterm-helper-textarea')||document.querySelector('.xterm textarea');
  ta.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},bubbles:true,cancelable:true})); return true;})()`);
const screen=async()=>(await ev(`document.querySelector('.xterm-rows')?.innerText`))?.split('\n').filter(l=>l.trim()).slice(-8).join('\n');
await cmd('Page.enable'); await cmd('Runtime.enable'); await cmd('Network.enable');
await cmd('Network.setCacheDisabled',{cacheDisabled:true});
await cmd('Emulation.setDeviceMetricsOverride',{width:430,height:900,deviceScaleFactor:2,mobile:true});
// already on the machine view from the previous run
await ev(`(()=>{const e=[...document.querySelectorAll('.rt')].find(x=>x.textContent.trim()==='Terminal 1'); e?.closest('button')?.click(); return !!e;})()`);
await until(`!!document.querySelector('.xterm-rows')`,'terminal',40);
await wait(7000);
console.log('terminal open:', await ev(`!!document.querySelector('.xterm-rows')`));

console.log('=== 1. plain typing (prediction on) ===');
await type('echo hello-predict');
await wait(1500);
console.log(await screen());
await key('Enter'); await wait(2000);
console.log('--- after Enter ---');
console.log(await screen());

console.log('\n=== 2. no double characters? ===');
await type('echo aaa');
await wait(1800);
const line = await ev(`[...document.querySelectorAll('.xterm-rows > div')].map(d=>d.innerText).filter(l=>l.includes('echo aaa')).pop()`);
console.log('line containing it:', JSON.stringify(line));
await key('Enter'); await wait(1500);

console.log('\n=== 3. a prompt that does not echo ===');
await type('read -s -p "secret: " x; echo');
await key('Enter'); await wait(2000);
await type('hunter2');
await wait(1500);
console.log('while typing a hidden password:');
console.log(await screen());
await key('Enter'); await wait(1500);
console.log('--- after ---');
console.log(await screen());
ws.close(); process.exit(0);
