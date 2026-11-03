import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.ts';
import {Monitor} from '../src/monitor.ts';
import {ProviderSession} from '../src/browser.ts';
import {resources,initialPolicy,londonDate,addDays,weekStart} from '../src/domain.ts';
import {chromium} from 'playwright';
import {scanPlayFootball} from '../src/adapters/playfootball.ts';
import {EventEmitter} from 'node:events';

test('a midnight rollover does not bypass PlayFootball quiet time',async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-02T23:55:00Z')});
  const store=new Store(':memory:'),monitor=new Monitor(store,'.local/test-unused');let visits=0;
  for(const [id,session] of monitor.sessions)if(id!=='playfootball')session.mode='PAUSED';
  t.mock.method(monitor as any,'scanResource',async()=>{visits++;});
  try{
    await monitor.tick();assert.equal(visits,2);
    t.mock.timers.tick(6*60000);await monitor.tick();
    assert.equal(visits,2,'London midnight must not start another full scan six minutes later');
  }finally{store.close();}
});

test('one thousand scan button requests cannot bypass the provider quiet interval',async t=>{
  const store=new Store(':memory:'),monitor=new Monitor(store,'.local/test-unused');let visits=0;
  t.mock.method(monitor as any,'scanResource',async()=>{visits++;});
  try{
    await monitor.scan('playfootball');
    for(let i=0;i<1000;i++){await monitor.action('playfootball','scan');await monitor.sessions.get('playfootball')!.job;}
    t.diagnostic(JSON.stringify({controlRequests:1000,venueVisits:visits}));
    assert.equal(visits,2,'only the first provider scan may visit the two venues');
  }finally{store.close();}
});

test('fifty repeat calendar reads retain the loaded page instead of navigating fifty times',async()=>{
  let navigations=0,time=0,url='about:blank';const resource=resources[2];
  const page={isClosed:()=>false,url:()=>url,locator:()=>({count:async()=>1}),goto:async()=>{navigations++;url=resource.url;}};
  const session=new ProviderSession('playfootball','.local/test-unused',undefined,{now:()=>time,sleep:async ms=>{time+=ms;}});
  session.getContext=async()=>({newPage:async()=>page} as any);
  for(let i=0;i<50;i++)await session.page(resource);
  assert.equal(navigations,1,'repeat reads must use the calendar controls without a full document reload');
});

test('a retained calendar document is refreshed after a day without altering the action gap',async t=>{
  let now=Date.now(),time=0,navigations=0,url='about:blank';t.mock.method(Date,'now',()=>now);
  const resource=resources[2],page={isClosed:()=>false,url:()=>url,locator:()=>({count:async()=>1}),goto:async()=>{navigations++;url=resource.url;}};
  const session=new ProviderSession('playfootball','.local/test-unused',undefined,{now:()=>time,sleep:async ms=>{time+=ms;}});session.getContext=async()=>({newPage:async()=>page} as any);
  await session.page(resource);now+=86400000-1;await session.page(resource);assert.equal(navigations,1);
  now+=2;await session.page(resource);assert.equal(navigations,2);assert.ok(time>=10000);
});

test('one thousand concurrent scheduler ticks cannot overlap venue scans',async t=>{
  const store=new Store(':memory:'),monitor=new Monitor(store,'.local/test-unused');let visits=0,active=0,peak=0;
  for(const [id,session] of monitor.sessions)if(id!=='playfootball')session.mode='PAUSED';
  t.mock.method(monitor as any,'scanResource',async()=>{visits++;active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,1));active--;});
  try{
    await Promise.all(Array.from({length:1000},()=>monitor.tick()));
    assert.equal(visits,2);assert.equal(peak,1);
    t.diagnostic(JSON.stringify({concurrentTicks:1000,venueVisits:visits,peak}));
  }finally{store.close();}
});

test('seven days of automatic ticks never shorten the quiet window at midnight',async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-02T23:55:00Z')});
  const store=new Store(':memory:'),monitor=new Monitor(store,'.local/test-unused');const starts:number[]=[];
  for(const [id,session] of monitor.sessions)if(id!=='playfootball')session.mode='PAUSED';
  t.mock.method(monitor as any,'scanResource',async(_session:ProviderSession,resource:typeof resources[number])=>{if(resource.id==='westferry-5')starts.push(Date.now());});
  try{
    for(let i=0;i<7*24*6;i++){await monitor.tick();t.mock.timers.tick(10*60000);}
    const minimum=Math.min(...starts.slice(1).map((at,i)=>at-starts[i]));
    assert.ok(minimum>=30*60000);assert.equal(starts.length,7*24*2);
    t.diagnostic(JSON.stringify({virtualDays:7,ticks:1008,scanRounds:starts.length,minimumGapMinutes:minimum/60000}));
  }finally{store.close();}
});

test('one thousand background rate-limit responses are reported once without revisiting a venue',async t=>{
  const store=new Store(':memory:'),monitor=new Monitor(store,'.local/test-unused'),session=monitor.sessions.get('playfootball')!;let visits=0;
  store.savePolicy({...store.policy(),lookahead:'7d'});
  for(const [id,other] of monitor.sessions)if(id!=='playfootball')other.mode='PAUSED';
  const original=monitor.scanResource.bind(monitor);
  t.mock.method(monitor as any,'scanResource',async(s:ProviderSession,resource:typeof resources[number])=>{if(s.responses?.issue)return original(s,resource);visits++;});
  const context=new EventEmitter(),frame={page:()=>page},page={mainFrame:()=>frame,isClosed:()=>false};session.responses!.watch(context as any);
  try{
    await monitor.tick();assert.equal(visits,2);
    for(let i=0;i<1000;i++){
      context.emit('response',{url:()=>resources[2].url,headers:()=>({'retry-after':'1800'}),status:()=>429,request:()=>({frame:()=>frame,isNavigationRequest:()=>false,resourceType:()=> 'fetch'})});
      await monitor.tick();
    }
    const notices=store.eventPage({provider:'playfootball',limit:100}).items.filter(row=>row.code==='RATE_LIMITED');
    assert.equal(notices.length,1);assert.equal(visits,2);
    t.diagnostic(JSON.stringify({backgroundRateResponses:1000,rateNotices:notices.length,additionalVenueVisits:visits-2}));
  }finally{store.close();}
});

test('retained browser calendars refresh prices, stop at the stated release window and never select a slot',async t=>{
  const rounds=Number(process.env.PITCH_STRESS_ROUNDS||3);assert.ok(Number.isInteger(rounds)&&rounds>=2&&rounds<=100);
  const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true});
  const reference=londonDate(),base=weekStart(reference);let documentLoads=0,calendarLoads=0,time=0;
  const session=new ProviderSession('playfootball','.local/test-unused',undefined,{now:()=>time,sleep:async ms=>{time+=ms;}});
  const policy=initialPolicy();const latest=new Map<string,number>();
  const html=`<p>You can book a pitch in a matter of minutes, up to 30 days in advance, through our easy-to-use booking calendar system.</p><div class="bookings-calendar"></div><script>
    const base=${JSON.stringify(base)};let week=0;
    function day(index){const d=new Date(base+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+index);return d;}
    function render(version){
      const first=day(week*7),last=day(week*7+6),month=last.toLocaleString('en-GB',{month:'short',timeZone:'UTC'});
      let headers='',rows='';
      for(let i=0;i<7;i++){const d=day(week*7+i),released=d.toISOString().slice(0,10)<=${JSON.stringify(addDays(reference,30))};headers+='<div class="bookings-calendar-weekday">'+d.toLocaleString('en-GB',{weekday:'short',timeZone:'UTC'})+' '+d.getUTCDate()+'</div>';rows+='<div class="booking-slot"><button onclick="document.body.dataset.booked=1">18:00<br>'+(released?'60 min<br>£'+(80+version)+'.00':'Not yet released')+'</button></div><div class="clearfix"></div>';}
      document.querySelector('.bookings-calendar').innerHTML='<div class="bookings-calendar-date"><button id="previous" '+(week<=0?'disabled':'')+' onclick="move(-1)"><svg data-icon="chevron-left"></svg></button><button class="bookings-calendar-picker">'+first.getUTCDate()+' - '+last.getUTCDate()+' '+month+'</button><button id="next" '+(week>=12?'disabled':'')+' onclick="move(1)"><svg data-icon="chevron-right"></svg></button></div>'+headers+'<div class="bookings-calendar-scroll-calendar-content-wrapper">'+rows+'</div>';
    }
    async function move(direction){const response=await fetch('/fixture-calendar?week='+(week+direction));if(!response.ok)return;const data=await response.json();week+=direction;render(data.version);}
    render(0);
  </script>`;
  try{
    const context=await browser.newContext();context.setDefaultTimeout(5000);session.context=context;session.getContext=async()=>context;
    const scriptErrors:string[]=[];context.on('page',page=>page.on('pageerror',error=>scriptErrors.push(error.message)));
    await context.route('**/*',route=>{
      if(new URL(route.request().url()).pathname==='/fixture-calendar'){calendarLoads++;return route.fulfill({json:{version:calendarLoads}});}
      documentLoads++;return route.fulfill({contentType:'text/html',body:html});
    });
    for(let round=0;round<rounds;round++)for(const resource of resources.filter(row=>row.provider==='playfootball')){
      const page=await session.page(resource);assert.deepEqual(scriptErrors,[]);
      const result=await scanPlayFootball(page,resource,policy,session,reference);
      assert.equal(result.status,'OK');assert.ok(result.observations.length>0);
      for(const item of result.observations){
        assert.ok(item.date<=addDays(reference,30));const key=resource.id+'/'+item.date,price=Number(item.price!.replace('£',''));
        if(round)assert.ok(price>latest.get(key)!,`stale quote at round ${round}: ${key}`);latest.set(key,price);
      }
      assert.ok(result.coverage.some(row=>row.status==='OUTSIDE_RELEASE_WINDOW'));
      assert.ok(result.coverage.filter(row=>row.date>addDays(reference,30)).every(row=>row.status==='OUTSIDE_RELEASE_WINDOW'));
      assert.equal(await page.locator('body').getAttribute('data-booked'),null);
    }
    assert.equal(documentLoads,2,'only the initial document for each venue is loaded');
    t.diagnostic(JSON.stringify({browserRounds:rounds,documentLoads,calendarLoads,pricedDates:latest.size,slotSelections:0}));
    // Removing the explicit statement must remove the inferred horizon as well.
    const resource=resources[2],page=await session.page(resource);
    await page.locator('p').evaluateAll(elements=>elements.forEach(element=>element.remove()));
    const expandedPolicy={...policy,dateFrom:addDays(reference,28),dateTo:addDays(reference,37)};
    for(let round=0;round<2;round++){
      if(round)await session.page(resource);
      const expanded=await scanPlayFootball(page,resource,expandedPolicy,session,reference);
      assert.ok(expanded.coverage.every(row=>row.status!=='OUTSIDE_RELEASE_WINDOW'));
      assert.ok(expanded.observations.some(row=>row.date>addDays(reference,30)));
      if(round)assert.equal(expanded.status,'OK','expanded ranges must eventually cover both sides of the retained calendar');
    }
  }finally{await browser.close();}
});
