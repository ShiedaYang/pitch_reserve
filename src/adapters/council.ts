import type { Page } from 'playwright';
import type { Policy, ScanResult } from '../domain.ts';
import { targetDates } from '../domain.ts';
import type { ProviderSession } from '../browser.ts';
import {authSignals} from '../auth.ts';
import {councilUserPage} from '../council-page.ts';
import {prepareCouncil} from '../council-setup.ts';
import {scanCouncilCalendar} from './council-calendar.ts';
import type {CouncilDefaults} from '../council-defaults.ts';

export async function scanCouncil(page: Page, policy: Policy, session: ProviderSession,defaults?:CouncilDefaults): Promise<ScanResult> {
  page = await councilUserPage(session) || page;
  await page.locator('body').waitFor(); session.assertAutomatic();
  const auth=await authSignals(page,'council');
  const gate = await page.getByRole('heading', { name: 'Before you begin', exact: true }).count();
  const login = auth.password || (!!gate && !auth.authenticated);
  if (login) session.status = 'LOGIN_REQUIRED';
  else if(auth.authenticated)session.status='AUTHENTICATED';
  let form = page.frames().find(frame => frame !== page.mainFrame());
  if(!login&&defaults&&form&&!await form.getByRole('heading',{name:'Booking a pitch',exact:true}).count()){
    const prepared=await prepareCouncil(page,defaults,session,'AUTOMATION');session.assertAutomatic();
    if(prepared.stage!=='CALENDAR'){
      if(prepared.stage!=='WAITING')session.mode='MANUAL_CONTROL';
      else session.nextScanAt=Date.now()+60000;
      return {status:'PARTIAL',observations:[],coverage:targetDates(policy).map(date=>({date,status:'UNKNOWN',note:'暂无信息：官网日历尚不可查询'})),summary:prepared.message};
    }
    await session.saveSession();form=page.frames().find(frame=>frame!==page.mainFrame());
  }
  if (form && await form.getByRole('heading',{name:'Booking a pitch',exact:true}).count()) {
    return scanCouncilCalendar(form,policy,session);
  }
  if (form && await form.locator('#addressSelector:visible, #manual_addressLine1:visible').count()) {
    // A user-owned address editor must stay under manual control. Read flags only;
    // never submit, change required rules, or capture address/postcode values.
    session.mode = 'MANUAL_CONTROL';
    const address = await form.evaluate(() => {
      const visible = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
      const fields = ['manual_addressLine1','manual_townCity','manual_postcode'].map(id => {
        const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
        return { visible: !!el && visible(el), filled: !!el?.value.trim() };
      });
      const manual = Array.from(document.querySelectorAll<HTMLInputElement>('input[type=checkbox]')).filter(el => el.id.startsWith('addressMissing')).map(el => ({ checked:el.checked }));
      const select = document.getElementById('addressSelector') as HTMLSelectElement;
      const actions = Array.from(document.querySelectorAll('button,input[type=submit],input[type=button],a[role=button]')).filter(visible).map(el => {
        const label = (el instanceof HTMLInputElement ? el.value : (el as HTMLElement).innerText || el.getAttribute('aria-label') || '').trim();
        const rect = el.getBoundingClientRect();
        return {label,inViewport:rect.top>=0 && rect.bottom<=innerHeight};
      }).filter(action=>/^(?:(?:update|add) record|save(?: address)?|confirm|continue|next|cancel(?: edit)?|previous|add|done|ok|submit)$/i.test(action.label));
      return { fields, manual, options: select ? Array.from(select.options).filter(o=>o.value).length : 0, addressPickerVisible:!!select && visible(select), actions };
    });
    const manualEnabled = address.manual.some(field=>field.checked);
    const manualVisible = address.fields.every(field=>field.visible);
    const manualComplete = address.fields.every(field=>field.filled);
    const detail = !manualEnabled ? '当前手动地址入口未勾选，仍在要求选择地址。' : !manualVisible ? '手动入口已勾选，但官网尚未显示完整的手动地址字段。' : !manualComplete ? '官网已显示手动地址字段，请填写真实地址后保存。' : '手动地址必填项已填写，需在官网确认地址保存是否成功。';
    return { status:'PARTIAL', observations:[], coverage:targetDates(policy).map(date=>({date,status:'UNKNOWN',note:'官网地址表单尚未完成，保持人工接管'})),
      form:{stage:'ADDRESS',manualEnabled,manualVisible,manualComplete,addressPickerVisible:address.addressPickerVisible,actions:address.actions},
      summary:`官网地址下拉框有${address.options}个候选。${detail}保持人工接管，日历尚未读取。` };
  }
  const signals = form ? await form.evaluate(() => ({
    pitch: (document.querySelector('#footbalPitch') as HTMLSelectElement | null)?.selectedOptions[0]?.text || '',
    sizes: Array.from(document.querySelectorAll('label')).map(el=>(el.textContent||'').trim()).filter(t=>t==='Third'),
    hasCalendar: !!document.querySelector('[role=grid],.ui-datepicker,.fc,[class*=calendar]')
  })).catch(()=>null) : null;
  if(!login&&signals?.sizes.length)session.mode='MANUAL_CONTROL';
  if(!login&&!signals?.sizes.length)session.nextScanAt=Date.now()+60000;
  // Until the authenticated form is verified, never infer inventory from arbitrary form text.
  return { status: login ? 'LOGIN_REQUIRED' : 'PARTIAL', observations: [],
    coverage: targetDates(policy).map(date => ({ date, status: 'UNKNOWN', note: login ? '需要手动登录后读取日历' : '登录后页面已可访问，场地及日历结构待验证' })),
    summary: login ? '暂无信息：官网要求登录，将尝试已保存账号；需要验证码时交由人工完成。' : signals?.sizes.length ? `已验证${signals.pitch || 'Stepney Green'}及Third选项；暂无信息，请补全尚未保存的默认资料，空闲后将自动重试。` : '暂无信息：官网日历尚未显示或暂不可查询，将保持自动监测重试。' };
}
