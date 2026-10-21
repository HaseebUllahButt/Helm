import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

test('Claude picker selects Opus 5.5 immediately and receives later catalog additions', async () => {
  const bundle = await build({
    stdin: { contents: `
      import React, { useEffect, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { Controls } from './apps/web/src/session/Controls';
      import { followModelRefresh } from './apps/web/src/modelRefresh';
      let release;
      const published = new Promise(resolve => { release = resolve; });
      window.completeCatalog = () => release({
        models: ['claude-opus-5-5', 'claude-sonnet-5-5'],
        labels: { 'claude-opus-5-5': 'Claude Opus 5.5', 'claude-sonnet-5-5': 'Claude Sonnet 5.5' },
        refreshing: false,
      });
      function Picker() {
        const [options, setOptions] = useState(null);
        const [model, setModel] = useState('claude-opus-5');
        useEffect(() => {
          let calls = 0;
          const catalog = followModelRefresh(async () => ++calls === 1 ? {
            models: ['claude-opus-5-5'], labels: { 'claude-opus-5-5': 'Claude Opus 5.5' }, refreshing: true,
          } : published, setOptions, error => { throw error; }, 5);
          return catalog.stop;
        }, []);
        const controls = Controls({ options, session: { engine: 'claude', model },
          onPick: (kind, id) => { window.picked = id; setModel(id); } });
        return <>{controls.chips}{controls.sheet}</>;
      }
      createRoot(document.getElementById('root')).render(<Picker />);
    `, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
  });
  const browser = await chromium.launch({ headless: true,
    ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}),
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.locator('button[title^="model:"]').click();
    await page.getByRole('option', { name: 'Opus 5.5', exact: true }).click();
    assert.equal(await page.evaluate(() => window.picked), 'claude-opus-5-5');
    await page.evaluate(() => window.completeCatalog());
    await page.locator('button[title^="model:"]').click();
    await page.getByRole('option', { name: 'Sonnet 5.5', exact: true }).click();
    assert.equal(await page.evaluate(() => window.picked), 'claude-sonnet-5-5');
  } finally { await browser.close(); }
});

test('favorite stars never select a model or change its default; explicit default buttons stay independent', async () => {
  const bundle = await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { Controls } from './apps/web/src/session/Controls';
    function Picker() {
      const [session, setSession] = useState({ engine:'codex', model:'a', effort:'high', mode:'ask', speed:'' });
      const [options, setOptions] = useState({ models:['a','b'], more:['c'], labels:{a:'Model A',b:'Model B',c:'Model C'},
        default:'a', effort:'low', efforts:['low','high','xhigh'],
        effortsByModel:{a:['low','high','xhigh'], b:['low'], c:[]}, speeds:['fast'],
        modes:[{id:'ask',label:'Ask'},{id:'yolo',label:'YOLO',danger:true}], defaultMode:'ask',
        defaults:{effort:'xhigh', mode:'ask',speed:'fast'}, favs:['a'] });
      const controls = Controls({ options, session,
        // Model changes return the provider's accepted effort in a real chat.
        // The picker itself preserves reported settings until that response.
        onPick:(kind,id)=>{ window.picks = (window.picks ?? 0)+1; setSession(s=>({...s,[kind]:id,
          ...(kind==='model' ? {effort:id==='b' ? 'low' : id==='c' ? '' : s.effort} : {})})); },
        onFavs:favs=>setOptions(o=>({...o,favs})),
        onDefault:async(kind,id)=>{
          if (window.failSave) throw new Error('Save failed; try again');
          window.saved = {kind,id};
          setOptions(o=>kind==='model' ? {...o,prefs:{default:id}} : {...o,defaults:{...o.defaults,[kind]:id}});
        } });
      return <>{controls.chips}{controls.sheet}</>;
    }
    createRoot(document.getElementById('root')).render(<Picker />);
  `, resolveDir:process.cwd(), loader:'tsx' }, bundle:true,write:false,format:'iife',jsx:'automatic' });
  const browser = await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM ? {executablePath:process.env.HELM_TEST_CHROMIUM} : {})});
  try {
    for (const width of [1280,390]) {
      const page = await browser.newPage({ viewport:{width,height:850} });
      await page.setContent('<div class="session"><div id="root"></div></div>');
      await page.addStyleTag({content:(await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'')});
      await page.addScriptTag({content:bundle.outputFiles[0].text});
      await page.locator('button[title^="thinking:"]').click();
      assert.equal(await page.getByRole('option',{name:'high',exact:true}).getAttribute('aria-selected'),'true');
      await page.getByRole('button',{name:'Use low by default for new chats',exact:true}).click();
      // Five levels need no favorites.
      assert.equal(await page.getByRole('checkbox',{name:'Favorite high',exact:true}).count(),0);
      assert.equal(await page.locator('.modesheet').count(),1);
      assert.equal(await page.getByRole('button',{name:'low is the default for new chats'}).getAttribute('aria-pressed'),'true');
      assert.equal(await page.getByRole('option',{name:'high',exact:true}).getAttribute('aria-selected'),'true');
      assert.equal(await page.evaluate(()=>window.picks ?? 0),0);
      if (process.env.HELM_TEST_SCREENSHOT_DIR) await page.screenshot({path:process.env.HELM_TEST_SCREENSHOT_DIR+'/thinking-'+width+'.png'});
      await page.locator('button[title^="model:"]').click();
      await page.getByRole('checkbox',{name:'Favorite Model B'}).check();
      assert.equal(await page.getByRole('button',{name:'Model A is the default for new chats'}).innerText(),'Default');
      assert.equal(await page.getByRole('button',{name:'Use Model B by default for new chats'}).innerText(),'Set default');
      assert.deepEqual(await page.evaluate(()=>window.saved),{kind:'effort',id:'low'});
      assert.equal(await page.getByRole('option',{name:'Model A',exact:true}).getAttribute('aria-selected'),'true');
      assert.equal(await page.evaluate(()=>window.picks ?? 0),0);
      await page.getByRole('button',{name:'Use Model C by default for new chats'}).count().then(n=>assert.equal(n,0));
      await page.getByRole('button',{name:/1 more/}).click();
      await page.getByRole('button',{name:'Use Model C by default for new chats'}).click();
      assert.equal(await page.locator('.modesheet').count(),1);
      assert.equal(await page.getByRole('checkbox',{name:'Favorite Model B'}).isChecked(),true);
      assert.equal(await page.getByRole('checkbox',{name:'Favorite Model C'}).isChecked(),false);
      assert.equal(await page.getByRole('option',{name:'Model A',exact:true}).getAttribute('aria-selected'),'true');
      assert.equal(await page.evaluate(()=>window.picks ?? 0),0);
      await page.getByRole('checkbox',{name:'Favorite Model B'}).uncheck();
      assert.equal(await page.getByRole('button',{name:'Model C is the default for new chats'}).getAttribute('aria-pressed'),'true');
      await page.getByRole('checkbox',{name:'Favorite Model B'}).check();
      await page.getByPlaceholder('search all models').fill('Model B');
      assert.equal(await page.getByText('Nothing matches.',{exact:true}).count(),0);
      const bounds = await page.getByRole('checkbox',{name:'Favorite Model B'}).boundingBox();
      assert.ok(bounds.x + bounds.width <= width);
      if (process.env.HELM_TEST_SCREENSHOT_DIR) await page.screenshot({path:process.env.HELM_TEST_SCREENSHOT_DIR+'/models-'+width+'.png'});
      await page.getByPlaceholder('search all models').fill('');
      await page.evaluate(()=>{window.failSave = true});
      await page.getByRole('button',{name:'Use Model B by default for new chats'}).click();
      await page.getByRole('alert').waitFor();
      assert.equal(await page.getByRole('button',{name:'Model C is the default for new chats'}).getAttribute('aria-pressed'),'true');
      await page.locator('button[title^="speed:"]').click();
      await page.evaluate(()=>{window.failSave = false});
      await page.getByRole('button',{name:'Use Normal by default for new chats'}).click();
      assert.deepEqual(await page.evaluate(()=>window.saved),{kind:'speed',id:''});
      assert.equal(await page.locator('.modesheet').count(),1);
      await page.getByRole('option',{name:'Normal Standard speed',exact:true}).click();
      await page.locator('.modesheet').waitFor({state:'detached'});
      await page.locator('button[title^="model:"]').click();
      await page.getByRole('option',{name:'Model B',exact:true}).click();
      await page.locator('.modesheet').waitFor({state:'detached'});
      assert.equal(await page.evaluate(()=>window.picks ?? 0),1);
      assert.equal(await page.locator('button[title="thinking: low"]').count(),1);
      await page.locator('button[title^="thinking:"]').click();
      assert.equal(await page.getByRole('option',{name:'high',exact:true}).count(),0);
      await page.locator('button[title^="model:"]').click();
      await page.getByRole('option',{name:'Model A',exact:true}).click();
      await page.locator('button[title^="thinking:"]').click();
      assert.equal(await page.getByRole('option',{name:'high',exact:true}).count(),1);
      await page.locator('button[title^="model:"]').click();
      await page.getByRole('button',{name:/1 more/}).click();
      await page.getByRole('option',{name:'Model C',exact:true}).click();
      assert.equal(await page.locator('button[title^="thinking:"]').count(),0);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('settings saves use the hub when a direct channel stops answering, with direct-only fallback', async () => {
  const bundle = await build({stdin:{contents:`
    import { Client } from './apps/web/src/client';
    window.testRoute = async (method, relayOpen) => {
      const client = Object.create(Client.prototype);
      const calls = [];
      client.seq = 0;
      client.pending = new Map();
      const reply = (route, frame) => {
        calls.push(route);
        const msg = JSON.parse(frame);
        client.pending.get(msg.id).resolve({ok:true});
        client.pending.delete(msg.id);
      };
      client.ws = { readyState:relayOpen ? WebSocket.OPEN : WebSocket.CLOSED,send:frame=>reply('hub',frame) };
      client.peers = new Map([['machine',{ready:true,channel:{readyState:'open',bufferedAmount:0,send:frame=>{
        if (relayOpen && ['profile.defaults','model.prefs','picker.prefs'].includes(method)) {
          calls.push('stale-direct');
          throw new Error('stale channel');
        }
        reply('direct',frame);
      }}}]]);
      await client.rpc('machine',method,{},1000);
      return calls;
    };
  `,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'iife'});
  const browser = await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM ? {executablePath:process.env.HELM_TEST_CHROMIUM} : {})});
  try {
    const page = await browser.newPage();
    await page.setContent('<div></div>');
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    for (const method of ['profile.defaults','model.prefs','picker.prefs']) {
      assert.deepEqual(await page.evaluate(method=>window.testRoute(method,true),method),['hub']);
      assert.deepEqual(await page.evaluate(method=>window.testRoute(method,false),method),['direct']);
    }
    assert.deepEqual(await page.evaluate(()=>window.testRoute('session.messages',true)),['direct']);
  } finally {await browser.close();}
});

test('devin shows each model once; its thinking and speed chips pick the matching variant', async () => {
  const bundle = await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { Controls } from './apps/web/src/session/Controls';
    const ids = ['claude-opus-5-5-medium','claude-opus-5-5-low','claude-opus-5-5-high','claude-opus-5-5-high-fast',
      'claude-opus-5-5-low-fast','claude-opus-4-8-medium','claude-opus-4-8-high','swe-2-high','swe-2-medium',
      'fusion-claude-opus-5-5-high-sidekick-swe-2-medium','fusion-claude-opus-5-5-high-sidekick-swe-2-high'];
    const labels = {'claude-opus-5-5-medium':'Claude Opus 5.5 Medium','claude-opus-4-8-medium':'Claude Opus 4.8 Medium',
      'swe-2-high':'SWE-2 High','fusion-claude-opus-5-5-high-sidekick-swe-2-medium':'Fusion (Claude Opus 5.5 High + SWE-2 Medium)'};
    function Picker() {
      const [model, setModel] = useState('claude-opus-5-5-high-fast');
      const controls = Controls({ options:{ models:ids, labels, prefs:{default:'swe-2-high', approved:[]}, favs:['claude-opus-5-5-high'] },
        session:{ engine:'devin', model }, onFavs:()=>{},
        onPick:(kind,id)=>{ window.picked = [kind,id]; setModel(id); } });
      return <>{controls.chips}{controls.sheet}</>;
    }
    createRoot(document.getElementById('root')).render(<Picker />);
  `, resolveDir:process.cwd(), loader:'tsx' }, bundle:true,write:false,format:'iife',jsx:'automatic' });
  const browser = await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM ? {executablePath:process.env.HELM_TEST_CHROMIUM} : {})});
  try {
    const page = await browser.newPage({ viewport:{width:390,height:844} });
    await page.setContent('<div class="session"><div id="root"></div></div>');
    await page.addStyleTag({content:(await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'')});
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    await page.locator('button[title="model: Claude Opus 5.5"]').click();
    // A favorite saved as one variant stars the whole model.
    assert.deepEqual(await page.getByRole('option').allTextContents(), ['Claude Opus 5.5', 'SWE-2']);
    await page.getByRole('button',{name:/2 more/}).click();
    assert.deepEqual(await page.locator('.modesheet-label').allTextContents(), ['favorites', 'all', 'older', 'fusion pairs']);
    await page.getByRole('option',{name:'Claude Opus 4.8',exact:true}).click();
    // No fast variant there: the level carries over, the speed cannot.
    assert.deepEqual(await page.evaluate(()=>window.picked), ['model','claude-opus-4-8-high']);
    await page.locator('button[title="model: Claude Opus 4.8"]').click();
    await page.getByRole('option',{name:'Claude Opus 5.5',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.picked), ['model','claude-opus-5-5-high']);
    await page.locator('button[title="speed: normal"]').click();
    await page.getByRole('option',{name:/^Fast/}).click();
    assert.deepEqual(await page.evaluate(()=>window.picked), ['model','claude-opus-5-5-high-fast']);
    await page.locator('button[title="thinking: high"]').click();
    assert.deepEqual(await page.getByRole('option').allTextContents(), ['low', 'high']);
    await page.getByRole('option',{name:'low',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.picked), ['model','claude-opus-5-5-low-fast']);
  } finally { await browser.close(); }
});

test('Claude with bare ids: the newest four, recent first, an old default waits behind more', async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { Controls } from './apps/web/src/session/Controls';
    function Picker() {
      const controls = Controls({ options:{ models:['claude-haiku-5-5','claude-sonnet-5-5','claude-opus-5-5','claude-fable-5-1','claude-opus-5','claude-sonnet-5'],
        default:'claude-sonnet-5', prefs:{default:'claude-sonnet-5', approved:[]}, recent:['claude-fable-5-1','claude-opus-4-8'], favs:[] },
        session:{ engine:'claude', model:'claude-opus-5-5' }, onFavs:()=>{}, onPick:()=>{}, onDefault:()=>{} });
      return <>{controls.chips}{controls.sheet}</>;
    }
    createRoot(document.getElementById('root')).render(<Picker />);
  `, resolveDir:process.cwd(), loader:'tsx' }, bundle:true,write:false,format:'iife',jsx:'automatic' });
  const browser = await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM ? {executablePath:process.env.HELM_TEST_CHROMIUM} : {})});
  try {
    const page = await browser.newPage({ viewport:{width:390,height:844} });
    await page.setContent('<div class="session"><div id="root"></div></div>');
    await page.addStyleTag({content:(await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'')});
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    await page.locator('button[title="model: Opus 5.5"]').click();
    assert.deepEqual(await page.getByRole('option').allTextContents(), ['Fable 5.1', 'Haiku 5.5', 'Sonnet 5.5', 'Opus 5.5']);
    assert.deepEqual(await page.locator('.modesheet-label').allTextContents(), ['recent', 'latest']);
    assert.equal(await page.locator('.moderow.more').innerText(), '2 more\n›');
  } finally { await browser.close(); }
});

test('Esc closes the picker wherever focus is', async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { Controls } from './apps/web/src/session/Controls';
    function Picker() {
      const controls = Controls({ options:{ models:['claude-opus-5-5','claude-sonnet-5-5'], favs:[] },
        session:{ engine:'claude', model:'claude-opus-5-5' }, onFavs:()=>{}, onPick:()=>{} });
      return <><textarea aria-label="message" />{controls.chips}{controls.sheet}</>;
    }
    createRoot(document.getElementById('root')).render(<Picker />);
  `, resolveDir:process.cwd(), loader:'tsx' }, bundle:true,write:false,format:'iife',jsx:'automatic' });
  const browser = await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM ? {executablePath:process.env.HELM_TEST_CHROMIUM} : {})});
  try {
    const page = await browser.newPage({ viewport:{width:390,height:844}, hasTouch:true, isMobile:true });
    await page.setContent('<div class="session"><div id="root"></div></div>');
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    await page.locator('button[title^="model:"]').click();
    await page.locator('.modesheet').waitFor();
    // Focus left in the message box, as after tapping a chip on a phone.
    await page.getByLabel('message').focus();
    await page.keyboard.press('Escape');
    await page.locator('.modesheet').waitFor({ state:'detached' });
  } finally { await browser.close(); }
});
