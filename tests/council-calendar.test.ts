import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { councilDate, scanCouncilCalendar,readCouncilSlots } from '../src/adapters/council-calendar.ts';
import { ProviderSession } from '../src/browser.ts';
import { initialPolicy } from '../src/domain.ts';

test('Council date labels validate the weekday and cross the year boundary',()=>{
  assert.equal(councilDate('1 Jan','Fri','2026-12-28'),'2027-01-01');
  assert.equal(councilDate('19 Oct','Mon','2026-10-15'),'2026-10-19');
  assert.throws(()=>councilDate('31 Feb','Tue','2026-10-15'));
  assert.throws(()=>councilDate('19 Oct','Tue','2026-10-15'));
});

test('Council reads date pages through an empty carousel transition without selecting or confirming times',async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true,chromiumSandbox:true,timeout:30000});
  try {
    const page=await browser.newPage(); await page.setContent('<iframe></iframe>'); const form=page.frames()[1];
    await form.setContent(`<input id="bookingLocation" value="Stepney Green Third"><input id="duration" value="19"><input id="granularity" value="20">
      <div id="special-datetime-picker"><div id="time_selector" hidden><h3></h3><ul></ul><a href="#" class="back" onclick="event.preventDefault();document.getElementById('time_selector').hidden=true;document.getElementById('booking_day_selector').hidden=false">Back</a></div>
      <div id="booking_day_selector"><a href="#" class="left carousel-control" onclick="event.preventDefault();move(-1)">Earlier</a><div class="carousel-inner"></div><a href="#" class="right carousel-control" onclick="event.preventDefault();move(1)">Later</a></div></div>
      <script>
        let group=0;window.selected=0;window.confirmed=0;
        function render(){const wrap=document.querySelector('.carousel-inner');wrap.innerHTML='<div class="carousel-item active"><div id="week-cal"></div></div>';const days=document.getElementById('week-cal');for(let i=0;i<6;i++){const d=new Date(Date.UTC(2026,9,16+group*6+i));const label=d.getUTCDate()+' Oct';const el=document.createElement('div');el.className='bds-day';el.innerHTML='<span class="day">'+['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()]+'</span><span class="date">'+label+'</span>';el.onclick=()=>showTimes(label);days.append(el);}}
        function move(delta){group=Math.max(0,Math.min(1,group+delta));document.querySelector('.carousel-inner').innerHTML='';setTimeout(render,100);}
        function showTimes(label){document.getElementById('booking_day_selector').hidden=true;const time=document.getElementById('time_selector');time.hidden=false;time.querySelector('h3').textContent='Select a time on '+label;time.querySelector('ul').innerHTML='<li class="availability-'+(label==='20 Oct'?'unavailable':'available')+'"><a class="select-time" href="#" onclick="event.preventDefault();window.selected++">18:00<span>available</span><span hidden>unavailable</span></a><div hidden><a class="confirm" href="#" onclick="window.confirmed++">Confirm 18:00</a></div></li>';}
        render();
      </script>`);
    const session=new ProviderSession('council','.local/test-unused');
    const policy={...initialPolicy(),dateFrom:'2026-10-19',dateTo:'2026-10-27'};
    const result=await scanCouncilCalendar(form,policy,session);
    assert.equal(result.status,'OK'); assert.equal(result.coverage.length,6);
    assert.equal(result.observations.find(o=>o.date==='2026-10-20')?.availability,'BOOKED');
    assert.equal(result.observations.find(o=>o.date==='2026-10-19')?.availability,'AVAILABLE');
    assert.ok(result.observations.every(o=>o.duration===null && o.price===null));
    assert.equal(await form.evaluate(()=>({selected:(window as unknown as {selected:number}).selected,confirmed:(window as unknown as {confirmed:number}).confirmed})).then(flags=>flags.selected+flags.confirmed),0);
    const repeat=await scanCouncilCalendar(form,policy,session); assert.equal(repeat.status,'OK'); assert.equal(repeat.observations.length,6);
    await form.locator('.bds-day').last().evaluate(el=>{el.prepend('UNAVAILABLE ');(el as HTMLElement).onclick=()=>{throw new Error('Unavailable dates must not be clicked');};});
    // Preserve that unavailable marker when the fixture rewinds and renders again.
    await form.evaluate(()=>{const original=(window as unknown as {render:()=>void}).render;(window as unknown as {render:()=>void}).render=()=>{original();for(const el of document.querySelectorAll('.bds-day'))if(el.textContent?.includes('27 Oct'))el.prepend('UNAVAILABLE ');};});
    const unavailable=await scanCouncilCalendar(form,policy,session);
    assert.equal(unavailable.status,'PARTIAL');assert.equal(unavailable.observations.length,5);
    assert.match(unavailable.coverage.find(c=>c.date==='2026-10-27')!.note,/UNAVAILABLE/);
    assert.match(unavailable.navigation!,/6\/6/);
    assert.equal(await form.locator('#duration').inputValue(),'19');
    await form.locator('#time_selector').evaluate(el=>{(el as HTMLElement).hidden=false;el.innerHTML='<li class="availability-available"><a class="select-time">18:00</a><span>£38.00</span><span hidden>£999.00</span></li><li class="availability-available"><a class="select-time">18:00</a><span>£34.00 or £38.00</span></li>';});
    const quoted=await readCouncilSlots(form);assert.equal(quoted[0].price,'£38.00');assert.equal(quoted[1].price,null);
  } finally {await browser.close();}
});
