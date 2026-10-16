import {chromium} from 'playwright';
import {scanGgcb} from '../../src/adapters/ggcb.ts';
import {ProviderSession} from '../../src/browser.ts';
import {initialPolicy,resources} from '../../src/domain.ts';
const browser=await chromium.launch({channel:'msedge',headless:true,chromiumSandbox:true,timeout:30000});
try{
 const page=await browser.newPage({locale:'en-GB',timezoneId:'Europe/London'});
 const network:Array<Record<string,unknown>>=[];
 page.on('request',request=>{const url=new URL(request.url());if(url.hostname==='ggcb.co.uk' && ['xhr','fetch'].includes(request.resourceType())){const data=new URLSearchParams(request.postData()||url.search);const form=new URLSearchParams(data.get('form')||'');network.push({method:request.method(),path:url.pathname,action:data.get('action')||url.searchParams.get('wc-ajax'),keys:Array.from(data.keys()),dates:Object.fromEntries(Array.from(form.entries()).filter(([key])=>/^wc_bookings_field_start_date_(?:year|month|day)$/.test(key)))});}});
 await page.goto(resources[0].url,{waitUntil:'domcontentloaded',timeout:35000});
 const result=await scanGgcb(page,resources[0],initialPolicy(),new ProviderSession('ggcb','.local/test-unused'));
 console.log(JSON.stringify({summary:result.summary,navigation:result.navigation,openDates:result.coverage.filter(day=>day.status!=='OUTSIDE_RELEASE_WINDOW'),observations:result.observations,network}));
}finally{await browser.close();}
