import type { Page, Request, Response } from 'playwright';
import {addDays} from '../domain.ts';

export class GgcbCalendarError extends Error {
  readonly code:string;readonly reason:string;readonly remedy:string;readonly httpStatus?:number;
  constructor(code:string,reason:string,remedy:string,httpStatus?:number){super(reason);this.name=code==='TIMEOUT'?'TimeoutError':'GgcbCalendarError';this.code=code;this.reason=reason;this.remedy=remedy;this.httpStatus=httpStatus;}
}
function isGgcbMonthRequest(request:Request){
  const url=new URL(request.url());
  if(!['ggcb.co.uk','www.ggcb.co.uk'].includes(url.hostname))return false;
  return (url.searchParams.get('wc-ajax')||new URLSearchParams(request.postData()||'').get('action'))==='wc_bookings_find_booked_day_blocks';
}
export function ggcbReleaseDate(date:string) {return addDays(`${date.slice(0,7)}-01`,-7);}
function ggcbDayRequest(request:Request){
  const url=new URL(request.url());if(!['ggcb.co.uk','www.ggcb.co.uk'].includes(url.hostname))return;
  const data=new URLSearchParams(request.postData()||url.search.slice(1));
  if((data.get('action')||url.searchParams.get('wc-ajax'))!=='wc_bookings_get_blocks')return;
  const form=new URLSearchParams(data.get('form')||'');
  const parts=['year','month','day'].map(part=>form.get(`wc_bookings_field_start_date_${part}`));
  const date=parts.every(value=>value&&/^\d+$/.test(value))?`${parts[0]}-${String(Number(parts[1])).padStart(2,'0')}-${String(Number(parts[2])).padStart(2,'0')}`:null;
  return {date};
}
export function isGgcbDayResponse(response:Response,date:string){return ggcbDayRequest(response.request())?.date===date;}
export async function waitGgcbCalendar(page:Page,timeout=15000) {
  const handle=await page.waitForFunction(()=>{
    const form=document.querySelector('#wc-bookings-booking-form');if(!form)return false;
    if(form.querySelector('.wc-bookings-availability-error'))return 'FAILED';
    if(!form.querySelector('td[class*="date-year-"]'))return false;
    return !Array.from(form.querySelectorAll('.wc-bookings-date-picker .blockOverlay')).some(el=>el.getBoundingClientRect().height>0 && getComputedStyle(el).display!=='none');
  },undefined,{timeout});
  let state:unknown;try{state=await handle.jsonValue();}finally{await handle.dispose();}
  if(state==='FAILED')throw new GgcbCalendarError('MONTH_UNAVAILABLE','官网明确报告月份可用性查询失败','有限重载一次；持续失败时停止该月份查询，不读取旧日历');
}
export async function loadGgcbDay(page:Page,date:string,click:()=>Promise<unknown>,assertControl:()=>void,responseTimeout=12000,calendarTimeout=15000){
  const matching=new Set<Request>();let requests=0,otherDate:string|null=null,networkError:string|undefined,status:number|undefined,disposed=false,settled=false;
  let finish!:(value:Response|GgcbCalendarError)=>void,timer:NodeJS.Timeout|undefined;
  const completed=new Promise<Response|GgcbCalendarError>(resolve=>finish=resolve);
  const settle=(value:Response|GgcbCalendarError)=>{if(!disposed&&!settled){settled=true;finish(value);}};
  const requested=(request:Request)=>{const data=ggcbDayRequest(request);if(!data)return;requests++;if(data.date===date){if(matching.size<32)matching.add(request);}else otherDate=data.date;};
  const failed=(request:Request)=>{if(matching.has(request)){const error=request.failure()?.errorText;networkError=error&&/^net::ERR_[A-Z_]+$/.test(error)?error:'连接中断';}};
  const received=(response:Response)=>{
    if(!matching.has(response.request()))return;status=response.status();
    if(response.headers()['cf-mitigated']==='challenge'){settle(new GgcbCalendarError('DAY_VERIFICATION_REQUIRED','官网时段响应要求人工验证','停止本轮读取，请人工检查官网验证；不连续刷新',status));return;}
    if(!response.ok()){settle(new GgcbCalendarError('DAY_HTTP_ERROR',`日期时段请求返回 HTTP ${status}`,'检查官网后台接口；不把失败响应当作没有空位',status));return;}
    // An aborted request can be followed by a replacement for the same date.
    // Accept only a completed body; the overall deadline also bounds finished().
    void response.finished().then(error=>{if(error)networkError='响应正文连接中断';else settle(response);},()=>{networkError='响应正文连接中断';});
  };
  const closed=()=>settle(new GgcbCalendarError('BROWSER_CLOSED','时段读取期间浏览器页面已关闭','结束当前等待，由会话恢复流程继续处理'));
  page.on('request',requested);page.on('requestfailed',failed);page.on('response',received);page.on('close',closed);
  let stage='CLICK';
  try{
    assertControl();await click();assertControl();stage='RESPONSE';
    timer=setTimeout(()=>{
      const remedy='有限重载后重试同一日期；持续失败则结束本轮，不使用旧库存';
      if(!requests)settle(new GgcbCalendarError('DAY_NO_REQUEST','日期点击完成后，官网未发出时段请求',remedy));
      else if(!matching.size)settle(new GgcbCalendarError('DAY_DATE_MISMATCH',`官网时段请求日期与目标日期不一致${otherDate?`（请求日期 ${otherDate}）`:''}`,remedy));
      else if(networkError)settle(new GgcbCalendarError('DAY_NETWORK_ERROR',`日期时段请求失败（${networkError}）`,remedy,status));
      else if(status)settle(new GgcbCalendarError('DAY_BODY_TIMEOUT',`时段响应 HTTP ${status}，但正文未在期限内接收完成`,remedy,status));
      else settle(new GgcbCalendarError('TIMEOUT','已发出目标日期请求，但未在期限内收到响应',remedy));
    },responseTimeout);
    const response=await completed;assertControl();if(response instanceof GgcbCalendarError)throw response;
    stage='PICKER';
    await page.waitForFunction(()=>!Array.from(document.querySelectorAll('#wc-bookings-booking-form .block-picker')).some(el=>Array.from(el.closest('div')?.querySelectorAll('.blockOverlay')||[]).some(overlay=>overlay.getBoundingClientRect().height>0 && getComputedStyle(overlay).display!=='none')),undefined,{timeout:calendarTimeout}).then(handle=>handle.dispose());
    assertControl();
    const selected=await page.locator('#wc-bookings-booking-form').evaluate(form=>['year','month','day'].map(part=>(form.querySelector<HTMLInputElement>(`[name="wc_bookings_field_start_date_${part}"]`)?.value||'')).map((value,index)=>index?String(Number(value)).padStart(2,'0'):value).join('-'));
    if(selected!==date)throw new GgcbCalendarError('DAY_DATE_MISMATCH','响应完成后页面所选日期发生变化，未读取该时段列表','恢复后重试同一日期，避免采用其他日期的库存');
  }catch(error){
    assertControl();
    if(error instanceof Error&&error.name==='TimeoutError'&&!(error instanceof GgcbCalendarError))throw new GgcbCalendarError(stage==='CLICK'?'DAY_CLICK_TIMEOUT':'DAY_UI_TIMEOUT',stage==='CLICK'?'日期按钮未能在期限内完成点击':'时段响应已完成，但页面加载遮罩未消失','有限恢复后重试；不读取旧时段',stage==='PICKER'?status:undefined);
    throw error;
  }finally{disposed=true;clearTimeout(timer);page.off('request',requested);page.off('requestfailed',failed);page.off('response',received);page.off('close',closed);}
}
export async function ggcbMonth(page:Page) {
  const title=(await page.locator('#wc-bookings-booking-form .ui-datepicker-title').innerText()).replace(/\s+/g,' ').trim();
  const match=title.match(/^([a-z]+)\s+(\d{4})$/i);
  const month=['january','february','march','april','may','june','july','august','september','october','november','december'].indexOf(match?.[1].toLowerCase()||'');
  if(!match || month<0)throw new Error('GGCB日历月份标题未识别');
  return `${match[2]}-${String(month+1).padStart(2,'0')}`;
}
export async function navigateGgcbMonth(page:Page,target:string,assertControl:()=>void,timeout=15000) {
  let fail!:(error:Error)=>void,lastStatus:number|undefined;
  const failed=new Promise<never>((_,reject)=>{fail=reject;});void failed.catch(()=>{});
  const response=(response:Response)=>{
    if(!isGgcbMonthRequest(response.request()))return;
    lastStatus=response.status();
    if(response.headers()['cf-mitigated']==='challenge')fail(new GgcbCalendarError('MONTH_VERIFICATION_REQUIRED','官网月份响应要求人工验证','停止本轮读取，请人工检查官网验证；不连续刷新',lastStatus));
    if(lastStatus>=400)fail(new GgcbCalendarError('MONTH_HTTP_ERROR',`月份后台请求返回 HTTP ${lastStatus}`,'检查官网后台接口和网络；程序有限重试，不把页面可见当作月份查询成功',lastStatus));
  };
  const requestFailed=(request:Request)=>{
    if(!isGgcbMonthRequest(request))return;
    const value=request.failure()?.errorText;
    const code=value&&/^net::ERR_[A-Z_]+$/.test(value)?value:'连接中断';
    fail(new GgcbCalendarError('NETWORK_CONNECTION',`月份后台请求失败（${code}）`,'检查服务器到官网的网络连接；页面外观正常仍可能存在后台请求失败'));
  };
  page.on('response',response);page.on('requestfailed',requestFailed);
  const ready=()=>Promise.race([waitGgcbCalendar(page,timeout),failed]);
  try{
  for(let moves=0;moves<5;moves++) {
    assertControl();await ready();const month=await ggcbMonth(page);if(month===target)return;
    const next=page.locator('#wc-bookings-booking-form').getByRole('button',{name:month<target?'Next Month':'Previous Month'});
    if(!await next.count() || await next.getAttribute('aria-disabled')==='true')throw new Error('GGCB月份导航已到边界');
    const previous=(await page.locator('#wc-bookings-booking-form .ui-datepicker-title').innerText()).replace(/\s+/g,' ').trim();
    assertControl();await next.click();
    const changed = page.waitForFunction(previous=>document.querySelector('#wc-bookings-booking-form .ui-datepicker-title')?.textContent?.replace(/\s+/g,' ').trim()!==previous,previous,{timeout}).then(handle => handle.dispose());
    await Promise.race([changed, failed]);
    await ready();
    if(await ggcbMonth(page)===month)throw new Error('GGCB月份未切换');
  }
  throw new Error('GGCB月份导航范围不足');
  }catch(error){
    assertControl();
    if(error instanceof Error&&error.name==='TimeoutError'){
      const state=await page.evaluate(()=>{
        const form=document.querySelector('#wc-bookings-booking-form');
        if(!form)return '预订表单未出现';
        if(!form.querySelector('td[class*="date-year-"]'))return '日期单元格未出现';
        if(Array.from(form.querySelectorAll('.wc-bookings-date-picker .blockOverlay')).some(el=>el.getBoundingClientRect().height>0&&getComputedStyle(el).display!=='none'))return '月份加载遮罩未消失';
        return '月份标题未按预期更新';
      }).catch(()=>'页面无法读取');
      throw new GgcbCalendarError('TIMEOUT',`月份加载超时：${state}${lastStatus?`（最近月份响应 HTTP ${lastStatus}）`:''}`,'检查月份后台请求及日历初始化；程序重载后延长一次等待，持续失败时查看远程页面',lastStatus);
    }
    throw error;
  }finally{page.off('response',response);page.off('requestfailed',requestFailed);}
}
export async function quoteGgcb(page:Page,slotValue:string):Promise<string|null> {
  try {
    const quote=await page.evaluate(value=>{
      const root=document.querySelector('#wc-bookings-booking-form');const form=root?.closest('form');
      const time=root?.querySelector('.block-picker')?.closest('div')?.querySelector<HTMLInputElement>('input[name]');
      const settings=(window as unknown as {booking_form_params?:{ajax_url?:string}}).booking_form_params;
      if(!form || !time?.name || !settings?.ajax_url)return null;
      const url=new URL(settings.ajax_url,location.href);
      if(url.protocol!=='https:' || !['ggcb.co.uk','www.ggcb.co.uk'].includes(url.hostname) || url.pathname!=='/wp-admin/admin-ajax.php')return null;
      // Clone values for the site's cost action; leave the live time unselected.
      const data=new URLSearchParams();for(const [key,item] of new FormData(form))if(typeof item==='string')data.append(key,item);
      data.set(time.name,value);
      return {url:url.href,form:data.toString()};
    },slotValue);
    if(!quote)return null;
    const result=await page.evaluate(async quote=>{
      const response=await fetch(quote.url,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({action:'wc_bookings_calculate_costs',form:quote.form}),signal:AbortSignal.timeout(12000)});
      return response.ok?response.json():null;
    },quote) as {result?:string;html?:string;raw_price?:number|string}|null;
    if(!result)return null;
    if(result.result!=='SUCCESS')return null;
    if(result.raw_price!==undefined && Number.isFinite(Number(result.raw_price)) && Number(result.raw_price)>=0)return `£${Number(result.raw_price).toFixed(2)}`;
    return page.evaluate(html=>{
      const doc=new DOMParser().parseFromString(html,'text/html');
      const amounts=Array.from(new Set((doc.body.textContent||'').match(/£\s*\d[\d,]*(?:\.\d{2})?/g)?.map(amount=>amount.replace(/\s/g,''))||[]));
      return amounts.length===1?amounts[0]:null;
    },result.html||'');
  }catch {return null;}
}
