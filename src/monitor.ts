import { ProviderSession, Interrupted } from './browser.ts';
import { providerIds, resources, targetDates } from './domain.ts';
import type { ProviderId, Resource, ScanResult } from './domain.ts';
import { statSync } from 'node:fs';
import type { Store } from './store.ts';

export class Monitor {
  store: Store;
  sessions: Map<ProviderId, ProviderSession>;
  timer?: NodeJS.Timeout;
  stopping = false;
  constructor(store: Store, root: string) { this.store = store; this.sessions = new Map(providerIds.map(id => [id, new ProviderSession(id, root)])); }
  state() {
    const policy = this.store.policy();
    return { policy, readOnly: true, providers: providerIds.map(id => {
      const s = this.sessions.get(id)!;
      return { id, mode: s.mode, session: s.status, busy: !!s.job, nextScanAt: s.nextScanAt ? new Date(s.nextScanAt).toISOString() : null, browserOpen: !!s.context };
    }), resources: resources.map(resource => ({ ...resource, latest: this.store.latest(resource.id) })), events: this.store.events() };
  }
  start() {
    this.timer = setInterval(() => { void this.tick(); }, 15000);
    void this.tick();
  }
  async tick() {
    if (this.stopping || !targetDates(this.store.policy()).length) return;
    await Promise.allSettled(providerIds.map(id => {
      const s = this.sessions.get(id)!;
      return s.mode === 'AUTOMATION' && !s.job && Date.now() >= s.nextScanAt ? this.scan(id) : Promise.resolve();
    }));
  }
  async scan(id: ProviderId) {
    const s = this.sessions.get(id)!; s.assertAutomatic();
    return s.exclusive(async () => {
      s.nextScanAt = Date.now() + this.store.policy().intervalMinutes * 60000;
      for (const resource of resources.filter(r => r.provider === id)) {
        s.assertAutomatic(); await this.scanResource(s, resource);
      }
    });
  }
  async scanResource(session: ProviderSession, resource: Resource) {
    const policy = this.store.policy(); let result: ScanResult;
    try {
      const page = await session.page(resource);
      const moduleUrl = new URL(`./adapters/${resource.provider}.ts`, import.meta.url);
      const adapter = await import(`${moduleUrl.href}?v=${statSync(moduleUrl).mtimeMs}`);
      if (resource.provider === 'playfootball') result = await adapter.scanPlayFootball(page, resource, policy, session);
      else if (resource.provider === 'ggcb') result = await adapter.scanGgcb(page, resource, policy, session);
      else result = await adapter.scanCouncil(page, policy, session);
      if (resource.provider !== 'council' && session.status !== 'AUTHENTICATED') session.status = 'ANONYMOUS_READABLE';
    } catch (error) {
      if (error instanceof Interrupted) return;
      const detail = error instanceof Error ? error.message.split('\n')[0].replace(/https?:\/\/\S+/g, '[官网地址]').slice(0, 220) : '未知异常';
      console.error(`${resource.id}: ${detail}`);
      const kind = error instanceof Error && /Timeout|timeout/i.test(error.name + error.message) ? '页面加载超时' : '浏览器或页面结构异常';
      result = { observations: [], coverage: targetDates(policy).map(date => ({ date, status: 'UNKNOWN', note: kind })), status: 'ERROR', summary: `${kind}；请打开页面检查。失败不代表没有空位。` };
    }
    this.store.saveScan(resource, result); this.store.event(`${resource.name}：${result.summary}`);
  }
  async action(id: ProviderId, action: string, resourceId?: string) {
    const s = this.sessions.get(id)!;
    if (action === 'login') { await s.manual(); this.store.event(`${id}：已交由用户手动登录，同网站扫描暂停`); }
    else if (action === 'open') {
      const resource = resources.find(r => r.id === resourceId && r.provider === id);
      if (!resource) throw new Error('场馆不存在');
      await s.manual(resource.url); this.store.event(`${resource.name}：已打开官网并暂停自动操作`);
    } else if (action === 'pause') { s.mode = 'PAUSED'; await s.job?.catch(() => {}); this.store.event(`${id}：监测已暂停`); }
    else if (action === 'check') { await s.check(); this.store.event(`${id}：会话检测 ${s.status}`); }
    else if (action === 'resume') {
      await s.check();
      if (s.status === 'LOGIN_REQUIRED') throw new Error('页面仍显示登录表单，请先在官网完成登录');
      s.mode = 'AUTOMATION'; s.nextScanAt = 0; void this.scan(id).catch(() => {}); this.store.event(`${id}：恢复只读监测`);
    } else if (action === 'scan') { void this.scan(id).catch(() => {}); }
    else throw new Error('不支持的操作');
  }
  async close() { this.stopping = true; clearInterval(this.timer); for (const s of this.sessions.values()) s.mode = 'PAUSED'; await Promise.allSettled([...this.sessions.values()].map(async s => { await s.job?.catch(() => {}); await s.close(); })); }
}
