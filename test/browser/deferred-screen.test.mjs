import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

test('optional screens load on demand, keep Back on failure, and offer a full reload', async t => {
  const bundle=await build({stdin:{contents:`
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {deferredScreen} from './apps/web/src/deferredScreen';
    window.loads=0;
    const Optional=deferredScreen('Optional screen',()=>{
      window.loads++;return new Promise((resolve,reject)=>{
        window.fail=()=>reject(new Error('Failed to fetch dynamically imported module'));
        window.finish=()=>resolve({default:({onBack})=><div><h2>Screen ready</h2><button onClick={onBack}>Back</button></div>});
      });
    });
    function App(){const [open,setOpen]=useState(false);return <>
      <input aria-label="Saved draft" defaultValue="keep my words" />
      {open?<Optional onBack={()=>setOpen(false)}/>:<button onClick={()=>setOpen(true)}>Open screen</button>}
    </>}
    createRoot(document.getElementById('root')).render(<App/>);
  `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic'});
  const browser=await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM?{executablePath:process.env.HELM_TEST_CHROMIUM}:{})});
  t.after(()=>browser.close());
  const page=await browser.newPage();page.setDefaultTimeout(5000);
  await page.route('http://helm.test/**',r=>r.fulfill({contentType:'text/html',body:'<div id="root"></div><script>'+bundle.outputFiles[0].text+'</script>'}));
  await page.goto('http://helm.test/');
  await page.getByRole('button',{name:'Open screen'}).waitFor();
  assert.equal(await page.evaluate(()=>window.loads),0);
  await page.getByRole('button',{name:'Open screen'}).click();
  await page.getByRole('status').waitFor();
  assert.equal(await page.evaluate(()=>window.loads),1);
  await page.getByRole('button',{name:'Back',exact:true}).click();
  assert.equal(await page.getByRole('textbox').inputValue(),'keep my words');
  await page.getByRole('button',{name:'Open screen'}).click();
  assert.equal(await page.evaluate(()=>window.loads),1,'opening again reuses a pending load');
  await page.evaluate(()=>window.fail());
  await page.getByRole('alert').waitFor();
  await page.getByRole('button',{name:'Back',exact:true}).click();
  await page.getByRole('button',{name:'Open screen'}).click();
  await page.getByRole('button',{name:'Reload Helm',exact:true}).click();
  await page.waitForURL('**/?helm-refresh=1');
  await page.getByRole('button',{name:'Open screen'}).click();
  await page.getByRole('status').waitFor();
  assert.equal(await page.evaluate(()=>window.loads),1);
  await page.evaluate(()=>window.finish());
  await page.getByRole('heading',{name:'Screen ready'}).waitFor();
  assert.equal(await page.getByRole('textbox').inputValue(),'keep my words');
  await page.getByRole('button',{name:'Back',exact:true}).click();
  await page.getByRole('button',{name:'Open screen'}).click();
  await page.getByRole('heading',{name:'Screen ready'}).waitFor();
  assert.equal(await page.evaluate(()=>window.loads),1,'opening a loaded screen needs no new load');
});
