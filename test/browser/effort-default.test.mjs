import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

test('thinking picker omits the CLI default sentinel from rows, favorites and keyboard cycling', async () => {
  const bundle = await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { Controls } from './apps/web/src/session/Controls';
    function Picker() {
      const [session, setSession] = useState({engine:'claude',model:'opus',effort:'max'});
      const [options, setOptions] = useState({models:['opus'],efforts:['low','high','max','default'],
        effortFavs:[JSON.stringify(['opus','default'])],defaults:{effort:'max'}});
      window.reportDefault = () => {
        setSession({engine:'claude',model:'opus',engineEffort:'default'});
        setOptions({models:['opus'],efforts:['default'],effortsByModel:{opus:['high','max','default']},
          effortFavs:[JSON.stringify(['opus','default'])],defaults:{effort:'max'}});
      };
      const controls = Controls({options,session,
        onPick:(kind,id)=>{ window.picked=id; setSession(s=>({...s,[kind]:id})); },
        onDefault:(kind,id)=>{ window.saved={kind,id}; } });
      window.stepThinking = () => controls.step('effort');
      return <>{controls.chips}{controls.sheet}</>;
    }
    createRoot(document.getElementById('root')).render(<Picker />);
  `, resolveDir:process.cwd(), loader:'tsx' }, bundle:true,write:false,format:'iife',jsx:'automatic' });
  const browser = await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM ? {executablePath:process.env.HELM_TEST_CHROMIUM} : {})});
  try {
    for (const width of [1280,390]) {
      const page = await browser.newPage({viewport:{width,height:850}});
      await page.setContent('<div class="session"><div id="root"></div></div>');
      await page.addStyleTag({content:(await readFile('apps/web/src/styles.css','utf8')).replace(/^@import[^;]+;/gm,'')});
      await page.addScriptTag({content:bundle.outputFiles[0].text});
      await page.locator('button[title^="thinking:"]').click();
      assert.deepEqual(await page.getByRole('option').allTextContents(),['low','high','max']);
      assert.equal(await page.getByRole('option',{name:'max',exact:true}).getAttribute('aria-selected'),'true');
      assert.equal(await page.getByRole('checkbox',{name:'Favorite default',exact:true}).count(),0);
      assert.equal(await page.getByRole('button',{name:'Use default by default for new chats',exact:true}).count(),0);
      if (process.env.HELM_TEST_SCREENSHOT_DIR) await page.screenshot({path:process.env.HELM_TEST_SCREENSHOT_DIR+'/no-default-'+width+'.png'});
      await page.evaluate(()=>window.stepThinking());
      assert.equal(await page.evaluate(()=>window.picked),'low');
      // Per-model catalogs and a provider-reported reset sentinel must not reinsert it.
      await page.evaluate(()=>window.reportDefault());
      await page.locator('button[title^="thinking:"]').click();
      assert.deepEqual(await page.getByRole('option').allTextContents(),['high','max']);
      await page.getByRole('button',{name:'Use high by default for new chats',exact:true}).click();
      assert.deepEqual(await page.evaluate(()=>window.saved),{kind:'effort',id:'high'});
      await page.evaluate(()=>window.stepThinking());
      assert.equal(await page.evaluate(()=>window.picked),'high');
      await page.close();
    }
  } finally { await browser.close(); }
});

