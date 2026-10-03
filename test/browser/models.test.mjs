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
    await page.getByRole('option', { name: 'Claude Opus 5.5', exact: true }).click();
    assert.equal(await page.evaluate(() => window.picked), 'claude-opus-5-5');
    await page.evaluate(() => window.completeCatalog());
    await page.locator('button[title^="model:"]').click();
    await page.getByRole('option', { name: 'Claude Sonnet 5.5', exact: true }).click();
    assert.equal(await page.evaluate(() => window.picked), 'claude-sonnet-5-5');
  } finally { await browser.close(); }
});

test('stars save defaults directly; checkboxes keep favorites independent on desktop and phone', async () => {
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
        defaults:{effort:'xhigh', mode:'ask',speed:'fast'}, favs:['a'], effortFavs:[] });
      const controls = Controls({ options, session,
        onPick:(kind,id)=>{ window.picks = (window.picks ?? 0)+1; setSession(s=>({...s,[kind]:id})); },
        onFavs:favs=>setOptions(o=>({...o,favs})),
        onEffortFavs:(model,levels)=>setOptions(o=>({...o,effortFavs:levels.map(level=>JSON.stringify([model,level]))})),
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
      await page.getByRole('checkbox',{name:'Favorite high',exact:true}).check();
      assert.equal(await page.locator('.modesheet').count(),1);
      assert.equal(await page.getByRole('checkbox',{name:'Favorite low',exact:true}).isChecked(),false);
      assert.equal(await page.getByRole('button',{name:'low is the default for new chats'}).getAttribute('aria-pressed'),'true');
      assert.equal(await page.getByRole('option',{name:'high',exact:true}).getAttribute('aria-selected'),'true');
      assert.equal(await page.evaluate(()=>window.picks ?? 0),0);
      if (process.env.HELM_TEST_SCREENSHOT_DIR) await page.screenshot({path:process.env.HELM_TEST_SCREENSHOT_DIR+'/thinking-'+width+'.png'});
      await page.locator('button[title^="model:"]').click();
      await page.getByRole('checkbox',{name:'Favorite Model B'}).check();
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
      assert.equal(await page.getByText('no matches',{exact:true}).count(),0);
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
      await page.getByRole('option',{name:'Normal the usual tier',exact:true}).click();
      await page.locator('.modesheet').waitFor({state:'detached'});
      await page.locator('button[title^="model:"]').click();
      await page.getByRole('option',{name:'Model B',exact:true}).click();
      await page.locator('.modesheet').waitFor({state:'detached'});
      assert.equal(await page.evaluate(()=>window.picks ?? 0),1);
      assert.equal(await page.locator('button[title="thinking: low"]').count(),1);
      await page.locator('button[title^="thinking:"]').click();
      assert.equal(await page.getByRole('checkbox',{name:'Favorite low',exact:true}).isChecked(),false);
      assert.equal(await page.getByRole('option',{name:'high',exact:true}).count(),0);
      await page.locator('button[title^="model:"]').click();
      await page.getByRole('option',{name:'Model A',exact:true}).click();
      await page.locator('button[title^="thinking:"]').click();
      assert.equal(await page.getByRole('checkbox',{name:'Favorite high',exact:true}).isChecked(),true);
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
