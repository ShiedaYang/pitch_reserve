import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {mkdirSync,writeFileSync} from 'node:fs';
const browser=await chromium.launch({channel:'msedge',headless:true,chromiumSandbox:true,timeout:30000});
try {
  const page=await browser.newPage({locale:'en-GB',timezoneId:'Europe/London'});
  const http:Array<{status?:number;path:string;action:string}>=[];const errors:string[]=[];
  const requests:Array<Record<string,unknown>>=[];
  page.on('request',request=>{const url=new URL(request.url());if(url.hostname==='ggcb.co.uk' && /wc-ajax|admin-ajax/.test(url.href)){const data=new URLSearchParams(request.postData()||url.search);requests.push({path:url.pathname,action:url.searchParams.get('wc-ajax'),keys:Array.from(data.keys()),dates:Object.fromEntries(Array.from(data.entries()).filter(([key])=>/^(?:min_date|max_date|product_id|year|month|day|date|timezone_offset)$/.test(key)))});}});
  page.on('response',response=>{const url=new URL(response.url());if(url.hostname==='ggcb.co.uk' && /wc-ajax|admin-ajax/.test(url.href))http.push({status:response.status(),path:url.pathname,action:(url.searchParams.get('wc-ajax')||'').replace(/[^a-z_]/gi,'')});});
  page.on('pageerror',error=>errors.push(error.message.replace(/https?:\/\/\S+/g,'[script]').slice(0,250)));
  await page.goto('https://ggcb.co.uk/booking/6-a-side-3g-half-pitch/',{waitUntil:'domcontentloaded',timeout:35000});
  const form=page.locator('#wc-bookings-booking-form');await form.waitFor();
  mkdirSync('.local/artifacts',{recursive:true});
  for(const src of await page.locator('script[src]').evaluateAll(elements=>elements.map(el=>(el as HTMLScriptElement).src).filter(src=>new URL(src).hostname==='ggcb.co.uk' && /booking/i.test(src)))) {
    const response=await page.request.get(src);const text=await response.text();
    writeFileSync(`.local/artifacts/ggcb-${new URL(src).pathname.split('/').at(-1)}`,text);
    console.log(JSON.stringify({script:new URL(src).pathname}));
  }
  const ready=()=>page.waitForFunction(()=>!Array.from(document.querySelectorAll('#wc-bookings-booking-form .blockUI')).some(el=>el.getBoundingClientRect().height>0 && getComputedStyle(el).display!=='none'),undefined,{timeout:10000});
  try {await ready();}catch {
    console.log(JSON.stringify({stage:'initial-overlay',http,errors,scripts:await page.locator('script[src]').evaluateAll(elements=>elements.map(el=>new URL((el as HTMLScriptElement).src)).filter(url=>url.hostname==='ggcb.co.uk' && /booking/i.test(url.pathname)).map(url=>url.pathname))}));
    throw new Error('GGCB initial calendar overlay did not clear within 10 seconds');
  }
  const titles:string[]=[];
  for(let month=0;month<3;month++) {
    titles.push((await form.locator('.ui-datepicker-title').innerText()).replace(/\s+/g,' '));
    if(month===2)break;
    await form.getByRole('button',{name:'Next Month'}).click();
    try {await ready();}catch {console.log(JSON.stringify({titles,http,requests,errors,stage:'month-overlay',title:await form.locator('.ui-datepicker-title').innerText()}));throw new Error('GGCB next-month overlay did not clear within 10 seconds');}
  }
  console.log(JSON.stringify({titles,http}));assert.equal(new Set(titles).size,3,'Next Month must display three distinct months');
} finally {await browser.close();}
