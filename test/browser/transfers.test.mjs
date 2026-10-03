import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

test('Send Project shows origin before sending and in the receipt, including setup failures', async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { TransferView } from './apps/web/src/Transfer';
    const root = createRoot(document.getElementById('root'));
    const remote = 'git@github.com:owner/project.git';
    const preflight = {files:1,bytes:10,envFiles:[],skipped:0,skippedEntries:[],warnings:[],requiresAcknowledgement:false};
    const source = {id:'source',name:'Laptop',online:true,info:{}};
    const target = {id:'target',name:'VM',online:true,info:{}};
    const client = {
      transferPreview:async()=>({rootName:'project',git:{remote},preflight}),
      transferInvite:async()=>({grant:'test'}),
      transferSend:async(_env,params)=>{
        window.sent = params;
        return {sent:true,targetMachineId:'target',targetName:'VM',preflight,receipt:{
          folder:'/project',files:1,bytes:10,readiness:{status:'unverified',checks:[]},
          repository:{remote,configured:window.configured,error:'Origin could not be configured; add it on the target before pulling.'}
        }};
      }
    };
    window.show = configured => {
      window.configured = configured;
      root.render(<TransferView key={String(configured)} client={client} source={source} envs={[source,target]}
        folder='/project' onBack={()=>{}} onOpenSession={()=>{}} />);
    };
  `, resolveDir:process.cwd(),loader:'tsx' },bundle:true,write:false,format:'iife',jsx:'automatic'});
  const browser = await chromium.launch({headless:true,...(process.env.HELM_TEST_CHROMIUM ? {executablePath:process.env.HELM_TEST_CHROMIUM} : {})});
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    for (const configured of [true,false]) {
      await page.evaluate(configured=>window.show(configured),configured);
      await page.getByLabel('Git origin',{exact:true}).waitFor();
      assert.equal(await page.getByLabel('Git origin',{exact:true}).inputValue(),'git@github.com:owner/project.git');
      await page.getByRole('button',{name:'Send to VM',exact:true}).click();
      await page.getByText('Arrived on VM',{exact:true}).waitFor();
      assert.equal(await page.getByLabel('Git origin',{exact:true}).inputValue(),'git@github.com:owner/project.git');
      assert.equal((await page.evaluate(()=>window.sent)).folder,'/project');
      await page.getByText(configured
        ? 'Origin is configured. Fetch or pull here using this machine’s GitHub login.'
        : 'Origin could not be configured; add it on the target before pulling.',{exact:true}).waitFor();
    }
  } finally {await browser.close();}
});
