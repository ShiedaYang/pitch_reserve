import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import type {BrowserContext} from 'playwright';
import {ProviderSession,Interrupted} from '../src/browser.ts';
import {resources,loginUrls,initialPolicy} from '../src/domain.ts';
import {scanPlayFootball} from '../src/adapters/playfootball.ts';

function fakeClock(){
  let time=0;const waits:number[]=[];
  return {now:()=>time,sleep:async(ms:number)=>{waits.push(ms);time+=ms;},advance:(ms:number)=>{time+=ms;},waits};
}
function fixture(clock:ReturnType<typeof fakeClock>){
  const actions:Array<{kind:string;at:number;end:number}>=[];
  const context={newPage:async()=>({
    isClosed:()=>false,
    goto:async()=>{const at=clock.now();clock.advance(250);actions.push({kind:'goto',at,end:clock.now()});},
    close:async()=>{actions.push({kind:'close',at:clock.now(),end:clock.now()});}
  })} as unknown as BrowserContext;
  const session=new ProviderSession('playfootball','.local/test-unused',undefined,clock);
  session.getContext=async()=>context;
  return {session,actions};
}

test('PlayFootball shares a ten-second completion gap across both venues and timeout reopen actions',async()=>{
  const clock=fakeClock();const {session,actions}=fixture(clock);
  await session.page(resources[2]);await session.page(resources[3]);
  await session.reopenResource(resources[3]);await session.page(resources[3]);
  assert.deepEqual(actions.map(action=>action.kind),['goto','goto','close','goto']);
  for(let i=1;i<actions.length;i++)assert.ok(actions[i].at-actions[i-1].end>=10000,JSON.stringify(actions));
  assert.equal(actions[0].at,0,'the first operation needs no artificial startup delay');
});

test('a takeover cancels a queued PlayFootball navigation even after a quick return to automation',async()=>{
  const clock=fakeClock();const {session,actions}=fixture(clock);
  await session.page(resources[2]);
  clock.sleep=async()=>{session.mode='MANUAL_CONTROL';session.mode='AUTOMATION';};
  await assert.rejects(session.page(resources[3]),Interrupted);
  assert.equal(actions.length,1,'the waiting operation must never navigate after control changes');
  const existing=session.pages.get(resources[2].id);
  await assert.rejects(session.reopenResource(resources[2]),Interrupted);
  assert.equal(session.pages.get(resources[2].id),existing,'cancelled close must retain the page for takeover');
});

test('failed PlayFootball operations still leave a ten-second retry gap and other providers stay immediate',async()=>{
  const clock=fakeClock();const session=new ProviderSession('playfootball','.local/test-unused',undefined,clock);
  await assert.rejects(session.webAction(async()=>{clock.advance(300);throw new Error('fixture failure');}),/fixture failure/);
  let retriedAt=0;await session.webAction(async()=>{retriedAt=clock.now();});assert.equal(retriedAt,10300);
  for(const provider of ['ggcb','council'] as const){
    const otherClock=fakeClock();const other=new ProviderSession(provider,'.local/test-unused',undefined,otherClock);
    await other.webAction(async()=>{});await other.webAction(async()=>{});assert.deepEqual(otherClock.waits,[]);
  }
});

test('PlayFootball login spaces navigation, panel, both fields and submit without real-time sleeps',async()=>{
  const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true,timeout:30000});
  const clock=fakeClock();let postedAt=-1;let posts=0;
  try{
    const context=await browser.newContext();
    await context.route('**/*',route=>{
      if(route.request().method()==='POST'){
        posts++;postedAt=clock.now();const data=new URLSearchParams(route.request().postData()||'');
        assert.equal(data.get('Email'),'fixture@example.invalid');assert.equal(data.get('password'),'fixture-secret');
        return route.fulfill({contentType:'text/html',body:'<a href="/logout">Log out</a>'});
      }
      return route.fulfill({contentType:'text/html',body:`<a role="button" href="#log-in-bar" onclick="event.preventDefault();document.getElementById('log-in-bar').hidden=false">Account</a><div id="log-in-bar" hidden><form method="post" action="/session"><input type="email" name="Email"><input type="password" name="password"><button>Log In</button></form></div>`});
    });
    const session=new ProviderSession('playfootball','.local/test-unused',undefined,clock);session.context=context;session.saveSession=async()=>{};
    const result=await session.signIn({username:'fixture@example.invalid',password:'fixture-secret'});
    assert.equal(result.kind,'AUTHENTICATED');assert.equal(posts,1);assert.ok(postedAt>=40000,`submit at ${postedAt}`);
    assert.equal(session.loginPage?.url(),new URL('/session',loginUrls.playfootball).href);
    const pausedClock=fakeClock();const paused=new ProviderSession('playfootball','.local/test-unused',undefined,pausedClock);
    paused.context=context;paused.saveSession=async()=>{};
    pausedClock.sleep=async()=>{paused.mode='PAUSED';paused.mode='MANUAL_CONTROL';};
    await assert.rejects(paused.signIn({username:'fixture@example.invalid',password:'fixture-secret'}),Interrupted);
    assert.equal(posts,1,'a control change while waiting must not submit a stale login');
    assert.equal(await paused.loginPage!.locator('input[type=password]').inputValue(),'');
  }finally{await browser.close();}
});

test('calendar cookie dismissal and week navigation use the shared gap and never select a slot',async t=>{
  const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true,timeout:30000});
  const clock=fakeClock();const starts:number[]=[];
  try{
    const context=await browser.newContext();
    await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:`
      <button onclick="this.remove()">Reject optional cookies</button>
      <div class="bookings-calendar">
        <div class="bookings-calendar-date">
          <button class="bookings-calendar-picker">2nd - 8th Nov</button>
          <button id="next" onclick="document.querySelector('.bookings-calendar-picker').innerText='9th - 15th Nov';document.querySelector('.bookings-calendar-weekday').innerText='Mon 9th';this.disabled=true"><svg data-icon="chevron-right"></svg></button>
        </div>
        <div class="bookings-calendar-weekday">Mon 2nd</div>
        <div class="bookings-calendar-scroll-calendar-content-wrapper">
          <div class="booking-slot"><button onclick="document.body.dataset.booked='yes'">18:00<br>60 min<br>£85.00</button></div><div class="clearfix"></div>
        </div>
      </div>`}));
    const session=new ProviderSession('playfootball','.local/test-unused',undefined,clock);session.context=context;
    const run=session.webAction.bind(session);
    session.webAction=<T>(action:()=>Promise<T>,guard?:()=>void)=>run(async()=>{starts.push(clock.now());return action();},guard);
    const page=await session.page(resources[2]);
    const result=await scanPlayFootball(page,resources[2],{...initialPolicy(),dateFrom:'2026-11-02',dateTo:'2026-11-10'},session,'2026-10-15');
    assert.deepEqual(starts,[0,10000,20000]);
    assert.deepEqual(result.observations.map(row=>row.date),['2026-11-02','2026-11-09']);
    assert.ok(result.observations.every(row=>row.price==='£85.00'));
    assert.equal(await page.locator('body').getAttribute('data-booked'),null);
    await page.goto(resources[2].url);
    t.mock.method(page,'waitForFunction',async()=>{throw new Error('fixture week timeout');});
    const partial=await scanPlayFootball(page,resources[2],{...initialPolicy(),dateFrom:'2026-11-02',dateTo:'2026-11-10'},session,'2026-10-15');
    assert.equal(partial.coverage.find(day=>day.date==='2026-11-02')?.status,'READ');
    assert.equal(partial.coverage.find(day=>day.date==='2026-11-09')?.status,'ERROR');
    assert.equal(partial.observations[0].price,'£85.00');
  }finally{await browser.close();}
});
