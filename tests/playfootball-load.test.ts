import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.ts';
import {Monitor} from '../src/monitor.ts';
import {chromium} from 'playwright';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {targetDates,resources,weekStart,addDays} from '../src/domain.ts';
import {EventEmitter} from 'node:events';
import {PlayFootballResponses,WebsiteResponseError} from '../src/playfootball-responses.ts';
import {ProviderSession} from '../src/browser.ts';

function responseFixture(){
  const context=new EventEmitter();const guard=new PlayFootballResponses();guard.watch(context as any);
  const frame={page:()=>page};const page={mainFrame:()=>frame,isClosed:()=>false};
  const emit=(status:number,headers:Record<string,string>={},url='https://www.playfootball.net/api/calendar',navigation=false)=>{
    context.emit('response',{url:()=>url,headers:()=>headers,status:()=>status,request:()=>({frame:()=>frame,isNavigationRequest:()=>navigation,resourceType:()=>navigation?'document':'fetch'})});
  };
  return {guard,emit};
}

test('PlayFootball obeys Retry-After seconds and dates and backs off repeated rate limits',t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);const {guard,emit}=responseFixture();
  emit(429,{'retry-after':'1800'});assert.equal(guard.issue?.retryAt,now+1800000);assert.throws(()=>guard.check(),WebsiteResponseError);
  now+=1800001;guard.check();
  emit(429);assert.equal(guard.issue?.retryAt,now+3600000,'second rate limit waits sixty minutes');
  now+=3600001;guard.check();emit(429);assert.equal(guard.issue?.retryAt,now+7200000,'third rate limit waits two hours');
  now+=7200001;guard.check();guard.recovered();
  const until=new Date(now+7200000).toUTCString();emit(429,{'retry-after':until});
  assert.equal(guard.issue?.retryAt,Date.parse(until),'a longer server wait always wins');
});

test('only first-party blocking responses stop monitoring and a stale calendar cannot clear a challenge',()=>{
  const {guard,emit}=responseFixture();
  emit(429,{},'https://third-party.example.invalid/asset');emit(401,{},'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/pat');emit(403);
  assert.equal(Boolean(guard.issue),false);
  emit(403,{'cf-mitigated':'challenge'});assert.equal(guard.issue?.kind,'HUMAN_VERIFICATION');
  emit(200);assert.throws(()=>guard.check(),WebsiteResponseError,'a successful background response cannot dismiss a challenge');
  emit(200,{},'https://www.playfootball.net/venues/calendar',true);assert.doesNotThrow(()=>guard.check());
});

test('a complete PlayFootball scan leaves the configured quiet interval after both venues finish',async t=>{
  const store=new Store(':memory:');const monitor=new Monitor(store,'.local/test-unused');
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const interval=store.policy().intervalMinutes*60000;let scans=0;
  t.mock.method(monitor as any,'scanResource',async()=>{scans++;now+=90000;});
  try{
    await monitor.scan('playfootball');
    assert.equal(scans,2);
    assert.ok(monitor.sessions.get('playfootball')!.nextScanAt>=now+interval,
      'the two venues must finish before the full quiet interval begins');
    assert.equal(monitor.sessions.get('playfootball')!.nextScanAt,now+1800000,'a short user interval still leaves thirty minutes for PlayFootball');
  }finally{store.close();}
});

test('slow PlayFootball scans do not become continuous automatic traffic',async t=>{
  const store=new Store(':memory:');const monitor=new Monitor(store,'.local/test-unused');
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  store.savePolicy({...store.policy(),intervalMinutes:1});let scans=0;
  for(const [id,session] of monitor.sessions)if(id!=='playfootball')session.mode='PAUSED';
  t.mock.method(monitor as any,'scanResource',async()=>{scans++;now+=90000;});
  try{
    await monitor.tick();assert.equal(scans,2);
    await monitor.tick();assert.equal(scans,2,'the next scheduler tick must not immediately rescan both calendars');
  }finally{store.close();}
});

test('a challenge received during the ten-second gap cancels the queued website action',async()=>{
  let now=0,actions=0;const page={} as any;
  const session=new ProviderSession('playfootball','.local/test-unused',undefined,{
    now:()=>now,sleep:async ms=>{now+=ms;session.responses!.issue=new WebsiteResponseError('HUMAN_VERIFICATION',page,403);}
  });
  await session.webAction(async()=>{actions++;});
  await assert.rejects(session.webAction(async()=>{actions++;}),WebsiteResponseError);
  assert.equal(actions,1,'do not click or reopen after the server asks for verification');
});

test('a blocked second venue preserves the first venue inventory and its notification',async t=>{
  const store=new Store(':memory:');const monitor=new Monitor(store,'.local/test-unused');const day=targetDates(store.policy())[0];
  t.mock.method(monitor as any,'scanResource',async(session:ProviderSession,resource:typeof resources[number])=>{
    if(resource.id==='westferry-5')store.saveScan(resource,{status:'OK',summary:'fixture read',coverage:[{date:day,status:'READ',note:'fixture'}],observations:[{resourceId:resource.id,date:day,start:'18:00',duration:60,availability:'AVAILABLE',price:'£85.00',note:'fixture'}]});
    else await session.requireManual('HUMAN_VERIFICATION','fixture challenge');
  });
  try{
    await monitor.scan('playfootball');
    assert.equal(store.latest('westferry-5')!.result.coverage[0].status,'READ');
    assert.equal(store.latest('westferry-5')!.result.observations[0].price,'£85.00');
    assert.equal(store.notifications.list().items[0].payload.resourceId,'westferry-5');
  }finally{store.close();}
});

test('a rate-limited automatic login keeps saved credentials eligible and does not open either calendar',async t=>{
  const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true});
  const root=mkdtempSync(join(tmpdir(),'pitch-pf-login-limit-')),store=new Store(':memory:'),monitor=new Monitor(store,root);let requests=0;
  const session=new ProviderSession('playfootball',root,{load:async()=>({username:'fixture@example.invalid',password:'fixture-secret'})} as any);
  monitor.sessions.set('playfootball',session);await session.restoreCredentials();session.status='LOGIN_REQUIRED';
  try{
    const context=await browser.newContext();t.mock.method(chromium,'launchPersistentContext',async()=>context);
    await context.route('https://**.playfootball.net/**',route=>{requests++;return route.fulfill({status:429,headers:{'retry-after':'1800'},body:'fixture limited'});});
    const started=Date.now();await monitor.scan('playfootball');
    assert.equal(requests,1);assert.equal(session.mode,'AUTOMATION');assert.equal(session.automaticLoginAllowed,true);
    assert.ok(session.nextScanAt>=started+1800000);assert.ok(store.eventPage({provider:'playfootball'}).items.some(row=>row.code==='RATE_LIMITED'));
  }finally{await monitor.close();store.close();await browser.close();rmSync(root,{recursive:true,force:true});}
});

for(const challenged of [false,true])test(`PlayFootball ${challenged?'XHR challenge':'HTTP 429'} stops both venue requests without a timeout reopen`,async t=>{
  const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true});
  const root=mkdtempSync(join(tmpdir(),'pitch-pf-load-'));const store=new Store(':memory:');const monitor=new Monitor(store,root);
  const session=monitor.sessions.get('playfootball')!;let navigations=0;
  const day=targetDates(store.policy())[0];const date=new Date(day+'T12:00:00Z');
  const weekFrom=new Date(weekStart(day)+'T12:00:00Z');const weekTo=new Date(addDays(weekStart(day),6)+'T12:00:00Z');
  const month=new Intl.DateTimeFormat('en-GB',{month:'short',timeZone:'UTC'}).format(weekTo);
  const weekday=new Intl.DateTimeFormat('en-GB',{weekday:'short',timeZone:'UTC'}).format(date);
  store.savePolicy({...store.policy(),lookahead:null,dateFrom:day,dateTo:day});
  try{
    const context=await browser.newContext();t.mock.method(chromium,'launchPersistentContext',async()=>context);
    session.webAction=async action=>action();
    await context.route('https://www.playfootball.net/**',async route=>{
      if(!route.request().isNavigationRequest())return route.fulfill({status:challenged?403:429,headers:challenged?{'cf-mitigated':'challenge'}:{'retry-after':'1800'},body:'fixture limited response'});
      navigations++;
      await route.fulfill({contentType:'text/html',body:`
        <div class="bookings-calendar">
          <div class="bookings-calendar-date"><button class="bookings-calendar-picker">${weekFrom.getUTCDate()} - ${weekTo.getUTCDate()} ${month}</button></div>
          <div class="bookings-calendar-weekday">${weekday} ${date.getUTCDate()}</div>
          <div class="bookings-calendar-scroll-calendar-content-wrapper"><div class="booking-slot"><button>18:00<br>60 min<br>£85.00</button></div><div class="clearfix"></div></div>
        </div>`});
    });
    const page=await session.page(resources[2]);
    await page.evaluate(async()=>{await fetch('/fixture-calendar').catch(()=>{});});
    // Keep the loaded calendar at the real monitor seam, without an additional navigation.
    const loadedPage=session.page.bind(session);session.page=async resource=>resource.id==='westferry-5'?page:loadedPage(resource);
    const started=Date.now();await monitor.scan('playfootball');
    assert.equal(navigations,1,'do not request the other venue after a first-party block');
    if(challenged){
      assert.equal(session.mode,'MANUAL_CONTROL');assert.equal(session.needsHumanVerification,true);
      session.lastManualActivityAt=Date.now()-61000;
      assert.equal(await session.resumeAfterInactivity(),false,'the old calendar is not proof that the challenged XHR recovered');
      await page.reload();session.nextIdleCheckAt=0;
      assert.equal(await session.resumeAfterInactivity(),true,'a fresh readable document can resume after the human-owned phase');
    }else{
      assert.equal(session.mode,'AUTOMATION');assert.ok(session.nextScanAt>=started+1800000,'respect the server Retry-After');
      await monitor.scan('playfootball');assert.equal(navigations,1,'an explicit scan must also respect Retry-After');
      assert.ok(store.eventPage({provider:'playfootball'}).items.some(row=>row.code==='RATE_LIMITED'&&row.details.status===429&&row.details.responseType==='fetch'));
    }
  }finally{await monitor.close();store.close();await browser.close();rmSync(root,{recursive:true,force:true});}
});
