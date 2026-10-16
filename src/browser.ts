import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loginUrls } from './domain.ts';
import { councilUserPage } from './council-page.ts';
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
  constructor(id: ProviderId, root: string) { this.id = id; this.root = root; }
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
        acceptDownloads: false, chromiumSandbox: true, timeout: 30000
      });
      context.setDefaultTimeout(12000); context.setDefaultNavigationTimeout(35000);
      const authFile = join(this.root, 'sessions', `${this.id}.json`);
      if (existsSync(authFile)) {
        const saved = JSON.parse(readFileSync(authFile, 'utf8'));
        // Persistent profiles retain origin storage; this also restores unexpired session cookies.
        if (Array.isArray(saved.cookies)) await context.addCookies(saved.cookies);
      }
      context.on('close', () => { this.context = undefined; this.pages.clear(); this.manualPage = undefined; this.status = 'UNKNOWN'; this.mode = 'PAUSED'; });
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
      const page = this.manualPage;
      if (!page || page.isClosed()) return this.status;
      // Read the user-owned page without navigating, refreshing, or collecting input values.
      const signals = await page.evaluate(() => ({
        password: Array.from(document.querySelectorAll('input[type=password]')).some(el => (el as HTMLElement).offsetParent !== null),
        logout: Array.from(document.querySelectorAll('a,button')).some(el => /^(log\s*out|sign\s*out)$/i.test((el.textContent || '').trim()))
      }));
      this.status = signals.password ? 'LOGIN_REQUIRED' : signals.logout ? 'AUTHENTICATED' : 'UNKNOWN';
      if (this.status === 'AUTHENTICATED') await this.saveSession();
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
      const page = this.manualPage && !this.manualPage.isClosed() ? this.manualPage : [...this.pages.values()].find(p=>!p.isClosed());
      if (!page) throw new Error('请先打开官网页面');
      const frames = [];
      for (const frame of page.frames()) frames.push(await frame.evaluate(() => ({
        headings: Array.from(document.querySelectorAll('h1,h2,h3,legend')).map(el=>(el as HTMLElement).innerText.trim()).filter(Boolean).slice(0,35),
        labels: Array.from(document.querySelectorAll('label')).map(el=>({text:(el.textContent||'').trim().slice(0,180),for:el.getAttribute('for')})).slice(0,70),
        selects: Array.from(document.querySelectorAll('select')).map(el=>({id:el.id,name:el.name,options:Array.from(el.options).map(o=>({value:o.value,label:o.text,selected:o.selected}))})),
        inputs: Array.from(document.querySelectorAll('input:not([type=hidden]):not([type=password])')).map(el=>({id:el.id,name:el.getAttribute('name'),type:el.getAttribute('type'),label:el.getAttribute('aria-label')})).slice(0,80),
        buttons: Array.from(document.querySelectorAll('button,input[type=submit],a[role=button]')).map(el=>({text:(el as HTMLElement).innerText||el.getAttribute('aria-label')||'',id:el.id})).filter(el=>el.text).slice(0,50),
        calendarText: Array.from(document.querySelectorAll('[role=grid],.ui-datepicker,.fc,.bookings-calendar')).map(el=>(el as HTMLElement).innerText.slice(0,6000)).slice(0,4)
      })).catch(()=>({unavailable:true})));
      return { provider:this.id, mode:this.mode, path:new URL(page.url()).pathname, frames };
    });
  }
  async close() { await this.saveSession().catch(()=>{}); await this.context?.close(); }
}
