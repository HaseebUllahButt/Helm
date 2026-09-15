import { WebSocket } from 'ws';
const SB=process.env.SB;
const t = (await (await fetch('http://127.0.0.1:9334/json/list')).json()).find(x=>x.type==='page');
const ws = new WebSocket(t.webSocketDebuggerUrl,{maxPayload:64*1024*1024});
let id=0; const w=new Map();
ws.on('message',(r)=>{const m=JSON.parse(r); if(m.id&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id);}});
await new Promise(r=>ws.on('open',r));
const cmd=(me,p={})=>new Promise((res,rej)=>{const i=++id;const to=setTimeout(()=>rej(new Error('t/o')),90000);w.set(i,(x)=>{clearTimeout(to);x.error?rej(new Error(JSON.stringify(x.error))):res(x.result)});ws.send(JSON.stringify({id:i,method:me,params:p}))});
const ev=async(e)=>(await cmd('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true})).result?.value;
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
const until=async(e,l,n=30)=>{for(let i=0;i<n;i++){if(await ev(e))return true;await wait(2000);}console.log('TIMEOUT:',l);return false;};
await cmd('Page.enable'); await cmd('Runtime.enable'); await cmd('Network.enable');
await cmd('Network.setCacheDisabled',{cacheDisabled:true});
await cmd('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});
await cmd('Page.reload',{ignoreCache:true});
await until(`[...document.querySelectorAll('.rt')].some(x=>x.textContent.trim()==='haseeb')`,'machines');
await ev(`(()=>{const e=[...document.querySelectorAll('.rt')].find(x=>x.textContent.trim()==='haseeb'); e?.closest('button')?.click();})()`);
await until(`!!document.querySelector('.sub')`,'machine');
// open a terminal
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim().startsWith('❯')); b?.click(); return !!b;})()`);
await until(`!!document.querySelector('.xterm-host .xterm')`,'terminal');
await wait(6000);
console.log('header:', await ev(`document.querySelector('.sub')?.innerText?.replace(/\\n/g,' ')`));
// type characters and time until they appear on screen
console.log(await ev(`(async () => {
  const sel = document.querySelector('.xterm-helper-textarea') || document.querySelector('.xterm textarea');
  if (!sel) return 'no xterm textarea';
  const rows = () => document.querySelector('.xterm-rows')?.innerText ?? '';
  const times = [];
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 400));
    const ch = String.fromCharCode(97 + i);
    const before = rows();
    const t0 = performance.now();
    sel.dispatchEvent(new InputEvent('input', { data: ch, inputType: 'insertText', bubbles: true }));
    sel.value = ch;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    let seen = -1;
    for (let k = 0; k < 400; k++) {
      await new Promise(r => requestAnimationFrame(r));
      if (rows() !== before) { seen = performance.now() - t0; break; }
    }
    if (seen >= 0) times.push(Math.round(seen));
  }
  times.sort((a,b)=>a-b);
  return 'keystroke to pixels: ' + JSON.stringify(times) + ' ms';
})()`));
ws.close(); process.exit(0);
