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
export function isGgcbDayResponse(response:Response,date:string) {
  const url=new URL(response.url());if(!['ggcb.co.uk','www.ggcb.co.uk'].includes(url.hostname))return false;
  const data=new URLSearchParams(response.request().postData()||'');
  if(data.get('action')!=='wc_bookings_get_blocks')return false;
  const form=new URLSearchParams(data.get('form')||'');
  return ['year','month','day'].map(part=>form.get(`wc_bookings_field_start_date_${part}`)).map((value,index)=>index?String(Number(value)).padStart(2,'0'):value).join('-')===date;
}
export async function waitGgcbCalendar(page:Page,timeout=15000) {
  await page.waitForFunction(()=>{
    const form=document.querySelector('#wc-bookings-booking-form');if(!form?.querySelector('td[class*="date-year-"]'))return false;
    return !Array.from(form.querySelectorAll('.wc-bookings-date-picker .blockOverlay')).some(el=>el.getBoundingClientRect().height>0 && getComputedStyle(el).display!=='none');
  },undefined,{timeout});
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
    await Promise.race([page.waitForFunction(previous=>document.querySelector('#wc-bookings-booking-form .ui-datepicker-title')?.textContent?.replace(/\s+/g,' ').trim()!==previous,previous,{timeout}),failed]);
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
