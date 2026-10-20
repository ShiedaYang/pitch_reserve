import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loginUrls } from './domain.ts';
import { councilUserPage } from './council-page.ts';
import {parseCredentials} from './auth.ts';
import {loadAuth} from './auth-runtime.ts';
import type {Credentials,LoginResult} from './auth.ts';
import type {CredentialVault} from './credential-vault.ts';
import type { Mode, ProviderId, SessionStatus, Resource } from './domain.ts';
import {browserOptions} from './runtime-config.ts';

export class Interrupted extends Error {}
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
  attention?:{kind:'TIMEOUT'|'HUMAN_VERIFICATION';message:string;at:string};
  get mode(){return this.#mode;}
  set mode(value:Mode){this.modeRevision++;if(value==='MANUAL_CONTROL'&&this.#mode!==value){this.lastManualActivityAt=Date.now();this.nextIdleCheckAt=0;}this.#mode=value;}
  recordManualActivity(now=Date.now()){if(this.mode==='MANUAL_CONTROL'){this.lastManualActivityAt=now;this.nextIdleCheckAt=0;}}
  manualIdle(now=Date.now()){return this.mode==='MANUAL_CONTROL'&&!this.job&&now-this.lastManualActivityAt>=60000&&now>=this.nextIdleCheckAt;}
  async resumeAfterInactivity(now=Date.now()){
    if(!this.manualIdle(now))return false;
    const activity=this.lastManualActivityAt;this.nextIdleCheckAt=now+60000;
    try{await this.check();}catch{return false;}
    if(this.mode!=='MANUAL_CONTROL'||this.lastManualActivityAt!==activity||this.needsHumanVerification||this.attention&&this.status==='UNKNOWN'||this.status==='LOGIN_REQUIRED'&&!(this.hasCredentials&&this.automaticLoginAllowed))return false;
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
    const {authSignals,submitLogin}=await loadAuth();
    const credentials=this.#credentials;if(!credentials)throw new Error('请输入账号和密码');
    const assertControl=()=>{if(this.mode!==expectedMode || this.#credentials!==credentials)throw new Interrupted('已暂停，等待人工接管');};
    assertControl();const context=await this.getContext();assertControl();
    if(this.manualPage && !this.manualPage.isClosed() && (await authSignals(this.manualPage,this.id)).authenticated) {
      this.status='AUTHENTICATED';await this.saveSession();
      return this.loginResult={kind:'CURRENT_SESSION',message:'官网已有登录会话；新账号将在下次登录时使用。'};
    }
    try {
      if(!this.loginPage || this.loginPage.isClosed()){this.loginPage=await context.newPage();reuseExisting=false;}
      if(reuseExisting){const signals=await authSignals(this.loginPage,this.id);reuseExisting=signals.password || signals.challenge;}
      assertControl();if(!reuseExisting)await this.loginPage.goto(loginUrls[this.id],{waitUntil:'domcontentloaded'});
      this.manualPage=this.loginPage;await this.loginPage.bringToFront();
      const result=await submitLogin(this.loginPage,this.id,credentials,assertControl);
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
  constructor(id: ProviderId, root: string, vault?:CredentialVault) { this.id = id; this.root = root;this.vault=vault; }
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
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.job) throw new Error('该网站正在处理上一项操作，请稍后重试');
    const pending = Promise.resolve().then(fn); this.job = pending;
    try { return await pending; } finally { if (this.job === pending) this.job = undefined; }
  }
  async getContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (!this.opening) this.opening = (async () => {
      const profile = join(this.root, 'profiles', this.id); mkdirSync(profile, { recursive: true });
      const context = await queueBrowserLaunch(()=>chromium.launchPersistentContext(profile, {
        ...browserOptions(),
        viewport: null, locale: 'en-GB', timezoneId: 'Europe/London',
        acceptDownloads: false,
        args:['--disable-background-timer-throttling','--disable-renderer-backgrounding']
      }));
      context.setDefaultTimeout(12000); context.setDefaultNavigationTimeout(35000);
      await this.trackManualActivity(context);
      const authFile = join(this.root, 'sessions', `${this.id}.json`);
      if (existsSync(authFile)) {
        const saved = JSON.parse(readFileSync(authFile, 'utf8'));
        // Persistent profiles retain origin storage; this also restores unexpired session cookies.
        if (Array.isArray(saved.cookies)) await context.addCookies(saved.cookies);
      }
      context.on('close', () => { if(this.context!==context)return;this.context = undefined; this.pages.clear(); this.manualPage = undefined; this.loginPage=undefined; this.status = 'UNKNOWN'; this.needsHumanVerification=false;if(this.mode!=='PAUSED'&&!this.restarting){this.mode='AUTOMATION';this.nextScanAt=Date.now()+1000;} });
      this.context = context; return context;
    })().finally(() => { this.opening = undefined; });
    return this.opening;
  }
  async page(resource: Resource): Promise<Page> {
    this.assertAutomatic();
    if (resource.provider === 'council') {
      const current = await councilUserPage(this); this.assertAutomatic();
      if (current) return current;
    }
    const context = await this.getContext(); this.assertAutomatic();
    let page = this.pages.get(resource.id);
    if (!page || page.isClosed()) { page = await context.newPage(); this.pages.set(resource.id, page); }
    this.assertAutomatic(); await page.goto(resource.url, { waitUntil: 'domcontentloaded' }); this.assertAutomatic();
    return page;
  }
  async reopenResource(resource:Resource){
    this.assertAutomatic();const current=resource.provider==='council'?await councilUserPage(this):this.pages.get(resource.id);
    if(current&&!current.isClosed()){if(this.manualPage===current)this.manualPage=undefined;if(this.loginPage===current)this.loginPage=undefined;for(const [key,page] of this.pages)if(page===current)this.pages.delete(key);await current.close();}
    this.assertAutomatic();
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
      try{await page.goto(resource.url,{waitUntil:'domcontentloaded'});}catch{assertControl();this.mode=previousMode==='PAUSED'?'PAUSED':'MANUAL_CONTROL';this.attention={kind:'TIMEOUT',message:'浏览器已重新打开，但官网加载未完成，请手动接管。',at:new Date().toISOString()};this.recordManualActivity();return;}
      assertControl();await page.bringToFront();const signals=await (await loadAuth()).authSignals(page,this.id);assertControl();
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
    const {authSignals}=await loadAuth();
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
    return this.exclusive(async () => {
      const {authSignals}=await loadAuth();
      const page = this.id==='council'?(await councilUserPage(this)??this.manualPage):(this.manualPage??[...this.pages.values()].find(page=>!page.isClosed()));
      if (!page || page.isClosed()) return this.status;
      // Read the user-owned page without navigating, refreshing, or collecting input values.
      const signals=await authSignals(page,this.id);
      this.needsHumanVerification=signals.challenge;
      const readable=!signals.challenge&&await page.locator('#booking_day_selector:visible,#time_selector:visible,.bookings-calendar:visible,.bookings-calendar-date:visible,.booking-slot:visible,[data-date]:visible,.booking-calendar:visible').count()>0;
      this.status = signals.password ? 'LOGIN_REQUIRED' : signals.authenticated ? 'AUTHENTICATED' : readable?'ANONYMOUS_READABLE':'UNKNOWN';
      if (this.status === 'AUTHENTICATED') {this.automaticLoginAllowed=this.hasCredentials;await this.saveSession();}
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
      const {authSignals}=await loadAuth();
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
