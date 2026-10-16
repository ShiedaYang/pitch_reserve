import type { Frame, Page } from 'playwright';
import type { ProviderId } from './domain.ts';
import {resources} from './domain.ts';

export interface Credentials { username:string; password:string; }
export interface LoginResult { kind:'AUTHENTICATED'|'CURRENT_SESSION'|'MANUAL_REQUIRED'|'FAILED'; message:string; }
const hosts:Record<ProviderId,string[]>= {
  ggcb:['ggcb.co.uk','www.ggcb.co.uk'],
  council:['towerhamlets-self.achieveservice.com'],
  playfootball:['partners.playfootball.net','www.playfootball.net']
};
export function parseCredentials(input:unknown):Credentials {
  if(!input || typeof input!=='object')throw new Error('请输入账号和密码');
  const {username,password}=input as Record<string,unknown>;
  if(typeof username!=='string' || !username.trim() || username.length>320 || typeof password!=='string' || !password || password.length>1024)throw new Error('请输入有效账号和密码');
  return {username:username.trim(),password};
}
function trusted(frame:Frame,provider:ProviderId) {
  try {return new URL(frame.url()).protocol==='https:' && hosts[provider].includes(new URL(frame.url()).hostname);}catch{return false;}
}
export async function authSignals(page:Page,provider:ProviderId) {
  // This exact official route redirects anonymous visitors to /Login.
  let authenticated=provider==='playfootball' && trusted(page.mainFrame(),provider) && new URL(page.url()).hostname==='partners.playfootball.net' && /^\/ControlPanel\/Dashboard\/?$/i.test(new URL(page.url()).pathname);let password=false;let challenge=false;
  const councilBooking=provider==='council' && trusted(page.mainFrame(),provider) && /^\/(?:en\/)?(?:service\/Book_a_sports_pitch\/?|AchieveForms\/?)$/.test(new URL(page.url()).pathname);
  for(const frame of page.frames()) {
    if(!trusted(frame,provider))continue;
    const signals=await frame.evaluate((councilBooking)=>{
      const visible=(el:Element)=>el.getClientRects().length>0 && getComputedStyle(el).visibility!=='hidden';
      const shown=(selector:string)=>Array.from(document.querySelectorAll(selector)).some(visible);
      // Council's authenticated wizard has no visible logout text. Recognize its
      // visible protected form structure, not a greeting or absence of errors.
      const pitchSetup=!!document.querySelector('#footbalPitch') && !!document.querySelector('input[name=TH_borough]') && Array.from(document.querySelectorAll('h1,h2,h3')).some(el=>visible(el) && (el.textContent||'').trim()==='Book a sports pitch');
      const wizard=councilBooking && (pitchSetup || shown('#addressSelector,#manual_addressLine1,#booking_day_selector,#time_selector'));
      return {
        authenticated:wizard || Array.from(document.querySelectorAll('a,button')).some(el=>visible(el) && /^(?:log\s*out|sign\s*out)$/i.test((el.textContent||el.getAttribute('aria-label')||'').trim())),
        password:Array.from(document.querySelectorAll('input[type=password]')).some(visible),
        challenge:Array.from(document.querySelectorAll('h1,h2,h3,[role=heading]')).some(el=>visible(el) && /security verification|verify you are human|two.factor|verification code|验证码/i.test(el.textContent||'')) || Array.from(document.querySelectorAll('input[autocomplete=one-time-code]')).some(visible)
      };
    },councilBooking).catch(()=>null);
    if(signals) {authenticated ||= signals.authenticated; password ||= signals.password; challenge ||= signals.challenge;}
  }
  return {authenticated:authenticated && !password && !challenge,password,challenge};
}

// Only login forms on the fixed provider hosts are eligible. No registration,
// CAPTCHA solving, booking selection, checkout or payment control is included.
export async function submitLogin(page:Page,provider:ProviderId,credentials:Credentials,assertControl:()=>void):Promise<LoginResult> {
  try {
    assertControl(); const initial=await authSignals(page,provider);
    if(initial.authenticated)return {kind:'CURRENT_SESSION',message:'官网已有登录会话；输入的账号仅在下次登录时使用。'};
    let loginFrame:Frame|undefined;let openedPanel=false;let openedCouncilEntry=false;
    const followCouncilHome=async()=>{
      if(provider!=='council' || openedCouncilEntry || !trusted(page.mainFrame(),provider) || new URL(page.url()).pathname!=='/')return;
      const signals=await authSignals(page,provider);if(signals.password || signals.challenge)return;
      // Successful Council login returns to account home. Only navigate to the
      // fixed read-only service entry; never fill eligibility or contact data.
      assertControl();await page.goto(resources.find(resource=>resource.provider==='council')!.url,{waitUntil:'domcontentloaded'});openedCouncilEntry=true;
    };
    for(let retry=0;retry<12;retry++) {
      assertControl();await followCouncilHome();const signals=await authSignals(page,provider);
      if(signals.authenticated)return {kind:'CURRENT_SESSION',message:'官网已有登录会话；输入的账号仅在下次登录时使用。'};
      if(signals.challenge)return {kind:'MANUAL_REQUIRED',message:'官网需要安全验证或验证码，请在专用浏览器完成后检测会话。'};
      if(provider==='playfootball' && !openedPanel && trusted(page.mainFrame(),provider) && new URL(page.url()).hostname==='partners.playfootball.net') {
        const trigger=page.locator('a[role=button][href="#log-in-bar"]:visible');
        if(await trigger.count()===1 && await page.locator('#log-in-bar input[type=password]').count()===1 && !signals.password) {
          assertControl();await trigger.click();openedPanel=true;
        }
      }
      loginFrame=page.frames().find(frame=>trusted(frame,provider) && frame===page.mainFrame());
      for(const frame of page.frames())if(trusted(frame,provider) && await frame.locator('input[type=password]:visible').count()===1) {loginFrame=frame;break;}
      if(loginFrame && await loginFrame.locator('input[type=password]:visible').count()===1)break;
      await page.waitForTimeout(500);
    }
    if(!loginFrame || await loginFrame.locator('input[type=password]:visible').count()!==1)return {kind:'MANUAL_REQUIRED',message:'未找到唯一的官网登录表单，请在专用浏览器接管。'};
    const password=loginFrame.locator('input[type=password]:visible');
    const form=password.locator('xpath=ancestor::form[1]');
    if(await form.count()!==1)return {kind:'MANUAL_REQUIRED',message:'官网登录表单结构尚未确认，请手动接管。'};
    const account=form.locator('input[autocomplete=username]:visible,input[type=email]:visible,input[name=username i]:visible,input[name=email i]:visible');
    const submit=form.getByRole('button',{name:/^(?:log\s*in|sign\s*in)$/i});
    if(await account.count()!==1 || await submit.count()!==1)return {kind:'MANUAL_REQUIRED',message:'账号或登录按钮不唯一，请在官网手动接管。'};
    assertControl();await account.fill(credentials.username);assertControl();await password.fill(credentials.password);assertControl();await submit.click();
    for(let retry=0;retry<24;retry++) {
      assertControl();await followCouncilHome();const signals=await authSignals(page,provider);
      if(signals.authenticated)return {kind:'AUTHENTICATED',message:'官网已确认登录成功。'};
      if(signals.challenge)return {kind:'MANUAL_REQUIRED',message:'官网要求验证码或安全验证，请在专用浏览器完成。'};
      await page.waitForTimeout(500);
    }
    return {kind:'MANUAL_REQUIRED',message:'官网尚未确认登录成功。请查看专用浏览器中的账号错误、验证码或后续步骤；不会自动重复提交。'};
  } catch {
    // Playwright errors can include fill() arguments. Never forward or log them.
    assertControl();return {kind:'FAILED',message:'自动登录未完成，请在专用浏览器检查后重试；不会自动重复提交。'};
  }
}
