import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {Store} from '../src/store.ts';
import {Monitor} from '../src/monitor.ts';
import {resources} from '../src/domain.ts';
import {authSignals} from '../src/auth.ts';

test('a repeated navigation timeout reopens once and then requests manual takeover',async t=>{
  const store=new Store(':memory:');const monitor=new Monitor(store,'.local/test-unused');const session=monitor.sessions.get('playfootball')!;
  let attempts=0,reopened=0;t.mock.method(console,'error',()=>{});
  session.page=async()=>{attempts++;const error=new Error('fixture navigation timeout');error.name='TimeoutError';throw error;};
  (session as any).reopenResource=async()=>{reopened++;};
  try{await monitor.scan('playfootball');assert.equal(attempts,2);assert.equal(reopened,1);assert.equal(session.mode,'MANUAL_CONTROL');assert.match(store.latest(resources.find(r=>r.id==='westferry-5')!.id)!.result.summary,/请手动接管/);assert.match(store.latest('poplar-7')!.result.summary,/尚未查询.*人工接管/);assert.ok(['westferry-5','poplar-7'].every(id=>store.latest(id)!.result.coverage.every(row=>row.status==='ERROR')));const events=store.eventPage({provider:'playfootball'}).items;const retry=events.find(row=>row.stage==='RETRY')!,error=events.find(row=>row.level==='ERROR'&&row.stage==='OPEN_PAGE')!;assert.ok(retry.runId);assert.equal(error.runId,retry.runId);assert.equal(error.details.attempt,2);assert.equal(error.code,'TIMEOUT');assert.ok(error.details.remedy);assert.equal(events.find(row=>row.stage==='SCAN_COMPLETE')!.details.readDays,0);}
  finally{store.close();}
});

test('Cloudflare stops the shared provider without refreshing and idle recovery waits for a readable page',async()=>{
  const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true});
  try{const page=await browser.newPage();await page.route('https://www.playfootball.net/**',route=>route.fulfill({contentType:'text/html',body:'<title>Just a moment...</title><h1>www.playfootball.net</h1><div id="cf-chl-widget">Verifying you are human. This may take a few seconds.</div>'}));await page.goto('https://www.playfootball.net/venues/canary-wharf/book-a-pitch/85/5-a-Side3GPitchHire');assert.equal((await authSignals(page,'playfootball')).challenge,true);
    const store=new Store(':memory:');const monitor=new Monitor(store,'.local/test-unused');const session=monitor.sessions.get('playfootball')!;session.context=page.context();session.page=async()=>page;let reopened=0;session.reopenResource=async()=>{reopened++;};
    try{await monitor.scan('playfootball');assert.equal(session.mode,'MANUAL_CONTROL');assert.equal(reopened,0);assert.equal(store.incidents.list(true).length,1);assert.match(store.latest('poplar-7')!.result.summary,/等待人工接管/);session.lastManualActivityAt=Date.now()-61000;assert.equal(await session.resumeAfterInactivity(),false);await page.setContent('<title>Pitch calendar</title><div class="bookings-calendar-date">November</div>');session.nextIdleCheckAt=0;assert.equal(await session.resumeAfterInactivity(),true);assert.equal(session.mode,'AUTOMATION');}
    finally{store.close();}}
  finally{await browser.close();}
});
