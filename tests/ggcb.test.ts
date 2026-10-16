import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {scanGgcb} from '../src/adapters/ggcb.ts';
import {ggcbReleaseDate} from '../src/adapters/ggcb-calendar.ts';
import {ProviderSession} from '../src/browser.ts';
import {initialPolicy,resources} from '../src/domain.ts';

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
  const browser=await chromium.launch({channel:'msedge',headless:true,chromiumSandbox:true,timeout:30000});
  try {
    const context=await browser.newContext();let monthRequests=0;let quotes=0;const actions:string[]=[];
    await context.route('**/*',async route=>{
      const request=route.request();const url=new URL(request.url());
      if(url.searchParams.get('wc-ajax')==='wc_bookings_find_booked_day_blocks'){monthRequests++;return monthRequests===1?route.abort('failed'):route.fulfill({json:{}});}
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
  }finally{await browser.close();}
});

test('GGCB does not navigate or query slots in months the official page has not released',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true,chromiumSandbox:true,timeout:30000});
  try {
    const page=await browser.newPage();let queries=0;
    await page.route('**/*',route=>{if(route.request().method()==='POST'||new URL(route.request().url()).searchParams.has('wc-ajax'))queries++;return route.fulfill({contentType:'text/html',body:fixture(true)});});
    await page.goto(resources[0].url);
    const result=await scanGgcb(page,resources[0],{...initialPolicy(),dateFrom:'2026-11-02',dateTo:'2026-12-16'},new ProviderSession('ggcb','.local/test-unused'),{today:'2026-10-16',calendarTimeout:400});
    assert.equal(queries,0);assert.ok(result.coverage.every(day=>day.status==='OUTSIDE_RELEASE_WINDOW'));assert.match(result.coverage[0].note,/2026-10-25/);
  }finally{await browser.close();}
});
