import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
import {applyCouncilAddress,saveAddressDefault,readAddressDefault,parseAddressDefault} from '../src/council-address.ts';

test('postcode preferences normalize and reject invalid input',()=>{
 assert.deepEqual(parseAddressDefault({postcode:'e141aa'}),{version:1,postcode:'E14 1AA'});assert.throws(()=>parseAddressDefault({postcode:'invalid'}));
});
test('address lookup never guesses among multiple results, remembers exact choices and rejects stale results',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pitch-address-'));const browser=await chromium.launch({channel:'msedge',headless:true,chromiumSandbox:true,timeout:30000});
 try {
  const page=await browser.newPage();await page.setContent('<iframe></iframe>');const form=page.frames()[1];
  await form.setContent('<input id="postcodeCustomerEntry" value="E15 1AA"><select id="addressSelector"><option value="old">Old address E15 1AA</option></select><button onclick="document.body.dataset.submitted=\'yes\'">Next</button>');
  await form.evaluate(()=>{const input=document.getElementById('postcodeCustomerEntry') as HTMLInputElement;input.onchange=()=>setTimeout(()=>{const select=document.getElementById('addressSelector') as HTMLSelectElement;select.replaceChildren(new Option('Select…',''));if(input.value==='E14 1AA'){select.add(new Option('Unit A, Example House, E14 1AA','unit-a'));select.add(new Option('Unit B, Example House, E14 1AA','unit-b'));}else if(input.value==='E14 2AA')select.add(new Option('Unit C, Example House, E14 2AA','unit-c'));else{const missing=new Option('No addresses found','none');missing.disabled=true;select.add(missing);}},20);});
  await saveAddressDefault(root,{postcode:'E14 1AA'});let result=await applyCouncilAddress(form,root,()=>{},300);
  assert.equal(result.kind,'CHOOSE_ADDRESS');assert.equal(result.count,2);assert.equal(await form.locator('#addressSelector').inputValue(),'');assert.equal((await readAddressDefault(root))?.addressValue,undefined);
  await saveAddressDefault(root,{postcode:'E14 1AA',addressValue:'unit-b'});result=await applyCouncilAddress(form,root,()=>{},300);assert.equal(result.kind,'SELECTED');assert.equal(await form.locator('#addressSelector').inputValue(),'unit-b');assert.equal((await readAddressDefault(root))?.addressValue,'unit-b');
  await saveAddressDefault(root,{postcode:'E14 2AA'});result=await applyCouncilAddress(form,root,()=>{},300);assert.equal(result.kind,'SELECTED');assert.equal(await form.locator('#addressSelector').inputValue(),'unit-c');
  await form.locator('#postcodeCustomerEntry').evaluate(el=>(el as HTMLInputElement).onchange=null);await saveAddressDefault(root,{postcode:'E14 3AA'});result=await applyCouncilAddress(form,root,()=>{},100);assert.equal(result.kind,'LOOKUP_FAILED');assert.equal(await form.locator('#addressSelector').inputValue(),'unit-c');assert.equal((await readAddressDefault(root))?.addressValue,undefined);assert.equal(await form.locator('body').getAttribute('data-submitted'),null);
 }finally{await browser.close();await rm(root,{recursive:true,force:true});}
});
