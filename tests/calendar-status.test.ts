import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {Store} from '../src/store.ts';
import {Monitor} from '../src/monitor.ts';
import type {Coverage,Observation,ScanResult} from '../src/domain.ts';

test('calendar distinguishes unverified, unreleased and failed dates while keeping confirmed observations',async()=>{
  const store=new Store(':memory:');const state=new Monitor(store,'.local/test-unused').state();
  state.today='2026-10-27';state.policy={...state.policy,dateFrom:'2026-11-02',dateTo:'2026-11-04',lookahead:null};
  const [first,second,third]=['2026-11-02','2026-11-03','2026-11-04'];
  const coverage=(date:string,status:Coverage['status']):Coverage=>({date,status,note:'fixture coverage'});
  const observation=(index:number,date:string,availability:Observation['availability']):Observation=>({resourceId:state.resources[index].id,date,start:'18:00',duration:60,availability,price:availability==='AVAILABLE'?'£90.00':null,note:'fixture observation'});
  const latest=(status:ScanResult['status'],coverage:Coverage[],observations:Observation[]=[])=>({at:'2026-10-27T12:00:00Z',result:{status,coverage,observations,summary:'fixture'}});
  state.resources[0].latest=null;
  state.resources[1].latest=latest('ERROR',[coverage(first,'OUTSIDE_RELEASE_WINDOW'),coverage(second,'UNKNOWN'),coverage(third,'READ')],[observation(1,third,'BOOKED')]);
  state.resources[2].latest=latest('PARTIAL',[coverage(first,'ERROR'),coverage(second,'READ'),coverage(third,'READ')],[observation(2,second,'AVAILABLE'),observation(2,third,'UNKNOWN')]);
  state.resources[3].latest=latest('PARTIAL',[coverage(first,'READ'),coverage(second,'UNKNOWN'),coverage(third,'READ')],[observation(3,first,'UNAVAILABLE'),observation(3,third,'BOOKED')]);
  const assets=new Map(await Promise.all(['index.html','app.js','style.css'].map(async name=>['/'+name,await readFile(new URL('../public/'+name,import.meta.url),'utf8')] as const)));
  const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:900}});const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('http://console.example.invalid/**',route=>{
      const path=new URL(route.request().url()).pathname;
      if(path==='/api/state')return route.fulfill({json:state});
      if(path.startsWith('/api/'))return route.fulfill({json:{ok:true,items:[],nextCursor:null}});
      const asset=path==='/'?'/index.html':path;const body=assets.get(asset);
      return route.fulfill({status:body?200:404,body:body||'',contentType:asset.endsWith('.js')?'text/javascript':asset.endsWith('.css')?'text/css':'text/html'});
    });
    await page.goto('http://console.example.invalid/');await page.locator('tr[data-date-row]').last().waitFor();
    const cell=(date:string,index:number)=>page.locator(`tr[data-date-row="${date}"] td`).nth(index).locator('.cell');
    assert.equal(await cell(first,0).innerText(),'暂未核实');assert.equal(await cell(first,0).getAttribute('class'),'cell unknown');
    assert.match(await cell(first,1).innerText(),/^暂无信息/);assert.equal(await cell(first,1).getAttribute('class'),'cell unreleased');
    for(const [date,index] of [[first,2],[second,1]] as const){assert.equal(await cell(date,index).innerText(),'查询失败');assert.equal(await cell(date,index).getAttribute('class'),'cell query-error');}
    assert.equal(await cell(third,2).innerText(),'暂未核实');assert.equal(await cell(second,3).innerText(),'暂未核实');
    assert.equal(await cell(first,3).innerText(),'暂无可选时段');assert.equal(await cell(first,3).getAttribute('class'),'cell unavailable');
    assert.equal(await cell(third,1).innerText(),'18:00 不可订');assert.equal(await cell(third,1).getAttribute('class'),'cell booked');
    assert.equal(await cell(second,2).locator('.slot-price').innerText(),'£90.00');assert.equal(await cell(second,2).getAttribute('href'),state.resources[2].url);
    assert.equal(await cell(first,0).evaluate(el=>getComputedStyle(el).color),'rgb(133, 90, 25)');
    assert.equal(await cell(first,1).evaluate(el=>getComputedStyle(el).color),'rgb(103, 115, 130)');
    assert.equal(await cell(first,2).evaluate(el=>getComputedStyle(el).color),'rgb(161, 52, 52)');
    await mkdir('.local/artifacts',{recursive:true});await page.screenshot({path:'.local/artifacts/calendar-status-desktop.png'});
    for(const width of [650,390,320]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
    await page.screenshot({path:'.local/artifacts/calendar-status-mobile.png'});
    state.resources[0].latest=latest('LOGIN_REQUIRED',[coverage(first,'UNKNOWN')]);
    state.providers.find(provider=>provider.id==='playfootball')!.attention={kind:'TIMEOUT',message:'fixture timeout',at:'2026-10-27T12:00:00Z'};
    await page.reload();await cell(first,0).waitFor();
    assert.equal(await cell(first,0).innerText(),'暂未核实');
    assert.equal(await cell(second,3).innerText(),'查询失败');
    assert.equal(await cell(second,2).locator('.slot-price').innerText(),'£90.00');assert.equal(await cell(third,3).innerText(),'18:00 不可订');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();store.close();}
});
