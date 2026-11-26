import type { Page } from 'playwright';
import {londonDate,targetDates} from '../domain.ts';
import type {Coverage,Observation,Policy,Resource,ScanResult} from '../domain.ts';
import type {ProviderSession} from '../browser.ts';
import {Interrupted} from '../browser.ts';
import {diagnoseError} from '../activity-log.ts';
import type {EventContext} from '../activity-log.ts';
import {GgcbCalendarError,ggcbReleaseDate,loadGgcbDay,navigateGgcbMonth,quoteGgcb} from './ggcb-calendar.ts';

export interface GgcbOptions {today?:string;calendarTimeout?:number;responseTimeout?:number;onIssue?:(message:string,context:EventContext)=>void;}
export async function scanGgcb(page:Page,resource:Resource,policy:Policy,session:ProviderSession,options:GgcbOptions={}):Promise<ScanResult> {
  const revision=session.modeRevision;const check=()=>{session.assertAutomatic();if(session.modeRevision!==revision)throw new Interrupted('已暂停，等待人工接管');};
  const today=options.today||londonDate();const wanted=targetDates(policy,today,options.today?new Date(`${today}T12:00:00Z`):new Date());const coverage=new Map<string,Coverage>();const observations:Observation[]=[];
  const form=page.locator('#wc-bookings-booking-form');await form.waitFor();
  const ruleVerified=/dates for the following month are only released 7 days prior/i.test(await page.locator('body').innerText());
  for(const date of wanted)if(ruleVerified && ggcbReleaseDate(date)>today)coverage.set(date,{date,status:'OUTSIDE_RELEASE_WINDOW',note:`官网次月提前7天放号，预计${ggcbReleaseDate(date)}开放；以官网实际放号为准`});
  const openDates=wanted.filter(date=>!coverage.has(date));const months=Array.from(new Set(openDates.map(date=>date.slice(0,7))));const visited:string[]=[];
  let failures=0,dayRecoveries=0,stopped=false;const diagnostics:string[]=[];
  const blocked=(error:unknown)=>error instanceof GgcbCalendarError&&([403,429].includes(error.httpStatus??0)||error.code.endsWith('_VERIFICATION_REQUIRED'));
  const report=(error:unknown,stage:string,date:string,attempt:number,recoverable=false)=>{
    const issue=error instanceof GgcbCalendarError?{code:error.code,reason:error.reason,remedy:error.remedy,...(error.httpStatus?{status:error.httpStatus}:{})}:diagnoseError(error);
    const note=`${date} 第${attempt}次：${issue.code}，${issue.reason}`;diagnostics.push(note);
    options.onIssue?.(`GGCB：${note}`,{level:recoverable?'WARN':'ERROR',stage,code:issue.code,details:{...issue,attempt,dateFrom:date.length===7?`${date}-01`:date}});
    return note;
  };
  const readCells=()=>form.locator('td[class*="date-year-"]').evaluateAll(elements=>elements.map(el=>{
    const cls=el.className;const year=cls.match(/date-year-(\d+)/)?.[1];const month=cls.match(/date-month-(\d+)/)?.[1];const day=cls.match(/date-date-(\d+)/)?.[1];
    return {date:year&&month&&day?`${year}-${String(Number(month)+1).padStart(2,'0')}-${day.padStart(2,'0')}`:'',bookable:el.classList.contains('bookable')};
  }));
  for(const month of months) {
    let ready=false,lastFailure='';
    for(let attempt=0;attempt<2;attempt++) {
      check();
      try {
        if(attempt) {await page.waitForTimeout(1000);check();await page.reload({waitUntil:'domcontentloaded'});check();}
        await navigateGgcbMonth(page,month,check,Math.min(30000,(options.calendarTimeout||15000)*(attempt+1)));ready=true;break;
      }catch(error) {check();lastFailure=report(error,'MONTH_LOAD',month,attempt+1,attempt===0&&!blocked(error));if(blocked(error)){stopped=true;break;}}
    }
    if(!ready) {failures++;for(const date of openDates.filter(date=>date.startsWith(month)))coverage.set(date,{date,status:'ERROR',note:`月份请求未完成；${lastFailure}；未使用旧月份结果`});if(stopped)break;continue;}
    visited.push(month);
    let cells=await readCells();
    for(const date of openDates.filter(date=>date.startsWith(month))) {
     for(let attempt=1;attempt<=2;attempt++){
      check();const cell=cells.find(cell=>cell.date===date);
      if(!cell?.bookable) {coverage.set(date,{date,status:'UNKNOWN',note:'官网日期不可选择，尚未区分售罄或关闭'});break;}
      const day=new Date(`${date}T12:00:00Z`);const link=form.locator(`td.date-year-${day.getUTCFullYear()}.date-month-${day.getUTCMonth()}.date-date-${day.getUTCDate()} a`);
      try {
        if(await link.count()!==1 || !await link.isVisible())throw new GgcbCalendarError('DAY_STRUCTURE','日期标为可订但缺少可见日期按钮','检查官网日期结构；不推断无空位');
        await loadGgcbDay(page,date,()=>link.click({timeout:options.calendarTimeout||15000}),check,options.responseTimeout||12000,options.calendarTimeout||15000);
        const times=await form.locator('.block-picker a').evaluateAll(elements=>elements.map(el=>({text:(el as HTMLElement).innerText.trim(),value:el.getAttribute('data-value')})));
        const target=times.filter(slot=>/^18:00(?:\s|$)/.test(slot.text));
        if(target.length===1) {
          const price=target[0].value?await quoteGgcb(page,target[0].value):null;check();
          observations.push({resourceId:resource.id,date,start:'18:00',duration:55,availability:'AVAILABLE',price,priceNote:price?'官网只读费用试算（未创建订单）':'官网试算未返回明确报价，需在官网核实',note:'55分钟；仅读取时间及费用，未选择时间块或Book now'});
          coverage.set(date,{date,status:'READ',note:'已读取具体18:00选项及报价状态'});
        }else if(times.some(slot=>/^(?:[01]\d|2[0-3]):[0-5]\d(?:\s|$)/.test(slot.text)) || /No blocks available/i.test(await form.locator('.block-picker').innerText())) {
          observations.push({resourceId:resource.id,date,start:'18:00',duration:55,availability:'UNAVAILABLE',price:null,note:times.length?'官网该日期可选时间列表没有18:00':'官网日期查询返回No blocks available；具体原因未说明'});
          coverage.set(date,{date,status:'READ',note:'已读取对应日期响应，当前没有18:00可选时段'});
        }else throw new GgcbCalendarError('DAY_STRUCTURE','时段结构未识别，不推断无空位','有限恢复后重试同一日期；不读取旧时段');
        break;
      }catch(error) {
        check();const recoverable=dayRecoveries===0&&!blocked(error);
        const note=report(error,'DAY_LOAD',date,attempt,recoverable);coverage.set(date,{date,status:'ERROR',note:`${note}；不使用上次日期的结果`});
        if(!recoverable){stopped=true;break;}
        dayRecoveries++;
        try {check();await page.reload({waitUntil:'domcontentloaded'});check();await navigateGgcbMonth(page,month,check,options.calendarTimeout||15000);cells=await readCells();}
        catch(error) {check();report(error,'MONTH_RECOVERY',month,1);failures++;stopped=true;break;}
      }
     }
      if(stopped)break;
      await page.waitForTimeout(350);
    }
    if(stopped)break;
  }
  if(stopped)for(const date of openDates)if(!coverage.has(date))coverage.set(date,{date,status:'ERROR',note:'官网查询未完成，已停止本轮后续日期；等待下轮自动检查，不推断无空位'});
  const all=wanted.map(date=>coverage.get(date)||{date,status:'UNKNOWN' as const,note:'该日期尚未完成读取'});
  const read=all.filter(day=>day.status==='READ').length,unreleased=all.filter(day=>day.status==='OUTSIDE_RELEASE_WINDOW').length,unknown=all.filter(day=>day.status==='UNKNOWN').length,errors=all.filter(day=>day.status==='ERROR').length;
  return {observations,coverage:all,status:read+unreleased===wanted.length?'OK':!read&&errors?'ERROR':'PARTIAL',navigation:`已查询月份：${visited.join('、')||'无'}。${ruleVerified?'已核对官网提前7天放号规则；未放号月份不发起时段查询。':'放号规则未核对，未据此推算未放号日期。'}${failures?'部分月份加载失败，已有限重试。':''}${diagnostics.length?`诊断：${diagnostics.join('；')}`:''}`,
    summary:`已读取${read}/${wanted.length}个目标日期；${unreleased}个日期尚未放号，${unknown}个日期暂未核实，${errors}个日期查询失败。55分钟，自动锁位关闭。${stopped?'已停止本轮后续日期查询，避免连续重载。':''}`};
}
