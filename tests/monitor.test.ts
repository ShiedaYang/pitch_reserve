import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { initialPolicy, isCandidate, londonDate, resources, targetDates, weekStart } from '../src/domain.ts';
import { mapCalendar, readCalendar, scanPlayFootball } from '../src/adapters/playfootball.ts';
import { scanCouncil } from '../src/adapters/council.ts';
import { ProviderSession, Interrupted } from '../src/browser.ts';
import { Store } from '../src/store.ts';
import {Monitor} from '../src/monitor.ts';

test('London dates keep weekday and weekly grouping across the October clock change', () => {
  assert.equal(londonDate(new Date('2026-10-24T23:30:00Z')), '2026-10-25');
  assert.equal(londonDate(new Date('2026-10-26T00:30:00Z')), '2026-10-26');
  const dates = targetDates({ ...initialPolicy(), dateFrom: '2026-10-22', dateTo: '2026-10-28' }, '2026-10-22');
  assert.deepEqual(dates, ['2026-10-22','2026-10-26','2026-10-27','2026-10-28']);
  assert.equal(weekStart('2026-10-25'), '2026-10-19');
  assert.equal(weekStart('2026-10-26'), '2026-10-26');
  assert.deepEqual(targetDates({...initialPolicy(),dateFrom:'2026-10-15',dateTo:'2026-10-15'},'2026-10-15',new Date('2026-10-15T17:01:00Z')),[]);
});
test('half-hour grid keeps 18:00 and excludes nearby inventory and 18:30', () => {
  const observations = mapCalendar({ label:'26th - 1st Nov', headers:['Mon 26th','Tue 27th'], rows:[['18:00\nAvailable nearby','18:30\n60 min\n£70.00'],['18:00\n60 min\n£70.00']] }, resources[3], '2026-10-15');
  assert.equal(observations.length, 2);
  assert.equal(isCandidate(observations[0]), false);
  assert.equal(isCandidate(observations[1]), true);
  assert.equal(observations[1].date, '2026-10-27');
  assert.throws(() => mapCalendar({ label:'Oct', headers:['Mon 26th'], rows:[] }, resources[3], '2026-10-15'), /不一致/);
});
test('handoff cancels automated steps and waits for the in-flight work to drain', async () => {
  const session = new ProviderSession('ggcb', '.local/test-unused');
  let finish!: () => void; const blocked = new Promise<void>(resolve => { finish = resolve; });
  let navigated = false;
  const task = session.exclusive(async () => { await blocked; session.assertAutomatic(); navigated = true; });
  session.mode = 'MANUAL_CONTROL'; finish();
  await assert.rejects(task, Interrupted); assert.equal(navigated, false); assert.equal(session.job, undefined);
  session.mode = 'AUTOMATION'; await session.exclusive(async () => {});
});
test('read-only calendar scan never follows a bookable slot and maps actual DOM row boundaries', async () => {
  const browser = await chromium.launch({ channel:'msedge', headless:true, chromiumSandbox:true, timeout:30000 });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="bookings-calendar"><div class="bookings-calendar-date"><button class="bookings-calendar-picker">12th - 18th Oct</button><button disabled><svg data-icon="chevron-right"></svg></button></div><div class="bookings-calendar-weekday">Thu<br>15th</div><div class="bookings-calendar-weekday">Fri<br>16th</div><div class="bookings-calendar-scroll-calendar-content-wrapper"><div class="booking-slot"><button onclick="document.body.dataset.booked='yes'">18:00<br>60 min<br>£75.00</button></div><div class="clearfix"></div><div class="booking-slot">18:00<br>Booked</div><div class="clearfix"></div></div></div>`);
    const snapshot = await readCalendar(page); assert.equal(snapshot.rows.length, 2);
    assert.equal(mapCalendar(snapshot, resources[2], '2026-10-15')[0].availability, 'AVAILABLE');
    const session = new ProviderSession('playfootball', '.local/test-unused');
    const result = await scanPlayFootball(page, resources[2], { ...initialPolicy(), dateFrom:'2026-10-15', dateTo:'2026-10-15' }, session,'2026-10-15');
    assert.equal(result.observations[0].start, '18:00');
    assert.equal(await page.locator('body').getAttribute('data-booked'), null);
  } finally { await browser.close(); }
});
test('SQLite keeps latest results and cannot enable automatic holds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pitch-test-')); const store = new Store(join(dir, 'test.sqlite'));
  try {
    store.savePolicy({ ...initialPolicy(), autoHold:true } as never); assert.equal(store.policy().autoHold, false);
    store.saveScan(resources[0], { status:'ERROR', observations:[], coverage:[{date:'2026-10-15',status:'UNKNOWN',note:'failure'}], summary:'查询失败' });
    assert.equal(store.latest(resources[0].id)?.result.coverage[0].status, 'UNKNOWN');
  } finally { store.close(); rmSync(dir, { recursive:true, force:true }); }
});

test('slot handoff only opens a fixed resource entry from a current available observation',async()=>{
  const store=new Store(':memory:');const monitor=new Monitor(store,'.local/test-unused');const opened:string[]=[];
  try {
    const session=monitor.sessions.get('playfootball')!;session.manual=async url=>{session.mode='MANUAL_CONTROL';opened.push(url!);};
    await assert.rejects(monitor.openSlot(resources[3].id,'2026-11-05','18:00'),/观察已更新/);
    store.saveScan(resources[3],{status:'PARTIAL',coverage:[],observations:[{resourceId:resources[3].id,date:'2026-11-05',start:'18:00',availability:'AVAILABLE',duration:60,price:'£110.00',note:'fixture',bookingUrl:'https://untrusted.example.invalid/checkout'}],summary:'fixture'});
    await assert.rejects(monitor.openSlot('https://untrusted.example.invalid','2026-11-05','18:00'),/不存在/);
    const result=await monitor.openSlot(resources[3].id,'2026-11-05','18:00');assert.equal(result.url,resources[3].url);assert.deepEqual(opened,[resources[3].url]);assert.equal(session.mode,'MANUAL_CONTROL');assert.equal(store.policy().autoHold,false);
  }finally{store.close();}
});

test('Council address editor pauses monitoring without changing or submitting personal fields', async () => {
  const browser = await chromium.launch({ channel:'msedge', headless:true, chromiumSandbox:true, timeout:30000 });
  try {
    const context = await browser.newContext(); let navigations=0;
    await context.route(resources[1].url,route=>{navigations++;return route.fulfill({contentType:'text/html',body:'<iframe></iframe>'});});
    const page = await context.newPage(); await page.goto(resources[1].url);
    const frame = page.frames()[1];
    await frame.setContent(`<form onsubmit="event.preventDefault();document.body.dataset.submitted='yes'">
      <select id="addressSelector" required><option value="">Select…</option></select>
      <input type="checkbox" id="addressMissing-0" onchange="document.querySelector('fieldset').hidden=!this.checked">
      <fieldset hidden><input id="manual_addressLine1" value="fixture street"><input id="manual_townCity" value="fixture town"><input id="manual_postcode" value="fixture postcode"></fieldset>
      <button hidden>Update Record</button><button>Next</button></form>`);
    const gate = await context.newPage(); await gate.goto(resources[1].url);
    const session = new ProviderSession('council', '.local/test-unused'); session.context=context; session.manualPage = gate;
    assert.equal(await session.page(resources[1]),page); assert.equal(navigations,2);
    const policy = initialPolicy();
    const first = await scanCouncil(page,policy,session);
    assert.equal(session.mode,'MANUAL_CONTROL'); assert.match(first.summary,/未勾选/);
    assert.deepEqual(first.form?.actions.map(action=>action.label),['Next']);
    assert.equal(await frame.locator('#addressMissing-0').isChecked(),false);
    assert.equal(await frame.locator('#manual_addressLine1').inputValue(),'fixture street');
    await frame.locator('#addressMissing-0').check(); session.mode='AUTOMATION';
    const second = await scanCouncil(page,policy,session);
    session.mode='AUTOMATION'; assert.equal(await session.page(resources[1]),page); assert.equal(navigations,2); session.mode='MANUAL_CONTROL';
    assert.equal(session.mode,'MANUAL_CONTROL'); assert.match(second.summary,/必填项已填写/);
    assert.ok(!second.summary.includes('fixture')); assert.deepEqual(second.observations,[]);
    assert.equal(await frame.locator('body').getAttribute('data-submitted'),null);
    await frame.locator('form').evaluate(el=>(el as HTMLElement).hidden=true); session.mode='AUTOMATION';
    const hidden = await scanCouncil(page,policy,session);
    assert.equal(session.mode,'MANUAL_CONTROL'); assert.ok(!hidden.summary.includes('地址下拉框'));
  } finally { await browser.close(); }
});
