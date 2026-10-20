import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {navigateGgcbMonth,isGgcbDayResponse,quoteGgcb} from '../../src/adapters/ggcb-calendar.ts';
import {resources} from '../../src/domain.ts';
const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true,timeout:30000});
try{
 const page=await browser.newPage({locale:'en-GB',timezoneId:'Europe/London'});await page.goto(resources[0].url,{waitUntil:'domcontentloaded',timeout:35000});
 await navigateGgcbMonth(page,'2026-10',()=>{});
 const date='2026-10-29';const response=page.waitForResponse(response=>isGgcbDayResponse(response,date),{timeout:12000});
 await page.locator('td.date-year-2026.date-month-9.date-date-29 a').click();await (await response).finished();
 await page.waitForFunction(()=>!!document.querySelector('.block-picker a[data-value]'));
 const slot=await page.locator('.block-picker a[data-value]').first().evaluate(el=>({time:(el as HTMLElement).innerText,value:el.getAttribute('data-value')!}));
 const price=await quoteGgcb(page,slot.value);
 console.log(JSON.stringify({date,time:slot.time.trim(),price,note:'Readonly quote sample only; outside target time is not added to monitoring results',selected:await page.locator('.block-picker a.selected').count()}));
 assert.ok(price,'The official cost endpoint must return a readable GBP quote');assert.equal(await page.locator('.block-picker a.selected').count(),0);
}finally{await browser.close();}
