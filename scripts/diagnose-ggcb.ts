import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const browser = await chromium.launch({channel:'msedge',headless:true,chromiumSandbox:true,timeout:30000});
try {
 const page = await browser.newPage({viewport:{width:1280,height:1000},locale:'en-GB',timezoneId:'Europe/London'});
 await page.goto('https://ggcb.co.uk/booking/6-a-side-3g-half-pitch/',{waitUntil:'domcontentloaded',timeout:35000}).catch(e=>console.log(e.message.split('\n')[0]));
 await page.locator('#wc-bookings-booking-form').waitFor();
 console.log(JSON.stringify(await page.evaluate(()=>({
  dates:Array.from(document.querySelectorAll('td[class*="date-date-19"]')).map(el=>({html:el.outerHTML,visible:(el as HTMLElement).offsetParent!==null})),
  next:Array.from(document.querySelectorAll('[aria-label="Next Month"],[title="Next"]')).map(el=>el.outerHTML),
  overlays:Array.from(document.querySelectorAll('.blockUI')).map(el=>({text:el.textContent,style:el.getAttribute('style')}))
 })),null,2));
 const link=page.locator('td.date-year-2026.date-month-9.date-date-19 a');
 try {await link.click({timeout:5000}); console.log('clicked date19');}catch(e){console.log((e as Error).message.slice(0,3500));}
 mkdirSync('.local/artifacts',{recursive:true});await page.screenshot({path:'.local/artifacts/ggcb-diagnostic.png',fullPage:true});
 console.log((await page.locator('#wc-bookings-booking-form').innerText()).slice(-2500));
} finally {await browser.close();}
