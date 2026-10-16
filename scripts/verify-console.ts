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
const browser = await chromium.launch({ channel:'msedge',headless:true,chromiumSandbox:true,timeout:30000 });
try {
 const page = await browser.newPage({viewport:{width:1440,height:1100},deviceScaleFactor:1});
 await page.goto(base); await page.locator('.resource').last().waitFor();
 assert.equal(await page.locator('.resource').count(),4);
 assert.equal(await page.locator('.provider').count(),3);
 assert.match(await page.locator('.readonly').innerText(),/自动锁位关闭/);
 mkdirSync('.local/artifacts',{recursive:true}); await page.screenshot({path:'.local/artifacts/console.png',fullPage:false});
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
} finally { await browser.close(); }
console.log('Console smoke passed: local API guards, read-only mode, four resources, desktop/mobile layout.');
