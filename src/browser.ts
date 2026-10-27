import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loginUrls,resources } from './domain.ts';
import {NativeVerification,verificationBrowser} from './native-verification.ts';
import { councilUserPage } from './council-page.ts';
import {parseCredentials,authSignals,submitLogin} from './auth.ts';
import type {Credentials,LoginResult} from './auth.ts';
import type {CredentialVault} from './credential-vault.ts';
import type { Mode, ProviderId, SessionStatus, Resource } from './domain.ts';
import {browserOptions} from './runtime-config.ts';

export class Interrupted extends Error {}
export interface WebActionClock { now():number; sleep(ms:number):Promise<void>; }
const webActionClock:WebActionClock={now:()=>performance.now(),sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms))};
let browserLaunch:Promise<unknown>|undefined;
export async function queueBrowserLaunch<T>(launch:()=>Promise<T>):Promise<T>{
  const job=(browserLaunch??Promise.resolve()).catch(()=>{}).then(launch);browserLaunch=job;
  try{return await job;}finally{if(browserLaunch===job)browserLaunch=undefined;}
}
export class ProviderSession {
  id: ProviderId;
  root: string;
  #mode:Mode='AUTOMATION';
  modeRevision=0;
  restarting=false;
  lastManualActivityAt=0;
  nextIdleCheckAt=0;
  needsHumanVerification=false;
  nativeVerification:NativeVerification;
  private verifiedPage?:Page;
  private nextWebActionAt=0;
  private readonly actionClock:WebActionClock;
  attention?:{kind:'TIMEOUT'|'HUMAN_VERIFICATION';message:string;at:string};
  get mode(){return this.#mode;}
  set mode(value:Mode){this.modeRevision++;if(value==='MANUAL_CONTROL'&&this.#mode!==value){this.lastManualActivityAt=Date.now();this.nextIdleCheckAt=0;}this.#mode=value;}
  recordManualActivity(now=Date.now()){if(this.mode==='MANUAL_CONTROL'){this.lastManualActivityAt=now;this.nextIdleCheckAt=0;}}
  manualIdle(now=Date.now()){return this.mode==='MANUAL_CONTROL'&&!this.job&&now-this.lastManualActivityAt>=60000&&now>=this.nextIdleCheckAt;}
  async resumeAfterInactivity(now=Date.now()){
    if(this.nativeVerification.active)return false;
    if(!this.manualIdle(now))return false;
    const activity=this.lastManualActivityAt;this.nextIdleCheckAt=now+60000;
    if(this.nativeVerification.pending){
      try{await this.exclusive(async()=>{
        const context=await this.getContext();if(this.mode!=='MANUAL_CONTROL')throw new Interrupted();
        const resource=resources.find(row=>row.provider===this.id)!;const page=await context.newPage();this.manualPage=page;this.pages.set(resource.id,page);this.nativeVerification.clear();
        await this.webAction(()=>page.goto(resource.url,{waitUntil:'domcontentloaded'}),()=>{if(this.mode!=='MANUAL_CONTROL'||this.lastManualActivityAt!==activity)throw new Interrupted();});
        await page.locator('.bookings-calendar,.booking-slot').first().waitFor({state:'visible',timeout:12000}).catch(()=>{});
      });}catch{return false;}
    }
    const wasChallenge=this.needsHumanVerification;
    try{await this.check();}catch{return false;}
    if(this.mode!=='MANUAL_CONTROL'||this.lastManualActivityAt!==activity||this.needsHumanVerification||this.attention&&this.status==='UNKNOWN'||this.status==='LOGIN_REQUIRED'&&!(this.hasCredentials&&this.automaticLoginAllowed))return false;
    if(wasChallenge&&this.id==='playfootball'&&this.manualPage){this.verifiedPage=this.manualPage;await this.saveSession();}
    this.attention=undefined;this.mode='AUTOMATION';this.nextScanAt=0;return true;
  }
  status: SessionStatus = 'UNKNOWN';
  context?: BrowserContext;
  opening?: Promise<BrowserContext>;
  pages = new Map<string, Page>();
  manualPage?: Page;
  job?: Promise<unknown>;
  nextScanAt: number = 0;
  #credentials?:Credentials;
  #savedUsername?:string;
  #credentialGeneration=0;
  vault?:CredentialVault;
  hasSavedCredentials=false;
  credentialError?:string;
  loginPage?:Page;
  loginResult?:LoginResult;
  automaticLoginAllowed=false;
  get hasCredentials() {return !!this.#credentials;}
  get savedUsername() {return this.#savedUsername;}
  async forgetCredentials() {this.#credentialGeneration++;this.#credentials=undefined;this.automaticLoginAllowed=false;this.loginResult=undefined;await this.vault?.remove(this.id);this.hasSavedCredentials=false;this.#savedUsername=undefined;this.credentialError=undefined;}
  async restoreCredentials() {
    try{this.#credentials=await this.vault?.load(this.id);this.hasSavedCredentials=this.hasCredentials;this.#savedUsername=this.#credentials?.username;this.automaticLoginAllowed=this.hasCredentials;}
    catch{this.credentialError='本地凭据无法读取或解密，请重新保存账号。';}
  }
  async signIn(input:unknown) {
    const credentials=parseCredentials(input);
    const generation=++this.#credentialGeneration;
    this.mode='MANUAL_CONTROL';await this.job?.catch(()=>{});
    this.recordManualActivity();
    if(generation!==this.#credentialGeneration)throw new Interrupted('已暂停，等待人工接管');
    this.#credentials=credentials;this.automaticLoginAllowed=true;
    return this.exclusive(async()=>{
      if(this.vault) {
        try{await this.vault.save(this.id,credentials);if(generation===this.#credentialGeneration){this.hasSavedCredentials=true;this.#savedUsername=credentials.username;this.credentialError=undefined;}}
        catch{this.credentialError='账号尚未保存，请检查当前系统的加密存储后重试。';this.automaticLoginAllowed=false;throw new Error('本地凭据保存失败，请重试');}
      }
      if(generation!==this.#credentialGeneration)throw new Interrupted('已暂停，等待人工接管');
      return this.signInStored('MANUAL_CONTROL');
    });
  }
  async retrySignIn() {
    if(!this.#credentials)throw new Error('请输入账号和密码');
    this.mode='MANUAL_CONTROL';await this.job?.catch(()=>{});this.automaticLoginAllowed=true;
    this.recordManualActivity();
    return this.exclusive(()=>this.signInStored('MANUAL_CONTROL',true));
  }
  async signInStored(expectedMode:Mode,reuseExisting=false):Promise<LoginResult> {
    const credentials=this.#credentials;if(!credentials)throw new Error('请输入账号和密码');
    const revision=this.modeRevision;
    const assertControl=()=>{if(this.mode!==expectedMode || this.modeRevision!==revision || this.#credentials!==credentials)throw new Interrupted('已暂停，等待人工接管');};
    assertControl();const context=await this.getContext();assertControl();
    if(this.manualPage && !this.manualPage.isClosed() && (await authSignals(this.manualPage,this.id)).authenticated) {
      this.status='AUTHENTICATED';await this.saveSession();
      return this.loginResult={kind:'CURRENT_SESSION',message:'官网已有登录会话；新账号将在下次登录时使用。'};
    }
    try {
      if(!this.loginPage || this.loginPage.isClosed()){this.loginPage=await context.newPage();reuseExisting=false;}
      if(reuseExisting){const signals=await authSignals(this.loginPage,this.id);reuseExisting=signals.password || signals.challenge;}
      assertControl();if(!reuseExisting)await this.webAction(()=>this.loginPage!.goto(loginUrls[this.id],{waitUntil:'domcontentloaded'}),assertControl);
      this.manualPage=this.loginPage;await this.loginPage.bringToFront();
      const result=await submitLogin(this.loginPage,this.id,credentials,assertControl,action=>this.webAction(action,assertControl));
      this.loginResult=result;
      if(result.kind==='AUTHENTICATED' || result.kind==='CURRENT_SESSION') {this.status='AUTHENTICATED';await this.saveSession();}
      else {this.status='LOGIN_REQUIRED';this.automaticLoginAllowed=false;this.mode='MANUAL_CONTROL';this.recordManualActivity();}
      return result;
    } catch(error) {
      if(error instanceof Interrupted)throw error;
      this.mode='MANUAL_CONTROL';this.recordManualActivity();this.automaticLoginAllowed=false;this.status='UNKNOWN';
      return this.loginResult={kind:'FAILED',message:'自动登录未完成，请在专用浏览器检查页面后重试。'};
    }
  }
  constructor(id: ProviderId, root: string, vault?:CredentialVault,clock:WebActionClock=webActionClock) { this.id = id; this.root = root;this.vault=vault;this.actionClock=clock;this.nativeVerification=new NativeVerification(root,id);if(this.nativeVerification.pending){this.mode='MANUAL_CONTROL';this.needsHumanVerification=true;this.attention={kind:'HUMAN_VERIFICATION',message:'普通浏览器验证中：请完成验证并关闭该专用窗口，随后自动接回只读监测。',at:new Date().toISOString()};} }
  async trackManualActivity(context:BrowserContext){
    await context.exposeBinding('__pitchManualActivity',()=>this.recordManualActivity());
    const install=()=>{
      const host=globalThis as typeof globalThis & {__pitchActivityInstalled?:boolean;__pitchManualActivity?:()=>Promise<void>};
      if(host.__pitchActivityInstalled)return;host.__pitchActivityInstalled=true;
      let timer:ReturnType<typeof setTimeout>|undefined;let last=0;
      const notify=()=>{last=Date.now();void host.__pitchManualActivity?.().catch(()=>{});};
      const activity=(event:Event)=>{if(!event.isTrusted)return;clearTimeout(timer);if(Date.now()-last>=1000)notify();else timer=setTimeout(notify,1000-(Date.now()-last));};
      for(const kind of ['pointerdown','keydown','input','change','wheel','touchstart'])document.addEventListener(kind,activity,{capture:true,passive:true});
    };
    await context.addInitScript(install);
    for(const page of context.pages())for(const frame of page.frames())await frame.evaluate(install).catch(()=>{});
  }
  assertAutomatic() { if (this.mode !== 'AUTOMATION') throw new Interrupted('已暂停，等待人工接管'); }
  async webAction<T>(action:()=>Promise<T>,assertControl=()=>this.assertAutomatic()):Promise<T> {
    const revision=this.modeRevision;
    const check=()=>{assertControl();if(this.modeRevision!==revision)throw new Interrupted('已暂停，等待人工接管');};
    check();
    if(this.id!=='playfootball')return action();
    // Both venues and login share this deadline, including failed/reopened pages.
    while(this.nextWebActionAt>this.actionClock.now()) {
      await this.actionClock.sleep(Math.min(100,this.nextWebActionAt-this.actionClock.now()));
      check();
    }
    check();
    try{return await action();}
    finally{this.nextWebActionAt=this.actionClock.now()+10000;}
  }
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.job) throw new Error('该网站正在处理上一项操作，请稍后重试');
    const pending = Promise.resolve().then(fn); this.job = pending;
    try { return await pending; } finally { if (this.job === pending) this.job = undefined; }
  }
  async getContext(): Promise<BrowserContext> {
    if(this.nativeVerification.active)throw new Error('请先关闭普通浏览器验证窗口，再操作此网站。');
    if (this.context) return this.context;
    if (!this.opening) this.opening = (async () => {
      const profile = join(this.root, 'profiles', this.id); mkdirSync(profile, { recursive: true });
      const context = await queueBrowserLaunch(()=>chromium.launchPersistentContext(profile, {
        ...browserOptions(),
        viewport: null, locale: 'en-GB', timezoneId: 'Europe/London',
        acceptDownloads: false,
        args:['--disable-background-timer-throttling','--disable-renderer-backgrounding']
      }));
      try{
      context.setDefaultTimeout(12000); context.setDefaultNavigationTimeout(35000);
      await this.trackManualActivity(context);
      const authFile = join(this.root, 'sessions', `${this.id}.json`);
      if (existsSync(authFile)) {
        const saved = JSON.parse(readFileSync(authFile, 'utf8'));
        // Persistent profiles retain origin storage; this also restores unexpired session cookies.
        if (Array.isArray(saved.cookies)) {
          const existing=await context.cookies();const key=(cookie:{name:string;domain:string;path:string;partitionKey?:string})=>JSON.stringify([cookie.name,cookie.domain,cookie.path,cookie.partitionKey??'']);const current=new Set(existing.map(key));
          const missing=saved.cookies.filter((cookie:any)=>!current.has(key(cookie))&&(cookie.expires===-1||cookie.expires>Date.now()/1000)&&!/^cf_|^__cf|^_cfuvid$/i.test(cookie.name));
          if(missing.length)await context.addCookies(missing);
        }
      }
      context.on('close', () => { if(this.context!==context)return;this.context = undefined; this.pages.clear(); this.manualPage = undefined; this.loginPage=undefined; this.status = 'UNKNOWN'; this.needsHumanVerification=false;if(this.mode!=='PAUSED'&&!this.restarting){this.mode='AUTOMATION';this.nextScanAt=Date.now()+1000;} });
      this.context = context; return context;
      }catch(error){await context.close().catch(()=>{});throw error;}
    })().finally(() => { this.opening = undefined; });
    return this.opening;
  }
  async page(resource: Resource): Promise<Page> {
    this.assertAutomatic();
    if(this.verifiedPage&&!this.verifiedPage.isClosed()&&this.verifiedPage.url()===resource.url){const page=this.verifiedPage;this.verifiedPage=undefined;this.pages.set(resource.id,page);return page;}
    if (resource.provider === 'council') {
      const current = await councilUserPage(this); this.assertAutomatic();
      if (current) return current;
    }
    const context = await this.getContext(); this.assertAutomatic();
    let page = this.pages.get(resource.id);
    if (!page || page.isClosed()) { page = await context.newPage(); this.pages.set(resource.id, page); }
    this.assertAutomatic(); await this.webAction(()=>page!.goto(resource.url, { waitUntil: 'domcontentloaded' })); this.assertAutomatic();
    return page;
  }
  async reopenResource(resource:Resource){
    this.assertAutomatic();const current=resource.provider==='council'?await councilUserPage(this):this.pages.get(resource.id);
    if(current&&!current.isClosed()){
      await this.webAction(()=>current.close());
      if(this.manualPage===current)this.manualPage=undefined;if(this.loginPage===current)this.loginPage=undefined;
      for(const [key,page] of this.pages)if(page===current)this.pages.delete(key);
    }
    this.assertAutomatic();
  }
  async verifyInBrowser(){
    if(this.id!=='playfootball')throw new Error('普通浏览器验证目前仅用于 PlayFootball。');
    if(this.restarting||this.nativeVerification.active)throw new Error('请先关闭普通浏览器验证窗口，再操作此网站。');
    verificationBrowser(); // Validate before closing the current browser.
    const previousJob=this.job;this.restarting=true;this.mode='PAUSED';const revision=this.modeRevision;
    const work=Promise.resolve().then(async()=>{
      await this.opening?.catch(()=>{});await this.saveSession();await this.context?.close();await previousJob?.catch(()=>{});
      if(this.modeRevision!==revision)throw new Interrupted('已暂停，等待人工接管');
      this.context=undefined;this.pages.clear();this.manualPage=undefined;this.loginPage=undefined;this.verifiedPage=undefined;
      await this.nativeVerification.open(join(this.root,'profiles',this.id),resources.find(row=>row.provider===this.id)!.url);
      if(this.modeRevision===revision)this.mode='MANUAL_CONTROL';
      this.needsHumanVerification=true;this.status='UNKNOWN';this.attention={kind:'HUMAN_VERIFICATION',message:'普通浏览器验证中：请完成验证并关闭该专用窗口，随后自动接回只读监测。',at:new Date().toISOString()};this.recordManualActivity();
    });this.job=work;
    try{await work;}catch(error){if(this.modeRevision===revision)this.mode='MANUAL_CONTROL';throw error;}
    finally{if(this.job===work)this.job=undefined;this.restarting=false;}
  }
  async restartBrowser(resource:Resource){
    if(this.restarting)throw new Error('该网站浏览器正在重启，请稍后再试');
    const previousMode=this.mode,previousJob=this.job;this.restarting=true;this.mode='PAUSED';const revision=this.modeRevision;
    const assertControl=()=>{if(this.modeRevision!==revision)throw new Interrupted('已暂停，等待人工接管');};
    const job=Promise.resolve().then(async()=>{
      if(this.opening)await this.opening.catch(()=>{});
      await this.saveSession().catch(()=>{});
      // Closing a persistent Playwright context terminates its owned browser.
      // Close before draining the scan so an in-flight navigation can be cancelled.
      await this.context?.close();await previousJob?.catch(()=>{});assertControl();
      this.context=undefined;this.pages.clear();this.manualPage=undefined;this.loginPage=undefined;this.attention=undefined;this.needsHumanVerification=false;this.status='UNKNOWN';
      const context=await this.getContext();assertControl();
      const page=await context.newPage();assertControl();this.pages.set(resource.id,page);this.manualPage=page;
      try{await this.webAction(()=>page.goto(resource.url,{waitUntil:'domcontentloaded'}),assertControl);}catch{assertControl();this.mode=previousMode==='PAUSED'?'PAUSED':'MANUAL_CONTROL';this.attention={kind:'TIMEOUT',message:'浏览器已重新打开，但官网加载未完成，请手动接管。',at:new Date().toISOString()};this.recordManualActivity();return;}
      assertControl();await page.bringToFront();const signals=await authSignals(page,this.id);assertControl();
      this.status=signals.password?'LOGIN_REQUIRED':signals.authenticated?'AUTHENTICATED':'UNKNOWN';this.needsHumanVerification=signals.challenge;
      this.mode=previousMode;
      if(signals.challenge){this.attention={kind:'HUMAN_VERIFICATION',message:'暂无信息：官网出现人机验证，请手动接管完成验证；验证期间停止自动刷新。',at:new Date().toISOString()};if(previousMode!=='PAUSED')this.mode='MANUAL_CONTROL';}
      else if(signals.password&&!(this.hasCredentials&&this.automaticLoginAllowed)&&previousMode!=='PAUSED')this.mode='MANUAL_CONTROL';
      this.recordManualActivity();this.nextScanAt=0;
    });this.job=job;
    try{await job;}catch(error){if(error instanceof Interrupted)throw error;if(this.modeRevision===revision){this.mode=previousMode==='PAUSED'?'PAUSED':'MANUAL_CONTROL';this.recordManualActivity();}throw new Error('浏览器重启失败，请稍后重试或手动接管；已保存账号未清除。');}
    finally{if(this.job===job)this.job=undefined;this.restarting=false;}
  }
  async challengePage(){
    for(const page of this.context?.pages()??[]){if(!page.isClosed()&&(await authSignals(page,this.id)).challenge)return page;}
  }
  async requireManual(kind:'TIMEOUT'|'HUMAN_VERIFICATION',message:string,page?:Page){
    this.mode='MANUAL_CONTROL';this.attention={kind,message,at:new Date().toISOString()};this.needsHumanVerification=kind==='HUMAN_VERIFICATION';
    if(page&&!page.isClosed()){this.manualPage=page;await page.bringToFront().catch(()=>{});}this.recordManualActivity();
  }
  async manual(url?: string) {
    this.mode = 'MANUAL_CONTROL';
    this.recordManualActivity();
    // Drain any in-flight navigation before handing the browser to the user.
    await this.job?.catch(() => {});
    return this.exclusive(async () => {
      const context = await this.getContext();
      if (!this.manualPage || this.manualPage.isClosed()) this.manualPage = await context.newPage();
      if (this.manualPage.url() === 'about:blank' || url) await this.manualPage.goto(url || loginUrls[this.id], { waitUntil: 'domcontentloaded' });
      await this.manualPage.bringToFront();
      this.recordManualActivity();
    });
  }
  async check(): Promise<SessionStatus> {
    if(this.nativeVerification.active)return this.status;
    return this.exclusive(async () => {
      const page = this.id==='council'?(await councilUserPage(this)??this.manualPage):(this.manualPage??[...this.pages.values()].find(page=>!page.isClosed()));
      if (!page || page.isClosed()) return this.status;
      // Read the user-owned page without navigating, refreshing, or collecting input values.
      const signals=await authSignals(page,this.id);
      this.needsHumanVerification=signals.challenge;
      const readable=!signals.challenge&&await page.locator('#booking_day_selector:visible,#time_selector:visible,.bookings-calendar:visible,.bookings-calendar-date:visible,.booking-slot:visible,[data-date]:visible,.booking-calendar:visible').count()>0;
      this.status = signals.password ? 'LOGIN_REQUIRED' : signals.authenticated ? 'AUTHENTICATED' : readable?'ANONYMOUS_READABLE':'UNKNOWN';
      if (this.status === 'AUTHENTICATED') this.automaticLoginAllowed=this.hasCredentials;
      if(this.status==='AUTHENTICATED'||this.status==='ANONYMOUS_READABLE')await this.saveSession();
      return this.status;
    });
  }
  async saveSession() {
    if (!this.context) return;
    const folder = join(this.root, 'sessions'); mkdirSync(folder, { recursive: true });
    await this.context.storageState({ path: join(folder, `${this.id}.json`) });
  }
  async inspect() {
    return this.exclusive(async () => {
      const page = await councilUserPage(this) || (this.manualPage && !this.manualPage.isClosed() ? this.manualPage : [...this.pages.values()].find(p=>!p.isClosed()));
      if (!page) throw new Error('请先打开官网页面');
      const frames = [];
      for (const frame of page.frames()) frames.push(await frame.evaluate(() => ({
        headings: Array.from(document.querySelectorAll('h1,h2,h3,legend')).map(el=>(el as HTMLElement).innerText.trim()).filter(Boolean).slice(0,35),
        labels: Array.from(document.querySelectorAll('label')).map(el=>({text:(el.textContent||'').trim().slice(0,180),for:el.getAttribute('for')})).slice(0,70),
        selects: Array.from(document.querySelectorAll('select')).map(el=>({id:el.id,name:el.name,options:Array.from(el.options).map(o=>({value:o.value,label:o.text,selected:o.selected}))})),
        inputs: Array.from(document.querySelectorAll('input:not([type=hidden]):not([type=password])')).map(el=>({id:el.id,name:el.getAttribute('name'),type:el.getAttribute('type'),label:el.getAttribute('aria-label')})).slice(0,80),
        loginStructure: {passwords:document.querySelectorAll('input[type=password]').length,visiblePasswords:Array.from(document.querySelectorAll('input[type=password]')).filter(el=>el.getClientRects().length>0 && getComputedStyle(el).visibility!=='hidden').length,forms:document.forms.length,loginPanelTrigger:!!document.querySelector('a[role=button][href="#log-in-bar"]')},
        buttons: Array.from(document.querySelectorAll('button,input[type=submit],a[role=button]')).map(el=>({text:(el as HTMLElement).innerText||el.getAttribute('aria-label')||'',id:el.id})).filter(el=>el.text).slice(0,50),
        calendarText: Array.from(document.querySelectorAll('[role=grid],.ui-datepicker,.fc,.bookings-calendar')).map(el=>(el as HTMLElement).innerText.slice(0,6000)).slice(0,4)
      })).catch(()=>({unavailable:true})));
      return { provider:this.id, mode:this.mode, path:new URL(page.url()).pathname, auth:await authSignals(page,this.id),frames };
    });
  }
  async close() {this.#credentialGeneration++;this.#credentials=undefined;this.automaticLoginAllowed=false;await this.saveSession().catch(()=>{}); await this.context?.close(); }
}
