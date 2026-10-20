#!/usr/bin/env node
// One-shot read-only CDP breakpoint at the known structured document renderer.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {chromium}=require(path.join(process.argv[2],'node_modules/@playwright/test'));
const output=process.argv[3];
const marker=process.argv[4]||'W^{(1)}_{RB}';
const targetUrl=process.argv[5]||null;
const mode=process.argv[6]||'math';
(async()=>{
  const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
  const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('https://gemini.google.com/app'));
  if(!page)throw Error('No Gemini tab');
  const cdp=await page.context().newCDPSession(page);
  const scriptUrls=new Map();
  cdp.on('Debugger.scriptParsed',e=>scriptUrls.set(e.scriptId,e.url));
  await cdp.send('Debugger.enable');
  const bp=await cdp.send('Debugger.setBreakpointByUrl',{
    urlRegex:'boq-gemini-web-uiserver.*BardChatUi',
    lineNumber:mode==='table'?3645:3644,columnNumber:mode==='table'?293:382,
    condition:mode==='table'
      ? `a && JSON.stringify(a).includes(${JSON.stringify(marker)})`
      : `a && a.FTa && String(a.FTa).includes(${JSON.stringify(marker)})`
  });
  const hit=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('renderer breakpoint not reached')),45000);
    cdp.on('Debugger.paused',async event=>{
      try{
        clearTimeout(timer);
        const frames=[];
        for(const frame of event.callFrames){
          let local=null;
          let detail=null;
          try{
            const r=await cdp.send('Debugger.evaluateOnCallFrame',{
              callFrameId:frame.callFrameId,
              expression:'JSON.stringify({aType:typeof a,aKeys:typeof a==="object"&&a?Object.keys(a).slice(0,20):[],aMath:typeof a==="object"&&a?a.FTa:null,bType:typeof b})',
              returnByValue:true,silent:true
            });
            local=r.result.value||null;
          }catch{}
          if(frame.functionName==='transform' || frame.functionName==='render'){
            try{
              const r=await cdp.send('Debugger.evaluateOnCallFrame',{
                callFrameId:frame.callFrameId,
                expression:'JSON.stringify({keys:Object.keys(a||{}),structuredType:typeof a?.structuredContent,structuredKeys:a?.structuredContent&&typeof a.structuredContent==="object"?Object.keys(a.structuredContent).slice(0,30):[],structuredPreview:JSON.stringify(a?.structuredContent)?.slice(0,5000),rootPreview:JSON.stringify(a)?.slice(0,5000)})',
                returnByValue:true,silent:true
              });
              detail=r.result.value||null;
            }catch{}
          }
          if(frame.functionName==='transform'){
            try{
              const r=await cdp.send('Debugger.evaluateOnCallFrame',{
                callFrameId:frame.callFrameId,expression:'JSON.stringify(a.structuredContent)',
                returnByValue:true,silent:true
              });
              if(typeof r.result.value==='string')
                fs.writeFileSync(output.replace(/\.json$/,'-structured.json'),r.result.value);
            }catch{}
          }
          frames.push({functionName:frame.functionName,url:frame.url,location:frame.location,local,detail});
        }
        fs.mkdirSync(path.dirname(output),{recursive:true});
        const scriptEvidence=[];
        for(const [index,frame] of event.callFrames.entries()){
          if(index>15)break;
          if(frame.functionName!=='render' && frame.functionName!=='transform')continue;
          if(scriptEvidence.some(x=>x.scriptId===frame.location.scriptId))continue;
          const source=(await cdp.send('Debugger.getScriptSource',{scriptId:frame.location.scriptId})).scriptSource;
          const sha256=crypto.createHash('sha256').update(source).digest('hex');
          const file=path.join(path.dirname(output),`chunk-${sha256}.js`);
          fs.writeFileSync(file,source);
          scriptEvidence.push({frame:index,scriptId:frame.location.scriptId,url:scriptUrls.get(frame.location.scriptId)||null,
            lineNumber:frame.location.lineNumber+1,columnNumber:frame.location.columnNumber,sha256,bytes:Buffer.byteLength(source)});
        }
        fs.writeFileSync(output.replace(/\.json$/,'-scripts.json'),JSON.stringify(scriptEvidence,null,2));
        fs.writeFileSync(output,JSON.stringify({pageUrl:page.url(),breakpoint:bp,frames},null,2));
        resolve({frames:frames.length,top:frames.slice(0,8).map(x=>x.functionName)});
      }catch(error){reject(error)}finally{await cdp.send('Debugger.resume').catch(()=>{});}
    });
  });
  const reload=(targetUrl?page.goto(targetUrl,{waitUntil:'domcontentloaded'}):page.reload({waitUntil:'domcontentloaded'})).catch(()=>{});
  console.log(JSON.stringify(await hit));
  await reload;
  await cdp.send('Debugger.removeBreakpoint',{breakpointId:bp.breakpointId});
  await cdp.detach();
  await browser.close();
})().catch(e=>{console.error(e);process.exitCode=1});
