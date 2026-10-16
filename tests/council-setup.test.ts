import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {prepareCouncil} from '../src/council-setup.ts';
import {ProviderSession} from '../src/browser.ts';
import {Store} from '../src/store.ts';

const defaults={pitch:'Stepney Green Park (Artificial)',openingHours:'Mon - Fri 10am - 9pm (10pm closing)',resident:'No',changingRooms:'No',size:'Third',teamCategory:'Senior (16 or Over)',teamName:'fixture FC'} as const;
test('Council defaults persist and reject other eligibility or pitch settings',()=>{
 const store=new Store(':memory:');try{assert.equal(store.councilDefaults(),null);store.saveCouncilDefaults(defaults);assert.deepEqual(store.councilDefaults(),defaults);assert.throws(()=>store.saveCouncilDefaults({...defaults,resident:'Yes'}));assert.throws(()=>store.saveCouncilDefaults({...defaults,size:'Whole'}));assert.equal(store.policy().autoHold,false);}finally{store.close();}
});
test('explicit Council setup fills only saved choices and team, and stops before selecting a slot',async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true,chromiumSandbox:true,timeout:30000});
 try {
  const page=await browser.newPage();await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<iframe src="/fillform/"></iframe>'}));
  await page.route('**/fillform/',route=>route.fulfill({contentType:'text/html',body:`<form onsubmit="event.preventDefault()"><h1>Book a sports pitch</h1><section id="pitch"><select id="sportToBook" hidden><option>Football</option></select><select id="footbalPitch" hidden><option>Stepney Green Park (Artificial)</option></select><select id="hours"><option>Mon - Fri 10am - 9pm (10pm closing)</option></select>${[['TH_borough','No'],['changingRooms','No'],['pitchSize','Third'],['seniorOrJunior','Senior (16 or Over)']].map(([name,label])=>`<label><input type="radio" name="${name}">${label}</label>`).join('')}</section><section id="details" hidden><h2>Your details</h2><label>Team name<input type="text" name="teamName" required></label><label>Email<input type="email" value="fixture@example.invalid" required></label></section><section id="booking_day_selector" hidden><h2>Booking a pitch</h2><button class="select-time" onclick="window.selected++">18:00</button></section><button id="next" onclick="if(!document.getElementById('pitch').hidden){document.getElementById('pitch').hidden=true;document.getElementById('details').hidden=false;}else if(document.querySelector('[name=teamName]').value){document.getElementById('details').hidden=true;document.getElementById('booking_day_selector').hidden=false;this.hidden=true;}">Next</button></form><script>window.selected=0</script>`}));
  await page.goto('https://towerhamlets-self.achieveservice.com/service/Book_a_sports_pitch');
  const session=new ProviderSession('council','.local/test-unused');session.mode='MANUAL_CONTROL';
  const fixture=page.frames()[1];await fixture.locator('input[type=radio]').evaluateAll(inputs=>inputs.forEach((input,index)=>{input.id=`choice-${index}`;input.setAttribute('style','display:none');const label=input.closest('label')!;label.htmlFor=input.id;}));await fixture.locator('#next').evaluate(el=>el.setAttribute('aria-label','Next step'));
  await fixture.locator('#next').evaluate(el=>{const button=el as HTMLButtonElement;const original=button.onclick!;button.onclick=event=>{const details=document.getElementById('details')!;if(!details.hidden){details.hidden=true;document.querySelector('h1')!.hidden=true;button.hidden=true;setTimeout(()=>document.getElementById('booking_day_selector')!.hidden=false,60);}else original.call(button,event);};});
  const result=await prepareCouncil(page,defaults,session);assert.equal(result.stage,'CALENDAR');
  const form=page.frames()[1];assert.equal(await form.locator('[name=teamName]').inputValue(),defaults.teamName);assert.equal(await form.locator('input[type=radio]:checked').count(),4);assert.equal(await form.evaluate(()=>(window as unknown as {selected:number}).selected),0);assert.equal(session.mode,'MANUAL_CONTROL');
  await form.setContent('<h2>Your details</h2><label>Team name<input type="text" name="teamName"></label><select id="addressSelector"><option>Select…</option></select><input id="manual_addressLine1" value="fixture-private-address"><button onclick="document.body.dataset.submitted=\'yes\'">Next</button>');
  const address=await prepareCouncil(page,defaults,session);assert.equal(address.stage,'ADDRESS');assert.equal(await form.locator('[name=teamName]').inputValue(),defaults.teamName);assert.equal(await form.locator('#manual_addressLine1').inputValue(),'fixture-private-address');assert.equal(await form.locator('body').getAttribute('data-submitted'),null);assert.ok(!JSON.stringify(address).includes('fixture-private-address'));
 }finally{await browser.close();}
});
