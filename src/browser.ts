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

export class Interrupted extends Error {}
export class ProviderSession {
  id: ProviderId;
  root: string;
  mode: Mode = 'AUTOMATION';
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
    if(generation!==this.#credentialGeneration)throw new Interrupted('已暂停，等待人工接管');
    this.#credentials=credentials;this.automaticLoginAllowed=true;
    return this.exclusive(async()=>{
      if(this.vault) {
        try{await this.vault.save(this.id,credentials);if(generation===this.#credentialGeneration){this.hasSavedCredentials=true;this.#savedUsername=credentials.username;this.credentialError=undefined;}}
        catch{this.credentialError='账号尚未保存到本机，请检查 Windows 加密存储后重试。';this.automaticLoginAllowed=false;throw new Error('本地凭据保存失败，请重试');}
      }
      if(generation!==this.#credentialGeneration)throw new Interrupted('已暂停，等待人工接管');
      return this.signInStored('MANUAL_CONTROL');
    });
  }
  async retrySignIn() {
    if(!this.#credentials)throw new Error('请输入账号和密码');
    this.mode='MANUAL_CONTROL';await this.job?.catch(()=>{});this.automaticLoginAllowed=true;
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
      else {this.status='LOGIN_REQUIRED';this.automaticLoginAllowed=false;this.mode='MANUAL_CONTROL';}
      return result;
    } catch(error) {
      if(error instanceof Interrupted)throw error;
      this.mode='MANUAL_CONTROL';this.automaticLoginAllowed=false;this.status='UNKNOWN';
      return this.loginResult={kind:'FAILED',message:'自动登录未完成，请在专用浏览器检查页面后重试。'};
    }
  }
  constructor(id: ProviderId, root: string, vault?:CredentialVault) { this.id = id; this.root = root;this.vault=vault; }
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
      const context = await chromium.launchPersistentContext(profile, {
        channel: process.env.PITCH_BROWSER_CHANNEL || 'msedge', headless: false,
        viewport: null, locale: 'en-GB', timezoneId: 'Europe/London',
        acceptDownloads: false, chromiumSandbox: true, timeout: 30000,
        args:['--disable-background-timer-throttling','--disable-renderer-backgrounding']
      });
      context.setDefaultTimeout(12000); context.setDefaultNavigationTimeout(35000);
      const authFile = join(this.root, 'sessions', `${this.id}.json`);
      if (existsSync(authFile)) {
        const saved = JSON.parse(readFileSync(authFile, 'utf8'));
        // Persistent profiles retain origin storage; this also restores unexpired session cookies.
        if (Array.isArray(saved.cookies)) await context.addCookies(saved.cookies);
      }
      context.on('close', () => { this.context = undefined; this.pages.clear(); this.manualPage = undefined; this.loginPage=undefined; this.status = 'UNKNOWN'; this.mode = 'PAUSED'; });
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
  async manual(url?: string) {
    this.mode = 'MANUAL_CONTROL';
    // Drain any in-flight navigation before handing the browser to the user.
    await this.job?.catch(() => {});
    return this.exclusive(async () => {
      const context = await this.getContext();
      if (!this.manualPage || this.manualPage.isClosed()) this.manualPage = await context.newPage();
      if (this.manualPage.url() === 'about:blank' || url) await this.manualPage.goto(url || loginUrls[this.id], { waitUntil: 'domcontentloaded' });
      await this.manualPage.bringToFront();
    });
  }
  async check(): Promise<SessionStatus> {
    return this.exclusive(async () => {
      const {authSignals}=await loadAuth();
      const page = this.manualPage;
      if (!page || page.isClosed()) return this.status;
      // Read the user-owned page without navigating, refreshing, or collecting input values.
      const signals=await authSignals(page,this.id);
      this.status = signals.password ? 'LOGIN_REQUIRED' : signals.authenticated ? 'AUTHENTICATED' : 'UNKNOWN';
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
