// Unauthenticated read-only check: does the official dashboard require login?
import {chromium} from 'playwright';
const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:false,chromiumSandbox:true,timeout:30000});
try {
 const page=await browser.newPage();await page.goto('https://partners.playfootball.net/ControlPanel/Dashboard',{waitUntil:'domcontentloaded'});await page.waitForTimeout(4000);
 console.log(JSON.stringify({path:new URL(page.url()).pathname,structure:await page.evaluate(()=>({loginForm:!!document.querySelector('input[type=password]'),challenge:Array.from(document.querySelectorAll('h1,h2,h3')).some(el=>/security verification/i.test(el.textContent||''))}))}));
}finally{await browser.close();}
