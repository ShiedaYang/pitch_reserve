import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {ProviderSession,queueBrowserLaunch} from '../src/browser.ts';
import {Monitor} from '../src/monitor.ts';
import {Store} from '../src/store.ts';
import {resources} from '../src/domain.ts';

function idle(){const session=new ProviderSession('council','.local/test-unused');session.mode='MANUAL_CONTROL';session.lastManualActivityAt=1000;session.check=async()=>{session.status='AUTHENTICATED';return session.status;};return session;}
test('manual control resumes after one idle minute, while new activity, explicit pause and busy work retain control',async()=>{
 const session=idle();assert.equal(await session.resumeAfterInactivity(60999),false);assert.equal(session.mode,'MANUAL_CONTROL');
 session.recordManualActivity(50000);assert.equal(await session.resumeAfterInactivity(61000),false);assert.equal(await session.resumeAfterInactivity(110000),true);assert.equal(session.mode,'AUTOMATION');
 session.mode='PAUSED';assert.equal(await session.resumeAfterInactivity(10000000000000),false);assert.equal(session.mode,'PAUSED');
 const busy=idle();busy.job=Promise.resolve();assert.equal(await busy.resumeAfterInactivity(61000),false);assert.equal(busy.mode,'MANUAL_CONTROL');
});
test('an operation or pause arriving during the idle check wins over automatic resumption',async()=>{
 const session=idle();session.check=async()=>{session.recordManualActivity(61000);return session.status='AUTHENTICATED';};
 assert.equal(await session.resumeAfterInactivity(61000),false);assert.equal(session.mode,'MANUAL_CONTROL');
 session.check=async()=>{session.mode='PAUSED';return session.status='AUTHENTICATED';};session.lastManualActivityAt=1000;
 assert.equal(await session.resumeAfterInactivity(61000),false);assert.equal(session.mode,'PAUSED');
});
test('CAPTCHA and missing login credentials keep manual control; failed checks are retried at a bounded rate',async()=>{
 const session=idle();session.check=async()=>{session.needsHumanVerification=true;return session.status='LOGIN_REQUIRED';};assert.equal(await session.resumeAfterInactivity(61000),false);
 session.needsHumanVerification=false;session.nextIdleCheckAt=0;session.check=async()=>session.status='LOGIN_REQUIRED';assert.equal(await session.resumeAfterInactivity(61000),false);
 let checks=0;session.nextIdleCheckAt=0;session.check=async()=>{checks++;throw new Error('fixture');};await session.resumeAfterInactivity(61000);await session.resumeAfterInactivity(70000);assert.equal(checks,1);
});
test('the monitor automatically resumes and scans an idle authenticated Council session without a resume click',async()=>{
 const store=new Store(':memory:');const monitor=new Monitor(store,'.local/test-unused');const scanned:string[]=[];
 try{for(const session of monitor.sessions.values())session.mode='PAUSED';const council=monitor.sessions.get('council')!;council.mode='MANUAL_CONTROL';council.lastManualActivityAt=Date.now()-60001;council.check=async()=>council.status='AUTHENTICATED';
 monitor.scan=async id=>{scanned.push(id);monitor.sessions.get(id)!.nextScanAt=Date.now()+60000;};await monitor.tick();assert.deepEqual(scanned,['council']);assert.equal(council.mode,'AUTOMATION');assert.equal(store.policy().autoHold,false);
 }finally{store.close();}
});
test('trusted activity in an official iframe updates the idle clock without reading input values; synthetic events do not',async()=>{
 const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true});
 try{const context=await browser.newContext();const session=idle();await session.trackManualActivity(context);
 await context.route('https://activity.example.invalid/**',route=>route.fulfill({contentType:'text/html',body:route.request().url().endsWith('/frame')?'<input type="text">':'<iframe src="/frame"></iframe>'}));
 const page=await context.newPage();await page.goto('https://activity.example.invalid/');const frame=page.frames()[1];await frame.locator('input').waitFor();
 await frame.evaluate(()=>document.querySelector('input')!.dispatchEvent(new Event('input',{bubbles:true})));await page.waitForTimeout(200);assert.equal(session.lastManualActivityAt,1000);
 await frame.locator('input').fill('fixture-private-never-collected');for(let i=0;i<20&&session.lastManualActivityAt===1000;i++)await page.waitForTimeout(50);assert.ok(session.lastManualActivityAt>1000);
 }finally{await browser.close();}
});


test('browser startup is serialized across providers and one failed launch does not block the rest',async()=>{
 let active=0,max=0;const order:number[]=[];const launch=(id:number,fail=false)=>queueBrowserLaunch(async()=>{active++;max=Math.max(max,active);order.push(id);try{await new Promise(resolve=>setTimeout(resolve,10));if(fail)throw new Error('fixture launch failure');return id;}finally{active--;}});
 const results=await Promise.allSettled([launch(1,true),launch(2),launch(3)]);assert.equal(max,1);assert.deepEqual(order,[1,2,3]);assert.equal(results[0].status,'rejected');assert.equal(results[1].status,'fulfilled');assert.equal(results[2].status,'fulfilled');assert.equal(await launch(4),4);
});


test('transient browser failures remain automatic and retry in a minute instead of waiting the full scan interval',async t=>{
 const store=new Store(':memory:');const monitor=new Monitor(store,'.local/test-unused');const session=monitor.sessions.get('council')!;t.mock.method(console,'error',()=>{});session.page=async()=>{throw new Error('fixture browser startup failure');};const started=Date.now();
 try{await monitor.scan('council');assert.equal(session.mode,'AUTOMATION');assert.ok(session.nextScanAt>=started+60000&&session.nextScanAt<=Date.now()+60000);assert.equal(store.latest(resources[1].id)!.result.status,'ERROR');assert.match(store.latest(resources[1].id)!.result.summary,/暂无信息.*1分钟后自动重试/);
 }finally{store.close();}
});
