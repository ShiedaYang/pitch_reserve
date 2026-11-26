import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {scanGgcb} from '../src/adapters/ggcb.ts';
import {ggcbReleaseDate,loadGgcbDay} from '../src/adapters/ggcb-calendar.ts';
import {ProviderSession,Interrupted} from '../src/browser.ts';
import {initialPolicy,resources} from '../src/domain.ts';
import {Store} from '../src/store.ts';
import {Monitor} from '../src/monitor.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('GGCB release dates use the London calendar across month/year boundaries',()=>{
  assert.equal(ggcbReleaseDate('2026-11-02'),'2026-10-25');
  assert.equal(ggcbReleaseDate('2026-12-16'),'2026-11-24');
  assert.equal(ggcbReleaseDate('2027-01-04'),'2026-12-25');
});

function fixture(rule:boolean) {return `<p>${rule?'The dates for the following month are only released 7 days prior.':''}</p>
  <form class="cart"><input name="add-to-cart" value="15397" type="hidden"><div id="wc-bookings-booking-form">
  <div class="wc-bookings-date-picker"><span class="ui-datepicker-title">OCTOBER 2026</span><button type="button" aria-label="Next Month" onclick="next()">Next</button><table><tbody></tbody></table><div class="blockOverlay" style="display:none;height:10px"></div></div>
  <input name="wc_bookings_field_start_date_year" value="2026"><input name="wc_bookings_field_start_date_month" value="10"><input name="wc_bookings_field_start_date_day" value="19">
  <div class="times"><fieldset class="time-picker-fieldset"><ul class="block-picker"></ul></fieldset><input name="wc_bookings_field_start_date_time" value=""><div class="blockOverlay" style="display:none;height:10px"></div></div>
  <button type="button" onclick="window.orders++">Book now</button></div></form>
  <script>let month=9;window.orders=0;window.selected=0;window.booking_form_params={ajax_url:'https://ggcb.co.uk/wp-admin/admin-ajax.php'};
  function render(){document.querySelector('.ui-datepicker-title').textContent=month===9?'OCTOBER 2026':'NOVEMBER 2026';document.querySelector('tbody').innerHTML=(month===9?[19,20]:[2,3]).map(day=>'<tr><td class="bookable date-year-2026 date-month-'+month+' date-date-'+day+'"><a href="#" onclick="event.preventDefault();choose('+day+')">'+day+'</a></td></tr>').join('');}
  async function next(){month=10;render();const overlay=document.querySelector('.wc-bookings-date-picker .blockOverlay');overlay.style.display='block';try{await fetch('/?wc-ajax=wc_bookings_find_booked_day_blocks&min_date=2026-11-01&max_date=2026-11-30');overlay.style.display='none';}catch{}}
  async function choose(day){document.querySelector('[name=wc_bookings_field_start_date_month]').value=String(month+1);document.querySelector('[name=wc_bookings_field_start_date_day]').value=String(day);const overlay=document.querySelector('.times .blockOverlay');overlay.style.display='block';const form=new URLSearchParams(new FormData(document.querySelector('form')));const response=await fetch('/wp-admin/admin-ajax.php',{method:'POST',body:new URLSearchParams({action:'wc_bookings_get_blocks',form:form.toString()})});const html=await response.text();await new Promise(resolve=>setTimeout(resolve,80));document.querySelector('.block-picker').innerHTML=html;overlay.style.display='none';}
  render();</script>`;}

test('GGCB recovers a failed month request, correlates day responses and quotes without selecting or ordering',async()=>{
  const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true,timeout:30000});
  try {
    const context=await browser.newContext();let monthRequests=0;let quotes=0;const actions:string[]=[];
    await context.route('**/*',async route=>{
      const request=route.request();const url=new URL(request.url());
      if(url.searchParams.get('wc-ajax')==='wc_bookings_find_booked_day_blocks'){monthRequests++;if(monthRequests===1)return route.abort('failed');await new Promise(resolve=>setTimeout(resolve,600));return route.fulfill({json:{}});}
      if(request.method()==='POST') {
        const data=new URLSearchParams(request.postData()||'');const action=data.get('action')||'';actions.push(action);
        const form=new URLSearchParams(data.get('form')||'');
        if(action==='wc_bookings_get_blocks') {
          const day=form.get('wc_bookings_field_start_date_day');
          return route.fulfill({contentType:'text/html',body:day==='2'?'<li><a data-value="2026-11-02T18:00:00+00:00" href="#" onclick="window.selected++">18:00</a></li>':'<li>No blocks available.</li>'});
        }
        assert.equal(action,'wc_bookings_calculate_costs');quotes++;assert.equal(form.get('wc_bookings_field_start_date_time'),'2026-11-02T18:00:00+00:00');
        return route.fulfill({json:{result:'SUCCESS',html:'Booking cost: <span>£55.00</span>'}});
      }
      return route.fulfill({contentType:'text/html',body:fixture(false)});
    });
    const page=await context.newPage();await page.goto(resources[0].url);
    const session=new ProviderSession('ggcb','.local/test-unused');
    const result=await scanGgcb(page,resources[0],{...initialPolicy(),dateFrom:'2026-11-02',dateTo:'2026-11-03'},session,{today:'2026-10-27',calendarTimeout:400,responseTimeout:1000});
    assert.equal(monthRequests,2);assert.equal(result.status,'OK');assert.equal(quotes,1);assert.equal(result.observations[0].price,'£55.00');assert.equal(result.observations[1].availability,'UNAVAILABLE');
    assert.equal(await page.locator('[name=wc_bookings_field_start_date_time]').inputValue(),'');
    assert.equal(await page.evaluate(()=>{const w=window as unknown as {orders:number;selected:number};return w.orders+w.selected;}),0);
    assert.ok(actions.every(action=>['wc_bookings_get_blocks','wc_bookings_calculate_costs'].includes(action)));
    await context.route('**/*wc-ajax=wc_bookings_find_booked_day_blocks*',route=>route.abort('failed'));
    await page.goto(resources[0].url);
    const failed=await scanGgcb(page,resources[0],{...initialPolicy(),dateFrom:'2026-11-02',dateTo:'2026-11-03'},session,{today:'2026-10-27',calendarTimeout:200,responseTimeout:500});
    assert.equal(failed.status,'ERROR');assert.ok(failed.coverage.every(day=>day.status==='ERROR'));
    assert.match(failed.navigation!,/TIMEOUT|NETWORK_CONNECTION/,'month failures must retain an actionable cause');
  }finally{await browser.close();}
});

test('GGCB does not navigate or query slots in months the official page has not released',async()=>{
  const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true,timeout:30000});
  try {
    const page=await browser.newPage();let queries=0;
    await page.route('**/*',route=>{if(route.request().method()==='POST'||new URL(route.request().url()).searchParams.has('wc-ajax'))queries++;return route.fulfill({contentType:'text/html',body:fixture(true)});});
    await page.goto(resources[0].url);
    const result=await scanGgcb(page,resources[0],{...initialPolicy(),dateFrom:'2026-11-02',dateTo:'2026-12-16'},new ProviderSession('ggcb','.local/test-unused'),{today:'2026-10-16',calendarTimeout:400});
    assert.equal(queries,0);assert.ok(result.coverage.every(day=>day.status==='OUTSIDE_RELEASE_WINDOW'));assert.match(result.coverage[0].note,/2026-10-25/);assert.equal(result.status,'OK');
  }finally{await browser.close();}
});

test('GGCB reports the November log scenario as a complete check with separate unreleased counts',async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-05T13:20:00Z')});
  const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true});
  const store=new Store(':memory:'),monitor=new Monitor(store,'.local/test-unused'),session=monitor.sessions.get('ggcb')!;
  try{
    store.savePolicy({...initialPolicy(),lookahead:null,dateFrom:'2026-11-06',dateTo:'2027-01-06'});
    const page=await browser.newPage();
    const html=fixture(true).replace('let month=9;','let month=10;').replace('(month===9?[19,20]:[2,3])','Array.from({length:30},(_,i)=>i+1)');
    await page.route('**/*',route=>route.request().method()==='POST'?route.fulfill({contentType:'text/html',body:'<li>No blocks available.</li>'}):route.fulfill({contentType:'text/html',body:html}));
    await page.goto(resources[0].url);session.page=async()=>page;
    await monitor.scanResource(session,resources[0]);
    const event=store.eventPage({provider:'ggcb'}).items.find(row=>row.stage==='SCAN_COMPLETE')!;
    assert.deepEqual({level:event.level,status:event.details.status,read:event.details.readDays,unreleased:event.details.unreleasedDays,unknown:event.details.unknownDays,errors:event.details.errorDays},
      {level:'INFO',status:'OK',read:13,unreleased:22,unknown:0,errors:0});
    assert.equal(await page.evaluate(()=>{const w=window as unknown as {orders:number;selected:number};return w.orders+w.selected;}),0);
  }finally{store.close();await browser.close();}
});

test('GGCB rejects a failed month response even when the visible calendar looks normal',async()=>{
  const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true});
  try{
    const page=await browser.newPage();let monthRequests=0,dayRequests=0;
    await page.route('**/*',route=>{
      if(new URL(route.request().url()).searchParams.has('wc-ajax')){monthRequests++;return route.fulfill({status:503,json:{}});}
      if(route.request().method()==='POST'){dayRequests++;return route.fulfill({contentType:'text/html',body:'<li>No blocks available.</li>'});}
      return route.fulfill({contentType:'text/html',body:fixture(false)});
    });
    await page.goto(resources[0].url);
    const diagnostics:import('../src/activity-log.ts').EventContext[]=[];
    const result=await scanGgcb(page,resources[0],{...initialPolicy(),dateFrom:'2026-11-02',dateTo:'2026-11-03'},new ProviderSession('ggcb','.local/test-unused'),{today:'2026-10-27',calendarTimeout:400,responseTimeout:1000,onIssue:(_message,context)=>diagnostics.push(context)});
    assert.equal(result.status,'ERROR');assert.equal(monthRequests,2);assert.equal(dayRequests,0);
    assert.match(result.navigation!,/HTTP 503/);assert.ok(result.coverage.every(day=>day.status==='ERROR'));
    assert.deepEqual(diagnostics.map(row=>({stage:row.stage,code:row.code,status:row.details?.status,attempt:row.details?.attempt})),[
      {stage:'MONTH_LOAD',code:'MONTH_HTTP_ERROR',status:503,attempt:1},{stage:'MONTH_LOAD',code:'MONTH_HTTP_ERROR',status:503,attempt:2}
    ]);
    assert.equal(await page.locator('.ui-datepicker-title').innerText(),'NOVEMBER 2026');
    assert.equal(await page.locator('.wc-bookings-date-picker .blockOverlay').isVisible(),false);
  }finally{await browser.close();}
});

test('GGCB identifies a stuck month overlay separately from an HTTP failure and cleans up listeners',async t=>{
  const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true});
  try{
    const page=await browser.newPage();
    await page.route('**/*',route=>new URL(route.request().url()).searchParams.has('wc-ajax')?route.fulfill({json:{}}):route.fulfill({contentType:'text/html',body:fixture(false).replace("overlay.style.display='none';}catch{}","}catch{}")}));
    await page.goto(resources[0].url);
    const cleanup=t.mock.method(page,'off');
    const result=await scanGgcb(page,resources[0],{...initialPolicy(),dateFrom:'2026-11-02',dateTo:'2026-11-03'},new ProviderSession('ggcb','.local/test-unused'),{today:'2026-10-27',calendarTimeout:150});
    assert.equal(result.status,'ERROR');assert.match(result.navigation!,/TIMEOUT.*遮罩未消失.*HTTP 200/);
    assert.match(result.summary,/2个日期查询失败/);
    assert.deepEqual(cleanup.mock.calls.map(call=>String(call.arguments[0])).filter(name=>name==='response'||name==='requestfailed').sort(),['requestfailed','requestfailed','response','response']);
  }finally{await browser.close();}
});

test('GGCB gives the response its full timeout after a delayed date click instead of spending it on actionability',async()=>{
 const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true});
 try{
  const page=await browser.newPage();let days=0;
  const html=fixture(false).replace('let month=9;','let month=10;');
  await page.route('**/*',async route=>{if(route.request().method()==='POST'){days++;await new Promise(r=>setTimeout(r,50));return route.fulfill({contentType:'text/html',body:'<li>No blocks available.</li>'});}return route.fulfill({contentType:'text/html',body:html});});
  await page.goto(resources[0].url);
  await page.evaluate(()=>{const blocker=document.createElement('div');blocker.style.cssText='position:fixed;inset:0;z-index:99999;background:transparent';document.body.append(blocker);setTimeout(()=>blocker.remove(),700);});
  const result=await scanGgcb(page,resources[0],{...initialPolicy(),dateFrom:'2026-11-02',dateTo:'2026-11-02'},new ProviderSession('ggcb','.local/test-unused'),{today:'2026-10-27',calendarTimeout:1500,responseTimeout:200});
  assert.equal(result.status,'OK');assert.equal(days,1,'waiting for a clickable date must not require a reload or duplicate request');assert.equal(result.coverage[0].status,'READ');
 }finally{await browser.close();}
});

test('GGCB retries a transient failure on the same date and retains its price without selecting or ordering',async()=>{
 const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true});
 try{
  const page=await browser.newPage();const queried:string[]=[];const diagnostics:import('../src/activity-log.ts').EventContext[]=[];
  await page.route('**/*',route=>{
   const data=new URLSearchParams(route.request().postData()||'');const action=data.get('action');
   if(action==='wc_bookings_get_blocks'){const day=new URLSearchParams(data.get('form')||'').get('wc_bookings_field_start_date_day')!;queried.push(day);if(queried.length===1)return route.abort('failed');return route.fulfill({contentType:'text/html',body:day==='2'?'<li><a data-value="2026-11-02T18:00:00+00:00" href="#" onclick="window.selected++">18:00</a></li>':'<li>No blocks available.</li>'});}
   if(action){assert.equal(action,'wc_bookings_calculate_costs');return route.fulfill({json:{result:'SUCCESS',raw_price:55}});}
   return route.fulfill({contentType:'text/html',body:fixture(false).replace('let month=9;','let month=10;')});
  });await page.goto(resources[0].url);
  const result=await scanGgcb(page,resources[0],{...initialPolicy(),dateFrom:'2026-11-02',dateTo:'2026-11-03'},new ProviderSession('ggcb','.local/test-unused'),{today:'2026-10-27',calendarTimeout:800,responseTimeout:200,onIssue:(_message,event)=>diagnostics.push(event)});
  assert.equal(result.status,'OK');assert.deepEqual(queried,['2','2','3']);assert.equal(result.observations[0].price,'£55.00');assert.ok(diagnostics.every(event=>event.level==='WARN'));
  assert.equal(await page.locator('[name=wc_bookings_field_start_date_time]').inputValue(),'');assert.equal(await page.evaluate(()=>{const state=window as unknown as {orders:number;selected:number};return state.orders+state.selected;}),0);
 }finally{await browser.close();}
});

test('GGCB diagnoses a response for the wrong date and never adopts its available time',async()=>{
 const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true});
 try{const page=await browser.newPage();const html=fixture(false).replace('let month=9;','let month=10;').replace('value=String(day);','value=String(day+1);');
  await page.route('**/*',route=>route.request().method()==='POST'?route.fulfill({contentType:'text/html',body:'<li><a data-value="wrong-day">18:00</a></li>'}):route.fulfill({contentType:'text/html',body:html}));await page.goto(resources[0].url);
  const result=await scanGgcb(page,resources[0],{...initialPolicy(),dateFrom:'2026-11-02',dateTo:'2026-11-02'},new ProviderSession('ggcb','.local/test-unused'),{today:'2026-10-27',calendarTimeout:800,responseTimeout:150});
  assert.equal(result.status,'ERROR');assert.equal(result.observations.length,0);assert.match(result.navigation!,/DAY_DATE_MISMATCH/);
 }finally{await browser.close();}
});

test('GGCB detects a body failure returned by Response.finished and never treats it as no availability',async t=>{
 const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true});
 try{const page=await browser.newPage();
  await page.route('**/*',route=>route.request().method()==='POST'?route.fulfill({contentType:'text/html',body:'<li>No blocks available.</li>'}):route.fulfill({contentType:'text/html',body:fixture(false).replace('let month=9;','let month=10;')}));
  page.on('response',response=>{if(new URLSearchParams(response.request().postData()||'').get('action')==='wc_bookings_get_blocks')t.mock.method(response,'finished',async()=>new Error('fixture-private-response-error'));});await page.goto(resources[0].url);
  const result=await scanGgcb(page,resources[0],{...initialPolicy(),dateFrom:'2026-11-02',dateTo:'2026-11-02'},new ProviderSession('ggcb','.local/test-unused'),{today:'2026-10-27',calendarTimeout:800,responseTimeout:150});
  assert.equal(result.status,'ERROR');assert.equal(result.observations.length,0);assert.match(result.navigation!,/DAY_NETWORK_ERROR/);assert.ok(!result.navigation!.includes('fixture-private-response-error'));
 }finally{await browser.close();}
});

test('GGCB recognizes a pre-existing calendar error banner even if its failed HTTP response preceded the observer',async()=>{
 const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true});
 try{const page=await browser.newPage();let dayRequests=0;
  const html=fixture(false).replace('let month=9;','let month=10;').replace('<div class="wc-bookings-date-picker">','<p class="wc-bookings-availability-error">fixture-private-error</p><div class="wc-bookings-date-picker">');
  await page.route('**/*',route=>{if(route.request().method()==='POST')dayRequests++;return route.fulfill({contentType:'text/html',body:html});});await page.goto(resources[0].url);
  const result=await scanGgcb(page,resources[0],{...initialPolicy(),dateFrom:'2026-11-02',dateTo:'2026-11-02'},new ProviderSession('ggcb','.local/test-unused'),{today:'2026-10-27',calendarTimeout:200,responseTimeout:150});
  assert.equal(result.status,'ERROR');assert.equal(dayRequests,0);assert.match(result.navigation!,/MONTH_UNAVAILABLE/);assert.ok(!result.navigation!.includes('fixture-private-error'));
 }finally{await browser.close();}
});

test('GGCB bounds recovery across a whole scan and classifies a missing request without reading stale inventory',async()=>{
 const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true});
 try{
  const page=await browser.newPage();let documents=0;const diagnostics:import('../src/activity-log.ts').EventContext[]=[];
  const html=fixture(false).replace('let month=9;','let month=10;').replace('(month===9?[19,20]:[2,3])','[2,3,4,5,9,10,11,12,16,17,18,19]').replace('async function choose(day){','async function choose(day){return;').replace('<ul class="block-picker"></ul>','<ul class="block-picker"><li><a data-value="stale">18:00</a></li></ul>');
  await page.route('**/*',route=>{documents++;return route.fulfill({contentType:'text/html',body:html});});await page.goto(resources[0].url);
  const result=await scanGgcb(page,resources[0],{...initialPolicy(),dateFrom:'2026-11-02',dateTo:'2026-11-19'},new ProviderSession('ggcb','.local/test-unused'),{today:'2026-10-27',calendarTimeout:800,responseTimeout:100,onIssue:(_message,event)=>diagnostics.push(event)});
  assert.equal(documents,2,'one initial document plus at most one recovery reload for date failures');assert.equal(result.status,'ERROR');assert.equal(result.observations.length,0);assert.ok(result.coverage.every(day=>day.status==='ERROR'));assert.match(result.navigation!,/DAY_NO_REQUEST/);assert.equal(diagnostics.filter(event=>event.stage==='DAY_LOAD').length,2);
 }finally{await browser.close();}
});

test('GGCB stops on 403, 429 and verification responses without automatic reloads or false unavailable inventory',async()=>{
 const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true});
 try{for(const status of [403,429,200]){
  const page=await browser.newPage();let documents=0,requests=0;
  await page.route('**/*',route=>{if(route.request().method()==='POST'){requests++;return route.fulfill({status,headers:status===200?{'cf-mitigated':'challenge'}:{},contentType:'text/html',body:'<li>No blocks available.</li>'});}documents++;return route.fulfill({contentType:'text/html',body:fixture(false).replace('let month=9;','let month=10;')});});await page.goto(resources[0].url);
  const result=await scanGgcb(page,resources[0],{...initialPolicy(),dateFrom:'2026-11-02',dateTo:'2026-11-03'},new ProviderSession('ggcb','.local/test-unused'),{today:'2026-10-27',calendarTimeout:1000,responseTimeout:500});
  assert.equal(documents,1);assert.equal(requests,1);assert.equal(result.status,'ERROR');assert.equal(result.observations.length,0);assert.ok(result.coverage.every(day=>day.status==='ERROR'));assert.match(result.navigation!,status===200?/DAY_VERIFICATION_REQUIRED/:new RegExp('HTTP '+status));await page.close();
 }}finally{await browser.close();}
});

test('GGCB retains already verified prices when a later date exhausts the shared recovery budget',async()=>{
 const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true});
 try{const page=await browser.newPage();const queried:string[]=[];
  await page.route('**/*',route=>{const data=new URLSearchParams(route.request().postData()||'');const action=data.get('action');
   if(action==='wc_bookings_get_blocks'){const day=new URLSearchParams(data.get('form')||'').get('wc_bookings_field_start_date_day')!;queried.push(day);return day==='2'?route.fulfill({contentType:'text/html',body:'<li><a data-value="2026-11-02T18:00:00+00:00">18:00</a></li>'}):route.abort('failed');}
   if(action){assert.equal(action,'wc_bookings_calculate_costs');return route.fulfill({json:{result:'SUCCESS',raw_price:55}});}
   return route.fulfill({contentType:'text/html',body:fixture(false).replace('let month=9;','let month=10;')});
  });await page.goto(resources[0].url);
  const result=await scanGgcb(page,resources[0],{...initialPolicy(),dateFrom:'2026-11-02',dateTo:'2026-11-05'},new ProviderSession('ggcb','.local/test-unused'),{today:'2026-10-27',calendarTimeout:800,responseTimeout:150});
  assert.deepEqual(queried,['2','3','3']);assert.equal(result.status,'PARTIAL');assert.equal(result.observations.length,1);assert.equal(result.observations[0].price,'£55.00');assert.equal(result.coverage[0].status,'READ');assert.ok(result.coverage.slice(1).every(day=>day.status==='ERROR'));
 }finally{await browser.close();}
});

test('GGCB bounds a response body that never finishes and removes its observers',async t=>{
 const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true});let deadline:NodeJS.Timeout|undefined;
 try{const page=await browser.newPage();
  await page.route('**/*',route=>route.request().method()==='POST'?route.fulfill({contentType:'text/html',body:'<li>No blocks available.</li>'}):route.fulfill({contentType:'text/html',body:fixture(false).replace('let month=9;','let month=10;')}));
  page.on('response',response=>{if(new URLSearchParams(response.request().postData()||'').get('action')==='wc_bookings_get_blocks')t.mock.method(response,'finished',()=>new Promise<null>(()=>{}));});await page.goto(resources[0].url);
  const cleanup=t.mock.method(page,'off');
  const result=await Promise.race([scanGgcb(page,resources[0],{...initialPolicy(),dateFrom:'2026-11-02',dateTo:'2026-11-02'},new ProviderSession('ggcb','.local/test-unused'),{today:'2026-10-27',calendarTimeout:800,responseTimeout:150}),new Promise<never>((_,reject)=>{deadline=setTimeout(()=>reject(new Error('response body escaped the deadline')),5000);})]);
  assert.equal(result.status,'ERROR');assert.match(result.navigation!,/DAY_BODY_TIMEOUT/);const removed=cleanup.mock.calls.map(call=>String(call.arguments[0]));assert.equal(removed.filter(name=>name==='request').length,2);assert.equal(removed.filter(name=>name==='requestfailed').length,4);assert.equal(removed.filter(name=>name==='response').length,4);
 }finally{clearTimeout(deadline);await browser.close();}
});

test('GGCB accepts a replacement response after the website aborts its previous same-date request',async()=>{
 const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true});
 try{const page=await browser.newPage();let requests=0;const diagnostics:import('../src/activity-log.ts').EventContext[]=[];
  const html=fixture(false).replace('let month=9;','let month=10;').replace("const response=await fetch('/wp-admin/admin-ajax.php'","const cancelled=new AbortController();void fetch('/wp-admin/admin-ajax.php',{method:'POST',body:new URLSearchParams({action:'wc_bookings_get_blocks',form:form.toString()}),signal:cancelled.signal}).catch(()=>{});await new Promise(resolve=>setTimeout(resolve,50));cancelled.abort();const response=await fetch('/wp-admin/admin-ajax.php'");
  await page.route('**/*',async route=>{if(route.request().method()==='POST'){requests++;if(requests===1){await new Promise(r=>setTimeout(r,120));return route.abort('aborted').catch(()=>{});}return route.fulfill({contentType:'text/html',body:'<li>No blocks available.</li>'});}return route.fulfill({contentType:'text/html',body:html});});await page.goto(resources[0].url);
  const result=await scanGgcb(page,resources[0],{...initialPolicy(),dateFrom:'2026-11-02',dateTo:'2026-11-02'},new ProviderSession('ggcb','.local/test-unused'),{today:'2026-10-27',calendarTimeout:1000,responseTimeout:500,onIssue:(_message,event)=>diagnostics.push(event)});
  assert.equal(requests,2);assert.equal(result.status,'OK');assert.equal(diagnostics.length,0);
 }finally{await browser.close();}
});

test('GGCB respects a new manual takeover before reloading a failed date',async()=>{
 const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true});
 try{const page=await browser.newPage();let documents=0;
  await page.route('**/*',route=>{documents++;return route.fulfill({contentType:'text/html',body:fixture(false).replace('let month=9;','let month=10;').replace('async function choose(day){','async function choose(day){return;')});});await page.goto(resources[0].url);
  const session=new ProviderSession('ggcb','.local/test-unused');
  await assert.rejects(scanGgcb(page,resources[0],{...initialPolicy(),dateFrom:'2026-11-02',dateTo:'2026-11-03'},session,{today:'2026-10-27',calendarTimeout:800,responseTimeout:150,onIssue:()=>{session.mode='MANUAL_CONTROL';}}),Interrupted);
  assert.equal(documents,1);assert.equal(session.mode,'MANUAL_CONTROL');
 }finally{await browser.close();}
});

test('GGCB also stops month navigation on refusal, rate limiting or explicit verification',async()=>{
 const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true});
 try{for(const status of [403,429,200]){const page=await browser.newPage();let documents=0,monthRequests=0,dayRequests=0;
  await page.route('**/*',route=>{if(new URL(route.request().url()).searchParams.has('wc-ajax')){monthRequests++;return route.fulfill({status,headers:status===200?{'cf-mitigated':'challenge'}:{},json:{}});}if(route.request().method()==='POST'){dayRequests++;return route.fulfill({body:''});}documents++;return route.fulfill({contentType:'text/html',body:fixture(false)});});await page.goto(resources[0].url);
  const result=await scanGgcb(page,resources[0],{...initialPolicy(),dateFrom:'2026-11-02',dateTo:'2026-12-03'},new ProviderSession('ggcb','.local/test-unused'),{today:'2026-10-27',calendarTimeout:1000,responseTimeout:500});
  assert.equal(documents,1);assert.equal(monthRequests,1);assert.equal(dayRequests,0);assert.equal(result.status,'ERROR');assert.ok(result.coverage.every(day=>day.status==='ERROR'));assert.match(result.navigation!,status===200?/MONTH_VERIFICATION_REQUIRED/:new RegExp('HTTP '+status));await page.close();
 }}finally{await browser.close();}
});

test('GGCB does not mistake an HTML error link for a valid unavailable timetable',async()=>{
 const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true});
 try{const page=await browser.newPage();await page.route('**/*',route=>route.request().method()==='POST'?route.fulfill({contentType:'text/html',body:'<li><a href="/login">Please log in</a></li>'}):route.fulfill({contentType:'text/html',body:fixture(false).replace('let month=9;','let month=10;')}));await page.goto(resources[0].url);
  const result=await scanGgcb(page,resources[0],{...initialPolicy(),dateFrom:'2026-11-02',dateTo:'2026-11-02'},new ProviderSession('ggcb','.local/test-unused'),{today:'2026-10-27',calendarTimeout:1000,responseTimeout:500});assert.equal(result.status,'ERROR');assert.equal(result.observations.length,0);assert.match(result.navigation!,/DAY_STRUCTURE/);
 }finally{await browser.close();}
});

test('GGCB cancels a pending body immediately when memory reclamation closes its owned browser',{timeout:30000},async t=>{
 const previous=process.env.PITCH_HEADLESS;process.env.PITCH_HEADLESS='1';const root=await mkdtemp(join(tmpdir(),'pitch-ggcb-reclaim-')),session=new ProviderSession('ggcb',root);
 let reclaim:Promise<boolean>|undefined;
 try{const context=await session.getContext();await context.route('**/*',route=>route.request().method()==='POST'?route.fulfill({contentType:'text/html',body:'<li>No blocks available.</li>'}):route.fulfill({contentType:'text/html',body:fixture(false).replace('let month=9;','let month=10;')}));const page=await context.newPage();await page.goto(resources[0].url);
  page.on('response',response=>{if(new URLSearchParams(response.request().postData()||'').get('action')==='wc_bookings_get_blocks')t.mock.method(response,'finished',()=>new Promise<null>(()=>{}));});
  let clicked!:()=>void;const clickDone=new Promise<void>(resolve=>clicked=resolve);
  const reading=session.exclusive(()=>loadGgcbDay(page,'2026-11-02',async()=>{await page.locator('td.date-date-2 a').click();clicked();},()=>session.assertAutomatic(),6000,1000));let cancelled:unknown;void reading.catch(error=>{cancelled=error;});await clickDone;await new Promise(resolve=>setImmediate(resolve));
  const pageClosed=new Promise<void>(resolve=>page.once('close',()=>resolve()));reclaim=session.recycleBrowser();await Promise.race([pageClosed,reclaim.then(()=>pageClosed)]);await new Promise(resolve=>setImmediate(resolve));
  assert.ok(cancelled instanceof Interrupted,'page closure must cancel the pending read without waiting for its response deadline');assert.equal(await reclaim,true);await assert.rejects(reading,Interrupted);assert.equal(session.context,undefined);assert.equal(session.mode,'AUTOMATION');
 }finally{await reclaim?.catch(()=>{});session.mode='PAUSED';await session.close().catch(()=>{});await rm(root,{recursive:true,force:true});if(previous===undefined)delete process.env.PITCH_HEADLESS;else process.env.PITCH_HEADLESS=previous;}
});
