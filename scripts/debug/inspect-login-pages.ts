import { chromium } from 'playwright';
import { loginUrls,providerIds } from '../../src/domain.ts';
const browser=await chromium.launch({channel:'msedge',headless:true,chromiumSandbox:true,timeout:30000});
try {
  await Promise.all(providerIds.map(async provider=>{
    const context=await browser.newContext();const page=await context.newPage();
    try {
      await page.goto(loginUrls[provider],{waitUntil:'domcontentloaded',timeout:35000});
      await page.waitForTimeout(1000);
      const frames=[];
      for(const frame of page.frames())frames.push(await frame.evaluate(()=>({
        headings:Array.from(document.querySelectorAll('h1,h2,h3')).map(el=>(el as HTMLElement).innerText.trim()).filter(Boolean).slice(0,12),
        inputs:Array.from(document.querySelectorAll('input:not([type=hidden])')).filter(el=>el.getClientRects().length).map(el=>({id:el.id,name:el.getAttribute('name'),type:el.getAttribute('type'),autocomplete:el.getAttribute('autocomplete')})),
        buttons:Array.from(document.querySelectorAll('button,input[type=submit]')).filter(el=>el.getClientRects().length).map(el=>({text:(el as HTMLElement).innerText||el.getAttribute('value'),id:el.id,name:el.getAttribute('name')})),
        links:Array.from(document.querySelectorAll<HTMLAnchorElement>('a')).filter(el=>/log\s*in|sign\s*in/i.test(el.innerText)).slice(0,8).map(el=>({label:el.innerText,host:new URL(el.href).hostname,path:new URL(el.href).pathname}))
      })).catch(()=>({unavailable:true})));
      console.log(JSON.stringify({provider,path:new URL(page.url()).pathname,frames}));
    }catch {console.log(JSON.stringify({provider,error:'Page inspection failed'}));}finally{await context.close();}
  }));
}finally{await browser.close();}
