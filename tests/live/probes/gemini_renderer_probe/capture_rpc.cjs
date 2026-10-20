#!/usr/bin/env node
// Read-only RPC capture through the repository's installed Playwright CDP client.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {chromium}=require(path.join(process.argv[2],'node_modules/@playwright/test'));
const out=process.argv[3], target=process.argv[4];
(async()=>{
  const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page=browser.contexts().flatMap(x=>x.pages()).find(x=>x.url().startsWith('https://gemini.google.com/app'));
  if(!page)throw Error('Gemini tab missing');
  const seen=[];
  page.on('response',async r=>{
    const u=r.url();
    if(!/gemini\.google\.com\/.*batchexecute/.test(u))return;
    try{
      const body=await r.body(), text=body.toString('utf8');
      const hash=crypto.createHash('sha256').update(body).digest('hex');
      const hit=target && text.includes(target);
      seen.push({url:u,status:r.status(),sha256:hash,bytes:body.length,markerFound:!!hit});
      if(hit){fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,`rpc-${hash}.txt`),body);}
    }catch(e){seen.push({url:u,error:String(e)});}
  });
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForTimeout(12000);
  fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'rpc-responses.json'),JSON.stringify(seen,null,2));
  console.log(JSON.stringify({url:page.url(),responses:seen.length,matches:seen.filter(x=>x.markerFound).length}));
  await browser.close();
})().catch(e=>{console.error(e);process.exitCode=1});
