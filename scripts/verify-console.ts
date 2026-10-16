import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const base = 'http://127.0.0.1:4318';
const response = await fetch(`${base}/api/state`); assert.equal(response.status, 200);
const state = await response.json(); assert.equal(state.readOnly, true); assert.equal(state.policy.autoHold, false); assert.equal(state.resources.length, 4);
assert.equal((await fetch(`${base}/api/providers/council/pause`, {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status, 403);
assert.equal((await fetch(`${base}/api/state`,{headers:{Origin:'https://example.com'}})).status,403);
assert.equal((await fetch(`${base}/api/hold`,{method:'POST',headers:{'Content-Type':'application/json','X-Console-Token':state.csrf},body:'{}'})).status,404);
assert.equal((await fetch(`${base}/api/policy`,{method:'POST',headers:{'Content-Type':'application/json','X-Console-Token':state.csrf},body:JSON.stringify({...state.policy,autoHold:true})})).status,400);
assert.equal((await fetch(`${base}/.local/server.json`)).status,404);
assert.equal((await fetch(`${base}/api/providers/ggcb/credentials`)).status,404);
const invalid=await fetch(`${base}/api/providers/ggcb/auto-login`,{method:'POST',headers:{'Content-Type':'application/json','X-Console-Token':state.csrf},body:JSON.stringify({username:'',password:'fixture-never-log-this'})});
assert.equal(invalid.status,400);assert.ok(!(await invalid.text()).includes('fixture-never-log-this'));
const malformed=await fetch(`${base}/api/providers/ggcb/auto-login`,{method:'POST',headers:{'Content-Type':'application/json','X-Console-Token':state.csrf},body:'{"password":"请 fixture-never-log-this"'});
assert.equal(malformed.status,400);assert.ok(!(await malformed.text()).includes('fixture-never-log-this'));
const browser = await chromium.launch({ channel:'msedge',headless:true,chromiumSandbox:true,timeout:30000 });
try {
 const page = await browser.newPage({viewport:{width:1440,height:1100},deviceScaleFactor:1});
 const preview=structuredClone(state);
 preview.providers=preview.providers.map((provider:{id:string})=>({...provider,hasCredentials:true,hasSavedCredentials:true,savedUsername:`${provider.id}@example.invalid`,credentialError:null}));
 await page.route(`${base}/api/state`,route=>route.fulfill({json:preview}));
 await page.route(`${base}/api/providers/ggcb/forget-credentials`,route=>{const provider=preview.providers.find((provider:{id:string})=>provider.id==='ggcb');provider.hasCredentials=false;provider.hasSavedCredentials=false;provider.savedUsername=null;return route.fulfill({json:{message:'测试账号已清除'}});});
 await page.goto(base); await page.locator('.resource').last().waitFor();
 assert.equal(await page.locator('.resource').count(),4);
 assert.equal(await page.locator('.provider').count(),3);
 assert.match(await page.locator('.readonly').innerText(),/自动锁位关闭/);
 assert.equal(await page.locator('.credential-form').count(),3);
 assert.equal(await page.locator('[data-action=prepare-council]').count(),1);
 if(state.councilDefaults){await page.locator('.council-defaults').evaluate(el=>(el as HTMLDetailsElement).open=true);assert.match(await page.locator('.defaults-summary').innerText(),/Third/);assert.ok((await page.locator('.defaults-summary').textContent())?.includes(state.councilDefaults.teamName));}
 await page.locator('[data-provider-card=ggcb] .credentials').evaluate(el=>(el as HTMLDetailsElement).open=true);
 const account=page.locator('[data-provider-card=ggcb] input[name=username]');const password=page.locator('[data-provider-card=ggcb] input[name=password]');
 assert.equal(await account.inputValue(),'ggcb@example.invalid');assert.equal(await password.inputValue(),'');assert.match(await password.getAttribute('placeholder')||'',/已保存/);assert.match(await page.locator('[data-provider-card=ggcb] .saved-account').innerText(),/ggcb@example.invalid.*••••••••/);
 await account.fill('fixture@example.invalid');await password.fill('fixture-browser-only');
 await page.waitForTimeout(3500);assert.equal(await account.inputValue(),'fixture@example.invalid');assert.equal(await password.inputValue(),'fixture-browser-only');assert.equal(await password.getAttribute('type'),'password');
 assert.equal(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}).includes('fixture-browser-only')),false);
 await account.fill('');await password.fill('');
 await page.locator('[data-provider-card=ggcb] [data-action=forget-credentials]').click();
 await page.waitForFunction(()=>document.querySelector<HTMLParagraphElement>('[data-provider-card=ggcb] .saved-account')?.hidden===true);
 assert.equal(await account.inputValue(),'');assert.equal(await password.getAttribute('placeholder'),'请输入密码');assert.match(await page.locator('[data-provider-card=playfootball] .saved-account').innerText(),/playfootball@example.invalid/);
 Object.assign(preview.providers.find((provider:{id:string})=>provider.id==='ggcb'),{hasCredentials:true,hasSavedCredentials:true,savedUsername:'ggcb@example.invalid'});
 await page.reload();await page.locator('.resource').last().waitFor();await page.locator('[data-provider-card=ggcb] .credentials').evaluate(el=>(el as HTMLDetailsElement).open=true);
 assert.equal(await account.inputValue(),'ggcb@example.invalid');assert.equal(await password.inputValue(),'');
 for(const anchor of await page.locator('a[data-slot]').all()){const href=await anchor.getAttribute('href');assert.ok(state.resources.some((resource:{url:string})=>resource.url===href));assert.match(await anchor.innerText(),/£|价格待核实/);}
 mkdirSync('.local/artifacts',{recursive:true}); await page.screenshot({path:'.local/artifacts/console.png',fullPage:false});
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
} finally { await browser.close(); }
console.log('Console smoke passed: local API guards, read-only mode, four resources, desktop/mobile layout.');
