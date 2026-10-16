import type {Frame,Page} from 'playwright';
import type {CouncilDefaults} from './council-defaults.ts';
import type {ProviderSession} from './browser.ts';
import {statSync} from 'node:fs';

const normalized=(value:string)=>value.replace(/[–—]/g,'-').replace(/\s+/g,' ').trim();
async function stage(frame:Frame) {
  return frame.evaluate(()=>{
    const shown=(selector:string)=>Array.from(document.querySelectorAll(selector)).some(el=>el.getClientRects().length>0 && getComputedStyle(el).visibility!=='hidden');
    if(shown('#booking_day_selector,#time_selector'))return 'CALENDAR';
    if(shown('#addressSelector,#manual_addressLine1'))return 'ADDRESS';
    const headings=Array.from(document.querySelectorAll('h1,h2,h3')).filter(el=>el.getClientRects().length>0).map(el=>(el.textContent||'').trim());
    if(headings.includes('Your details'))return 'DETAILS';
    if(headings.includes('Book a sports pitch') && !!document.querySelector('#footbalPitch'))return 'PITCH';
    return 'OTHER';
  }).catch(()=>'OTHER');
}
async function selectLabel(form:Frame,id:string,label:string,assertControl:()=>void) {
  const field=form.locator(`#${id}`);if(await field.count()!==1)throw new Error('官网场地选项结构已变化');
  const options=await field.locator('option').evaluateAll(options=>options.map(option=>({label:option.textContent||'',value:(option as HTMLOptionElement).value})));
  const matches=options.filter(option=>normalized(option.label)===normalized(label));if(matches.length!==1)throw new Error('官网场地选项结构已变化');
  assertControl();
  // The official Select2 widget hides its backing native select. Selecting an
  // existing option fires its normal change event; never change validation.
  await field.selectOption(matches[0].value,{force:true});
}
async function radioLabel(form:Frame,name:string,label:string,assertControl:()=>void) {
  const fields=form.locator(`input[type=radio][name="${name}"]`);
  const labels=await fields.evaluateAll(inputs=>inputs.map(input=>Array.from((input as HTMLInputElement).labels||[]).map(label=>label.textContent||'').join(' ')));
  const matches=labels.map((text,index)=>({text,index})).filter(option=>normalized(option.text)===normalized(label));
  if(matches.length!==1)throw new Error('官网队伍选项结构已变化');assertControl();
  const input=fields.nth(matches[0].index);if(await input.isChecked())return;
  const id=await input.getAttribute('id');
  const visibleLabel=id && /^[A-Za-z0-9_-]+$/.test(id)?form.locator(`label[for="${id}"]:visible`):undefined;
  if(visibleLabel && await visibleLabel.count()===1)await visibleLabel.click();else await input.check();
  if(!await input.isChecked())throw new Error('官网队伍选项未确认');
}
async function openingHours(form:Frame,label:string,assertControl:()=>void) {
  const choices=await form.locator('select').evaluateAll(selects=>selects.flatMap(select=>Array.from((select as HTMLSelectElement).options).map(option=>({id:select.id,label:option.text,value:option.value}))));
  const options=choices.filter(option=>normalized(option.label)===normalized(label));
  if(options.length===1){assertControl();await form.locator(`[id="${options[0].id}"]`).selectOption(options[0].value,{force:true});return;}
  const radio=form.getByLabel(label,{exact:true});
  if(await radio.count()===1 && await radio.getAttribute('type')==='radio'){assertControl();await radio.check();return;}
  // Some versions display the opening hours as fixed descriptive text.
  const fixed=form.getByText(label,{exact:true});if(await fixed.count()===1 && await fixed.isVisible())return;
  throw new Error('未能确认官网开放时段类别，保持人工接管');
}

export async function prepareCouncil(page:Page,defaults:CouncilDefaults,session:ProviderSession) {
  const assertControl=()=>{if(session.mode!=='MANUAL_CONTROL')throw new Error('已暂停，等待人工接管');};
  let teamFilled=false;let addressApplied=false;
  for(let step=0;step<4;step++) {
    assertControl();
    const form=page.frames().find(frame=>frame!==page.mainFrame() && new URL(frame.url()).hostname==='towerhamlets-self.achieveservice.com');
    if(!form)return {stage:'MANUAL',message:'官网表单尚未加载，请稍后重试。'};
    const current=await stage(form);
    if(current==='CALENDAR')return {stage:current,message:addressApplied?'已应用默认邮编与地址并进入Book pitch日历；未选择时间或提交预约。':'已进入Book pitch日历；未选择时间或提交预约。'};
    if(current==='PITCH') {
      const apply=async(label:string,fn:()=>Promise<void>)=>{try{await fn();}catch{throw new Error(`Council默认选项应用未完成：${label}；请检查官网当前选项。`);}};
      await apply('运动类型',()=>selectLabel(form,'sportToBook','Football',assertControl));
      await apply('Stepney Green场地',()=>selectLabel(form,'footbalPitch',defaults.pitch,assertControl));
      await apply('居民或本地队伍 No',()=>radioLabel(form,'TH_borough',defaults.resident,assertControl));
      await apply('更衣室 No',()=>radioLabel(form,'changingRooms',defaults.changingRooms,assertControl));
      await apply('Third',()=>radioLabel(form,'pitchSize',defaults.size,assertControl));
      await apply('Senior',()=>radioLabel(form,'seniorOrJunior',defaults.teamCategory,assertControl));
      await apply('周一至周五开放时间',()=>openingHours(form,defaults.openingHours,assertControl));
    }
    const teamFields=await form.locator('input[type=text],input:not([type])').evaluateAll(inputs=>inputs.map((input,index)=>({index,visible:input.getClientRects().length>0 && getComputedStyle(input).visibility!=='hidden',label:[input.id,input.getAttribute('name')||'',...Array.from((input as HTMLInputElement).labels||[]).map(label=>label.textContent||'')].join(' ')})).filter(field=>field.visible && /team.?name|name.?of.?(?:the.)?(?:team|club)|club.?name/i.test(field.label)));
    if(teamFields.length===1){assertControl();await form.locator('input[type=text],input:not([type])').nth(teamFields[0].index).fill(defaults.teamName);teamFilled=true;}
    if(current==='ADDRESS'){
      const url=new URL('./council-address.ts',import.meta.url);const {applyCouncilAddress}=await import(`${url.href}?v=${statSync(url).mtimeMs}`) as typeof import('./council-address.ts');
      const address=await applyCouncilAddress(form,session.root,assertControl);
      if(address.kind!=='SELECTED')return {stage:current,message:address.message,addressStatus:address.kind,addressCount:address.count};
      addressApplied=true;
    }
    if(current!=='PITCH' && current!=='DETAILS' && current!=='ADDRESS')return {stage:'MANUAL',message:'当前页面需要人工核对，未点击后续提交。'};
    const unsafe=await form.evaluate(()=>{
      const visible=(el:Element)=>el.getClientRects().length>0 && getComputedStyle(el).visibility!=='hidden';
      return Array.from(document.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('input,select,textarea')).some(el=>visible(el) && ((el.required && !el.validity.valid) || (el instanceof HTMLInputElement && el.type==='checkbox' && /terms|agree|consent|declaration/i.test([el.name,...Array.from(el.labels||[]).map(label=>label.textContent||'')].join(' ')))));
    });
    if(unsafe || (current==='DETAILS' && !teamFilled))return {stage:'DETAILS',message:'默认选项已填写；请在官网检查尚需填写的个人资料或确认项，再进入日历。未自动确认条款。'};
    const controls=form.locator('button,input[type=submit],a[role=button]');
    const nextButtons=await controls.evaluateAll(elements=>elements.map((el,index)=>({index,text:(el instanceof HTMLInputElement?el.value:(el as HTMLElement).innerText||el.getAttribute('aria-label')||'').trim(),visible:el.getClientRects().length>0 && getComputedStyle(el).visibility!=='hidden'})).filter(el=>el.visible && el.text==='Next'));
    if(nextButtons.length!==1)return {stage:'MANUAL',message:'默认选项已填写，但未找到唯一可见的Next，请人工继续。'};
    assertControl();await controls.nth(nextButtons[0].index).click();
    for(let retry=0;retry<30;retry++){assertControl();const nextFrame=page.frames().find(frame=>frame!==page.mainFrame() && new URL(frame.url()).hostname==='towerhamlets-self.achieveservice.com');const nextStage=nextFrame?await stage(nextFrame):'OTHER';if(nextStage!=='OTHER' && nextStage!==current)break;await page.waitForTimeout(200);}
  }
  return {stage:'MANUAL',message:'默认选项已填写，请在官网核对当前步骤；未选择时间或提交预约。'};
}
