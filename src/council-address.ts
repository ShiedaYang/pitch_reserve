import {readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import type {Frame} from 'playwright';

export interface CouncilAddressDefault {version:1;postcode:string;addressValue?:string;}
export function parseAddressDefault(input:unknown):CouncilAddressDefault {
  if(!input || typeof input!=='object')throw new Error('Council默认邮编无效');
  const data=input as Record<string,unknown>;const compact=typeof data.postcode==='string'?data.postcode.replace(/\s/g,'').toUpperCase():'';
  if(!/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(compact) || (data.addressValue!==undefined && (typeof data.addressValue!=='string' || !data.addressValue || data.addressValue.length>300)))throw new Error('Council默认邮编无效');
  return {version:1,postcode:`${compact.slice(0,-3)} ${compact.slice(-3)}`,...(typeof data.addressValue==='string'?{addressValue:data.addressValue}:{})};
}
export async function readAddressDefault(root:string):Promise<CouncilAddressDefault|null> {
  try{return parseAddressDefault(JSON.parse(await readFile(join(root,'council-address-defaults.json'),'utf8')));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw new Error('Council默认邮编配置无法读取');}
}
export async function saveAddressDefault(root:string,input:unknown) {
  const data=parseAddressDefault(input);const path=join(root,'council-address-defaults.json');await writeFile(`${path}.tmp`,JSON.stringify(data),{mode:0o600});await rename(`${path}.tmp`,path);return data;
}
const compact=(value:string)=>value.replace(/\s/g,'').toUpperCase();
async function candidates(form:Frame) {
  return form.locator('#addressSelector option').evaluateAll(options=>options.filter(option=>!(option as HTMLOptionElement).disabled).map(option=>({value:(option as HTMLOptionElement).value,label:option.textContent||''})).filter(option=>option.value && option.label.trim() && !/^(?:select|please select|no address(?:es)?|no results|not found|address not)/i.test(option.label.trim())));
}

// Runs only from the explicit "apply defaults" action, never from monitoring.
// A postcode is not enough to choose between multiple real addresses.
export async function applyCouncilAddress(form:Frame,root:string,assertControl:()=>void,lookupTimeoutMs=12000) {
  const defaults=await readAddressDefault(root);if(!defaults)return {kind:'MANUAL' as const,count:0,message:'官网需要核对或补充地址，请在官网完成后继续。'};
  const postcode=form.locator('#postcodeCustomerEntry:visible');
  if(await postcode.count()!==1)return {kind:'MANUAL' as const,count:0,message:'已保存默认邮编，但未找到唯一可见的官网邮编输入框。'};
  const picker=form.locator('#addressSelector');if(await picker.count()!==1)return {kind:'MANUAL' as const,count:0,message:'已保存默认邮编，官网地址选择框尚未加载。'};
  const before=await candidates(form);const current=compact(await postcode.inputValue());
  let choices=before;
  const knownMatch=defaults.addressValue && current===compact(defaults.postcode) && choices.some(option=>option.value===defaults.addressValue);
  if(!knownMatch) {
    // Correlate the result to this input through actual option mutations, even
    // when the server rebuilds an identical result list. No network capture.
    await picker.evaluate(el=>{const target=el as HTMLSelectElement & {__pitchLookup?:{changed:boolean;observer:MutationObserver}};target.__pitchLookup?.observer.disconnect();const state={changed:false,observer:new MutationObserver(()=>{state.changed=true;})};state.observer.observe(el,{childList:true,subtree:true,characterData:true});target.__pitchLookup=state;});
    try {
      assertControl();await postcode.fill(defaults.postcode);await postcode.press('Tab');
      if(current===compact(defaults.postcode)){assertControl();await postcode.dispatchEvent('change');}
      const find=form.getByRole('button',{name:/^(?:find|search|lookup)(?: an?)? address$/i});if(await find.count()===1 && await find.isVisible()){assertControl();await find.click();}
      await form.waitForFunction(target=>{const picker=document.getElementById('addressSelector') as (HTMLSelectElement & {__pitchLookup?:{changed:boolean}})|null;const input=document.getElementById('postcodeCustomerEntry') as HTMLInputElement|null;return !!picker && (input?.value||'').replace(/\s/g,'').toUpperCase()===target && (!!picker.__pitchLookup?.changed || Array.from(picker.options).some(option=>(option.textContent||'').replace(/\s/g,'').toUpperCase().includes(target)));},compact(defaults.postcode),{timeout:lookupTimeoutMs}).catch(()=>{});
      assertControl();
      const fresh=await picker.evaluate((el,target)=>{const picker=el as HTMLSelectElement & {__pitchLookup?:{changed:boolean}};return !!picker.__pitchLookup?.changed || Array.from(picker.options).some(option=>(option.textContent||'').replace(/\s/g,'').toUpperCase().includes(target));},compact(defaults.postcode));
      if(!fresh)return {kind:'LOOKUP_FAILED' as const,count:0,message:'默认邮编已填入官网，但地址查询尚未返回可核实的新结果；没有选择旧地址。'};
      choices=await candidates(form);
    }finally{await picker.evaluate(el=>{const target=el as HTMLSelectElement & {__pitchLookup?:{observer:MutationObserver}};target.__pitchLookup?.observer.disconnect();delete target.__pitchLookup;}).catch(()=>{});}
  }
  let match=defaults.addressValue?choices.filter(option=>option.value===defaults.addressValue):choices.length===1?choices:[];
  if(match.length!==1)return {kind:choices.length?'CHOOSE_ADDRESS' as const:'LOOKUP_FAILED' as const,count:choices.length,message:choices.length?`默认邮编已应用，官网返回${choices.length}个地址。请选择准确地址，不能仅凭邮编猜选；当前未继续提交。`:'默认邮编已应用，但官网没有返回有效地址；当前未继续提交。'};
  assertControl();await picker.selectOption(match[0].value,{force:true});
  if(await picker.inputValue()!==match[0].value)return {kind:'MANUAL' as const,count:choices.length,message:'官网尚未确认地址选择，请人工核对。'};
  await saveAddressDefault(root,{...defaults,addressValue:match[0].value});
  return {kind:'SELECTED' as const,count:choices.length,message:'已应用默认邮编并选择官网唯一或此前指定的地址，已保留默认选择。'};
}
