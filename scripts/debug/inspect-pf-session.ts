// Read-only structural probe. Never print field values, cookies or account text.
import {chromium} from 'playwright';
import {existsSync} from 'node:fs';
const browser=await chromium.launch({channel:'msedge',headless:false,chromiumSandbox:true,timeout:30000});
try {
 const file='.local/sessions/playfootball.json';
 const context=await browser.newContext(existsSync(file)?{storageState:file}:{});
 const page=await context.newPage();await page.goto('https://partners.playfootball.net/',{waitUntil:'domcontentloaded'});await page.waitForTimeout(4000);
 for(const frame of page.frames())console.log(JSON.stringify(await frame.evaluate(()=>{
  const visible=(el:Element)=>!!el.getClientRects().length && getComputedStyle(el).visibility!=='hidden';
  return {host:location.hostname,path:location.pathname,forms:document.forms.length,headings:Array.from(document.querySelectorAll('h1,h2,h3,h4')).filter(visible).map(el=>(el.textContent||'').trim()).filter(text=>/log.?in|security verification|BOOK A PITCH/i.test(text)),inputs:Array.from(document.querySelectorAll('input')).map(el=>({id:el.id,name:el.name,type:el.type,attributeType:el.getAttribute('type'),visible:visible(el),form:!!el.form})),buttons:Array.from(document.querySelectorAll('button,input[type=submit]')).filter(visible).map(el=>({login:/^log\s*in$/i.test((el.textContent||el.getAttribute('value')||'').trim()),tag:el.tagName})),passwordLabels:Array.from(document.querySelectorAll('label')).filter(el=>visible(el)&&/password/i.test(el.textContent||'')).map(el=>({for:el.getAttribute('for')}))};
 })));
 console.log(JSON.stringify(await page.evaluate(()=>Array.from(document.querySelectorAll('a,button,[data-toggle],[data-bs-toggle]')).filter(el=>el.getClientRects().length).map(el=>({tag:el.tagName,role:el.getAttribute('role'),text:(el.textContent||'').trim().slice(0,70),label:el.getAttribute('aria-label'),title:el.getAttribute('title'),target:el.getAttribute('data-target')||el.getAttribute('data-bs-target'),href:el.getAttribute('href')})).filter(el=>/login|log.in|sign.in|account/i.test(JSON.stringify(el))))));
}finally{await browser.close();}
