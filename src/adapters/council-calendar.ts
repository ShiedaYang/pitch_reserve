import type { Frame } from 'playwright';
import { addDays, londonDate, targetDates } from '../domain.ts';
import type { Observation, Policy, ScanResult } from '../domain.ts';
import type { ProviderSession } from '../browser.ts';

export function councilDate(label:string,weekday:string,anchor=londonDate()):string {
  const match=label.trim().match(/^(\d{1,2})\s+([A-Za-z]{3,9})$/);
  const month=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(match?.[2].slice(0,3).toLowerCase() || '');
  if(!match || month<0) throw new Error('Council日期格式未验证');
  const day=Number(match[1]); const year=Number(anchor.slice(0,4));
  const candidates=[year-1,year,year+1].map(y=>new Date(Date.UTC(y,month,day,12))).filter(d=>d.getUTCMonth()===month && d.getUTCDate()===day && ['sun','mon','tue','wed','thu','fri','sat'][d.getUTCDay()]===weekday.slice(0,3).toLowerCase()).map(d=>d.toISOString().slice(0,10)).filter(d=>d>=addDays(anchor,-7) && d<=addDays(anchor,100));
  if(candidates.length!==1) throw new Error('Council日期年份或星期有歧义');
  return candidates[0];
}

export async function readCouncilDays(form:Frame) {
  return form.locator('#booking_day_selector .carousel-item.active #week-cal .bds-day').evaluateAll(elements=>elements.map(el=>({weekday:(el.querySelector('.day')?.textContent||'').trim(),label:(el.querySelector('.date')?.textContent||'').trim()})));
}
export async function readCouncilSlots(form:Frame) {
  return form.locator('#time_selector li').evaluateAll(elements=>elements.map(el=>{
    const text=(el as HTMLElement).innerText;const prices=[...new Set(text.match(/£\s*\d[\d,]*(?:\.\d{2})?/g)||[])];
    return {
    time:(el.querySelector('.select-time') as HTMLElement|null)?.innerText.match(/^\s*(\d{1,2}:\d{2})/)?.[1] || '',
    price:prices.length===1?prices[0].replace(/£\s*/,'£'):null,
    availability:el.classList.contains('availability-available')?'AVAILABLE' as const:el.classList.contains('availability-unavailable')?'BOOKED' as const:'UNKNOWN' as const
  };}));
}

export async function scanCouncilCalendar(form:Frame,policy:Policy,session:ProviderSession):Promise<ScanResult> {
  const dates=targetDates(policy); const observations:Observation[]=[]; const read=new Set<string>(); const unavailableDays=new Set<string>(); const visited=new Set<string>();
  const facts=await form.evaluate(()=>{
    const location=['bookingLocation','bookingLocationUnformat','calendarToUse','summaryUnformat','descriptionUnformat'].map(id=>(document.getElementById(id) as HTMLInputElement|null)?.value || '').join(' ');
    return {stepney:/stepney\s*green/i.test(location),third:/third|1\s*\/\s*3/i.test(location)};
  });
  if(!facts.stepney || !facts.third) {
    session.mode='MANUAL_CONTROL';
    return {status:'PARTIAL',observations,coverage:dates.map(date=>({date,status:'UNKNOWN',note:'未能确认Stepney Green三分之一场'})),summary:'日历已打开，但未能确认Stepney Green及Third；请人工核对场地，当前不判断库存。'};
  }
  let boundary=''; let pages=0; let step='返回日期列表';
  const back=async()=>{
    if(await form.locator('#time_selector:visible').count()) {
      session.assertAutomatic(); await form.locator('#time_selector a.back').click();
    }
    await form.locator('#booking_day_selector:visible').waitFor();
    await form.waitForFunction(()=>{
      const days=Array.from(document.querySelectorAll('#booking_day_selector .carousel-item.active #week-cal .bds-day'));
      return days.length>0&&days.every(day=>(day.querySelector('.day')?.textContent||'').trim()&&(day.querySelector('.date')?.textContent||'').trim());
    },undefined,{timeout:12000});
  };
  try {
    await back();
    // Rewind through normal date navigation so a repeat scan does not start at
    // the final page left by the previous scan. Never click a time or Confirm.
    for(let rewind=0;rewind<14;rewind++) {
      const days=await readCouncilDays(form); if(!days.length) throw new Error('Council日期列表为空');
      const earliest=dates[0] && dates[0]>addDays(londonDate(),1)?dates[0]:addDays(londonDate(),1);
      if(councilDate(days[0].label,days[0].weekday)<=earliest) break;
      const key=JSON.stringify(days); session.assertAutomatic();
      await form.locator('#booking_day_selector a.left.carousel-control').click();
      await form.waitForFunction(old=>{const days=Array.from(document.querySelectorAll('#booking_day_selector .carousel-item.active #week-cal .bds-day')).map(el=>({weekday:(el.querySelector('.day')?.textContent||'').trim(),label:(el.querySelector('.date')?.textContent||'').trim()}));return days.length>0 && days.every(day=>day.weekday && day.label) && JSON.stringify(days)!==old;},key,{timeout:5000});
    }
    for(;pages<14;pages++) {
      session.assertAutomatic(); const days=await readCouncilDays(form);
      if(!days.length) throw new Error('Council日期列表为空');
      const mapped=days.map(day=>({...day,date:councilDate(day.label,day.weekday)}));
      if(mapped[0].date>policy.dateTo) break;
      for(let index=0;index<mapped.length;index++) {
        const day=mapped[index]; if(!dates.includes(day.date)) continue;
        visited.add(day.date);
        const dayButton=form.locator('#booking_day_selector .carousel-item.active #week-cal .bds-day').nth(index);
        if(/\bUNAVAILABLE\b/i.test(await dayButton.innerText())) {unavailableDays.add(day.date);continue;}
        step=`读取${day.date}`;
        try {
          session.assertAutomatic();
          await dayButton.click();
          await form.locator('#time_selector:visible').waitFor({timeout:5000});
          await form.getByRole('heading',{name:`Select a time on ${day.label}`,exact:true}).waitFor({timeout:5000});
          await form.locator('#time_selector li .select-time').first().waitFor({state:'attached',timeout:5000});
          const slots=await readCouncilSlots(form); const target=slots.filter(slot=>slot.time==='18:00');
          if(target.length===1 && target[0].availability!=='UNKNOWN') {
            read.add(day.date); observations.push({resourceId:'stepney-third',date:day.date,start:'18:00',duration:null,availability:target[0].availability,price:target[0].price,note:target[0].availability==='AVAILABLE'?'官网18:00可选；未选择场次，租期及最终报价待核实':'官网18:00明确标为不可用'});
          }
        } catch {
          session.assertAutomatic();
        }
        await back();
      }
      if(mapped.at(-1)!.date>=policy.dateTo) break;
      const key=JSON.stringify(days); const later=form.locator('#booking_day_selector a.right.carousel-control');
      if(!await later.count() || await later.getAttribute('aria-disabled')==='true') {boundary='官网日期导航已到边界';break;}
      step='翻到下一组日期';session.assertAutomatic(); await later.click();
      try {
        await form.waitForFunction(old=>{const days=Array.from(document.querySelectorAll('#booking_day_selector .carousel-item.active #week-cal .bds-day')).map(el=>({weekday:(el.querySelector('.day')?.textContent||'').trim(),label:(el.querySelector('.date')?.textContent||'').trim()}));return days.length>0 && days.every(day=>day.weekday && day.label) && JSON.stringify(days)!==old;},key,{timeout:5000});
      } catch {boundary='官网下一组日期未切换';break;}
    }
  } catch(error) {
    session.assertAutomatic(); boundary=(error instanceof Error && /Timeout/.test(error.name)?'官网日期或时段加载超时':error instanceof Error && /^Council/.test(error.message)?error.message:'官网日历结构待复核')+`（${step}）`;
  }
  if(!read.size&&boundary)session.nextScanAt=Date.now()+60000;
  const coverage=dates.map(date=>({date,status:read.has(date)?'READ' as const:'UNKNOWN' as const,note:read.has(date)?'已读取官网18:00状态；可选时段的租期和报价待核实':unavailableDays.has(date)?'官网日期标为UNAVAILABLE；未开放、已满或其他原因未区分':boundary || '尚未读取到该日期的18:00状态'}));
  return {status:read.size===dates.length?'OK':'PARTIAL',observations,coverage,
    navigation:`已验证Stepney Green Third；查看${visited.size}/${dates.length}个目标日期，${Math.min(pages+1,14)}组日期。${unavailableDays.size}个日期显示UNAVAILABLE，原因未说明。${boundary || '仅使用日期、Back及Earlier/Later导航。'}`,
    summary:`${read.size?'':'暂无信息；'}已读取${read.size}/${dates.length}个18:00状态；${observations.filter(o=>o.availability==='AVAILABLE').length}个日期的18:00可选，租期与报价待核实。${unavailableDays.size}个日期标为UNAVAILABLE（原因未明）。未选择时间或Confirm。${boundary}`};
}
