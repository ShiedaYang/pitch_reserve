import type { Page } from 'playwright';
import {londonDate,targetDates} from '../domain.ts';
import type {Coverage,Observation,Policy,Resource,ScanResult} from '../domain.ts';
import type {ProviderSession} from '../browser.ts';
import {ggcbReleaseDate,isGgcbDayResponse,navigateGgcbMonth,quoteGgcb} from './ggcb-calendar.ts';

export interface GgcbOptions {today?:string;calendarTimeout?:number;responseTimeout?:number;}
export async function scanGgcb(page:Page,resource:Resource,policy:Policy,session:ProviderSession,options:GgcbOptions={}):Promise<ScanResult> {
  const today=options.today||londonDate();const wanted=targetDates(policy,today,options.today?new Date(`${today}T12:00:00Z`):new Date());const coverage=new Map<string,Coverage>();const observations:Observation[]=[];
  const form=page.locator('#wc-bookings-booking-form');await form.waitFor();
  const ruleVerified=/dates for the following month are only released 7 days prior/i.test(await page.locator('body').innerText());
  for(const date of wanted)if(ruleVerified && ggcbReleaseDate(date)>today)coverage.set(date,{date,status:'OUTSIDE_RELEASE_WINDOW',note:`官网次月提前7天放号，预计${ggcbReleaseDate(date)}开放；以官网实际放号为准`});
  const openDates=wanted.filter(date=>!coverage.has(date));const months=Array.from(new Set(openDates.map(date=>date.slice(0,7))));const visited:string[]=[];
  let failures=0;
  for(const month of months) {
    let ready=false;
    for(let attempt=0;attempt<2;attempt++) {
      session.assertAutomatic();
      try {
        if(attempt) {await page.reload({waitUntil:'domcontentloaded'});session.assertAutomatic();}
        await navigateGgcbMonth(page,month,()=>session.assertAutomatic(),options.calendarTimeout||15000);ready=true;break;
      }catch {session.assertAutomatic();}
    }
    if(!ready) {failures++;for(const date of openDates.filter(date=>date.startsWith(month)))coverage.set(date,{date,status:'ERROR',note:'月份请求未完成，已有限重试；未使用旧月份结果'});continue;}
    visited.push(month);
    const cells=await form.locator('td[class*="date-year-"]').evaluateAll(elements=>elements.map(el=>{
      const cls=el.className;const year=cls.match(/date-year-(\d+)/)?.[1];const month=cls.match(/date-month-(\d+)/)?.[1];const day=cls.match(/date-date-(\d+)/)?.[1];
      return {date:year&&month&&day?`${year}-${String(Number(month)+1).padStart(2,'0')}-${day.padStart(2,'0')}`:'',bookable:el.classList.contains('bookable')};
    }));
    for(const date of openDates.filter(date=>date.startsWith(month))) {
      session.assertAutomatic();const cell=cells.find(cell=>cell.date===date);
      if(!cell?.bookable) {coverage.set(date,{date,status:'UNKNOWN',note:'官网日期不可选择，尚未区分售罄或关闭'});continue;}
      const day=new Date(`${date}T12:00:00Z`);const link=form.locator(`td.date-year-${day.getUTCFullYear()}.date-month-${day.getUTCMonth()}.date-date-${day.getUTCDate()} a`);
      if(await link.count()!==1 || !await link.isVisible()) {coverage.set(date,{date,status:'ERROR',note:'日期标为可订但缺少可见日期按钮'});continue;}
      const response=page.waitForResponse(response=>isGgcbDayResponse(response,date),{timeout:options.responseTimeout||12000}).catch(()=>null);
      let stage='日期点击';
      try {
        await link.click();stage='对应日期响应';const loaded=await response;session.assertAutomatic();
        if(!loaded?.ok())throw new Error('Day response not confirmed');
        await loaded.finished();stage='时段加载遮罩';
        await page.waitForFunction(()=>!Array.from(document.querySelectorAll('#wc-bookings-booking-form .block-picker')).some(el=>Array.from(el.closest('div')?.querySelectorAll('.blockOverlay')||[]).some(overlay=>overlay.getBoundingClientRect().height>0 && getComputedStyle(overlay).display!=='none')),undefined,{timeout:options.calendarTimeout||15000});
        session.assertAutomatic();
        const times=await form.locator('.block-picker a').evaluateAll(elements=>elements.map(el=>({text:(el as HTMLElement).innerText.trim(),value:el.getAttribute('data-value')})));
        const target=times.filter(slot=>/^18:00(?:\s|$)/.test(slot.text));
        if(target.length===1) {
          const price=target[0].value?await quoteGgcb(page,target[0].value):null;session.assertAutomatic();
          observations.push({resourceId:resource.id,date,start:'18:00',duration:55,availability:'AVAILABLE',price,priceNote:price?'官网只读费用试算（未创建订单）':'官网试算未返回明确报价，需在官网核实',note:'55分钟；仅读取时间及费用，未选择时间块或Book now'});
          coverage.set(date,{date,status:'READ',note:'已读取具体18:00选项及报价状态'});
        }else if(times.length || /No blocks available/i.test(await form.locator('.block-picker').innerText())) {
          observations.push({resourceId:resource.id,date,start:'18:00',duration:55,availability:'UNAVAILABLE',price:null,note:times.length?'官网该日期可选时间列表没有18:00':'官网日期查询返回No blocks available；具体原因未说明'});
          coverage.set(date,{date,status:'READ',note:'已读取对应日期响应，当前没有18:00可选时段'});
        }else coverage.set(date,{date,status:'ERROR',note:'时段结构未识别，不推断无空位'});
      }catch {
        await response;session.assertAutomatic();coverage.set(date,{date,status:'ERROR',note:`${stage}未完成，不使用上次日期的结果`});
        try {await page.reload({waitUntil:'domcontentloaded'});session.assertAutomatic();await navigateGgcbMonth(page,month,()=>session.assertAutomatic(),options.calendarTimeout||15000);}catch {session.assertAutomatic();failures++;for(const remaining of openDates.filter(day=>day.startsWith(month)&&!coverage.has(day)))coverage.set(remaining,{date:remaining,status:'ERROR',note:'月份恢复失败，无法继续读取该日期'});break;}
      }
      await page.waitForTimeout(350);
    }
  }
  const all=wanted.map(date=>coverage.get(date)||{date,status:'UNKNOWN' as const,note:'该日期尚未完成读取'});
  const read=all.filter(day=>day.status==='READ').length;const unreleased=all.filter(day=>day.status==='OUTSIDE_RELEASE_WINDOW').length;
  return {observations,coverage:all,status:read===wanted.length?'OK':!read && failures?'ERROR':'PARTIAL',navigation:`已查询月份：${visited.join('、')||'无'}。${ruleVerified?'已核对官网提前7天放号规则；未放号月份不发起时段查询。':'放号规则未核对，未据此推算未放号日期。'}${failures?'部分月份加载失败，已有限重试。':''}`,
    summary:`已读取${read}/${wanted.length}个目标日期；${unreleased}个日期尚未放号，${all.length-read-unreleased}个日期待确认。55分钟，自动锁位关闭。`};
}
