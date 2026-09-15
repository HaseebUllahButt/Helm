import { WebSocket } from 'ws';
const t = (await (await fetch('http://127.0.0.1:9334/json/list')).json()).find(x=>x.type==='page');
const ws = new WebSocket(t.webSocketDebuggerUrl,{maxPayload:64*1024*1024});
let id=0; const w=new Map();
ws.on('message',(r)=>{const m=JSON.parse(r); if(m.id&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id);}});
await new Promise(r=>ws.on('open',r));
const cmd=(me,p={})=>new Promise((res,rej)=>{const i=++id;const to=setTimeout(()=>rej(new Error('t/o')),90000);w.set(i,(x)=>{clearTimeout(to);x.error?rej(new Error(JSON.stringify(x.error))):res(x.result)});ws.send(JSON.stringify({id:i,method:me,params:p}))});
const ev=async(e)=>(await cmd('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true})).result?.value;
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
const screen=async(n=6)=>(await ev(`document.querySelector('.xterm-rows')?.innerText`))?.split('\n').map(l=>l.replace(/\s+$/,'')).filter(l=>l.trim()).slice(-n).join('\n');
await cmd('Runtime.enable'); await cmd('Page.enable');

// focus the terminal, then use real key events
await ev(`document.querySelector('.xterm-helper-textarea')?.focus()`);
const typeText = async (s) => { for (const ch of s) { await cmd('Input.dispatchKeyEvent',{type:'keyDown',text:ch,key:ch,unmodifiedText:ch}); await cmd('Input.dispatchKeyEvent',{type:'keyUp',key:ch}); await wait(40); } };
const enter = async () => { await cmd('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'}); await cmd('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13}); };

await typeText('clear'); await enter(); await wait(1500);

console.log('=== 1. typing, with prediction forced on ===');
await typeText('echo hello-predict');
await wait(1200);
console.log(await screen(3));
await enter(); await wait(1800);
console.log('--- after Enter ---');
console.log(await screen(4));

console.log('\n=== 2. repeated characters: any doubling? ===');
await typeText('echo aaa-bbb'); await wait(1200);
const l = await ev(`[...document.querySelectorAll('.xterm-rows > div')].map(d=>d.innerText.replace(/\\s+$/,'')).filter(x=>x.includes('aaa')).pop()`);
console.log('the line:', JSON.stringify(l));
await enter(); await wait(1500);
console.log(await screen(3));

console.log('\n=== 3. a prompt that echoes nothing ===');
await typeText('read -s -p "secret: " V; echo "[got ${#V} chars]"'); await enter(); await wait(2000);
await typeText('hunter2'); await wait(1500);
console.log('while typing the hidden password:');
console.log(await screen(3));
await enter(); await wait(1800);
console.log('--- after ---');
console.log(await screen(4));
ws.close(); process.exit(0);
