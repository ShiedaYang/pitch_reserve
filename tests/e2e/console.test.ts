import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright';
import {Store} from '../../src/store.ts';
import {initialPolicy,resources,targetDates} from '../../src/domain.ts';

test('console E2E: real HTTP/SQLite, calendar links, saved preferences, encrypted settings and restart',{timeout:180000},async()=>{
 const cwd=resolve(import.meta.dirname,'../..');
 const root=await mkdtemp(join(tmpdir(),'pitch-e2e-'));
 const probe=createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=(probe.address() as {port:number}).port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
 const base=`http://127.0.0.1:${port}`;
 const env={...process.env,PITCH_DATA_DIR:root,PORT:String(port),PITCH_HOST:'127.0.0.1',PITCH_PUBLIC_ORIGIN:base,PITCH_LAN_CIDRS:'',PITCH_START_PAUSED:'1',PITCH_DESKTOP_UPSTREAM:'',PITCH_MANUAL_BROWSER_URL:''};
 const store=new Store(join(root,'monitor.sqlite'));const date=targetDates(initialPolicy())[0]!;
 for(const resource of resources)store.saveScan(resource,{status:'PARTIAL',summary:'E2E fixture',coverage:[{date,status:'READ',note:'fixture'}],observations:[{resourceId:resource.id,date,start:'18:00',duration:60,price:'£90.00',availability:'AVAILABLE',note:'fixture'}]});
 store.close();
 let child:ReturnType<typeof spawn>|undefined;let output='';
 const start=async()=>{
  output='';child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','scripts/start-server.ts'],{cwd,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  child.stdout?.on('data',data=>output+=data);child.stderr?.on('data',data=>output+=data);
  const deadline=Date.now()+20000;
  while(Date.now()<deadline&&child.exitCode===null){try{if((await fetch(base+'/api/state',{signal:AbortSignal.timeout(500)})).ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  assert.fail('isolated console did not start: '+output);
 };
 const stop=async()=>{
  if(!child||child.exitCode!==null)return;
  const ended=once(child,'exit');const state=await (await fetch(base+'/api/state')).json();
  assert.equal((await fetch(base+'/api/shutdown',{method:'POST',headers:{'Content-Type':'application/json','X-Console-Token':state.csrf},body:'{}'})).status,200);
  await ended;assert.equal(child.exitCode,0);
 };
 const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true});
 try{
  await start();const page=await browser.newPage();const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.context().route('https://**',route=>route.fulfill({contentType:'text/html',body:'<title>Venue fixture</title>'}));
  await page.goto(base);await page.locator('.slot-link').first().waitFor();
  assert.equal(await page.locator('.slot-link').count(),4);assert.equal(await page.locator('.slot-price').first().innerText(),'£90.00');
  const link=page.locator('.slot-link').first();const href=await link.getAttribute('href');const opened=page.context().waitForEvent('page');await link.click();const official=await opened;await official.waitForLoadState();assert.equal(official.url(),href);await official.close();
  await page.getByRole('tab',{name:'监测偏好'}).click();await page.locator('#lookahead').selectOption('14d');await page.locator('#interval').selectOption('30');await page.locator('#policy-save').click();
  await page.waitForFunction(()=>document.querySelector('#message')?.textContent?.includes('已保存'));
  const state=await (await fetch(base+'/api/state')).json();assert.equal(state.policy.lookahead,'14d');assert.equal(state.policy.intervalMinutes,30);assert.equal(state.policy.autoHold,false);assert.ok(state.policy.dateFrom>state.today);
  await page.getByRole('tab',{name:'通知列表'}).click();await page.locator('#notification-list > li').first().waitFor();assert.equal(await page.locator('#notification-list > li').count(),4);
  await page.locator('#feishu-form').evaluate(el=>el.closest('details')?.setAttribute('open',''));
  await page.locator('#feishu-app-id').fill('cli_e2e_fixture');await page.locator('#feishu-app-secret').fill('e2e-fixture-not-a-real-secret');
  await page.locator('#feishu-add-recipient').click();const recipient=page.locator('#feishu-recipients .recipient-row').last();await recipient.locator('[data-recipient-name]').fill('E2E user');await recipient.locator('[data-recipient-id]').fill('ou_e2e_fixture');
  await page.locator('#feishu-enabled').uncheck();await page.locator('#feishu-admin-enabled').uncheck();await page.locator('#feishu-save').click();
  await page.waitForFunction(()=>document.querySelector('#feishu-status')?.textContent?.includes('已保存')||document.querySelector('#feishu-error')?.textContent?.includes('已保存'));
  const saved=await (await fetch(base+'/api/state')).json();assert.equal(saved.feishu.hasSecret,true);assert.equal(saved.feishu.enabled,false);assert.equal(saved.feishu.adminEnabled,false);assert.ok(!JSON.stringify(saved).includes('e2e-fixture-not-a-real-secret'));
  assert.ok(!(await readFile(join(root,'integrations','feishu.json'),'utf8')).includes('e2e-fixture-not-a-real-secret'));
  for(const width of [1440,390,320]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
  await stop();await start();await page.reload();await page.locator('.provider').last().waitFor({state:'attached'});
  const restored=await (await fetch(base+'/api/state')).json();assert.equal(restored.policy.lookahead,'14d');assert.equal(restored.feishu.appId,'cli_e2e_fixture');assert.equal(restored.feishu.hasSecret,true);assert.equal(restored.notifications.items.length,4);assert.ok(restored.providers.every((provider:{mode:string})=>provider.mode==='PAUSED'));assert.deepEqual(errors,[]);
  await stop();
  // Keep the wider UI regression suite reproducible in CI as well. Its writes
  // and third-party navigation are mocked; the service and API guards are real.
  await start();const smoke=spawn(process.execPath,['--disable-warning=ExperimentalWarning','scripts/verify-console.ts'],{cwd,env:{...env,PITCH_CONSOLE_URL:base},stdio:['ignore','pipe','pipe'],windowsHide:true});let smokeOutput='';smoke.stdout?.on('data',data=>smokeOutput+=data);smoke.stderr?.on('data',data=>smokeOutput+=data);const [code]=await once(smoke,'exit');assert.equal(code,0,smokeOutput);await stop();
 }finally{
  await browser.close();if(child&&child.exitCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await ended;}await rm(root,{recursive:true,force:true});
 }
});
