import { ProviderSession, Interrupted } from './browser.ts';
import { providerIds, resources, targetDates } from './domain.ts';
import type { ProviderId, Resource, ScanResult } from './domain.ts';
import { statSync } from 'node:fs';
import type { Store } from './store.ts';
import {councilUserPage} from './council-page.ts';
import {CredentialVault} from './credential-vault.ts';

export class Monitor {
  store: Store;
  sessions: Map<ProviderId, ProviderSession>;
  timer?: NodeJS.Timeout;
  stopping = false;
  constructor(store: Store, root: string, persistCredentials=false) { this.store = store; const vault=persistCredentials?new CredentialVault(root):undefined;this.sessions = new Map(providerIds.map(id => [id, new ProviderSession(id, root,vault)])); }
  async restoreCredentials(){await Promise.all([...this.sessions.values()].map(session=>session.restoreCredentials()));}
  state() {
    const policy = this.store.policy();
    return { policy,councilDefaults:this.store.councilDefaults(), readOnly: true, providers: providerIds.map(id => {
      const s = this.sessions.get(id)!;
      return { id, mode: s.mode, session: s.status, busy: !!s.job, nextScanAt: s.nextScanAt ? new Date(s.nextScanAt).toISOString() : null, browserOpen: !!s.context,hasCredentials:s.hasCredentials,hasSavedCredentials:s.hasSavedCredentials,savedUsername:s.savedUsername??null,credentialError:s.credentialError,automaticLoginAllowed:s.automaticLoginAllowed,loginResult:s.loginResult };
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
      if(s.status==='LOGIN_REQUIRED' && s.hasCredentials && s.automaticLoginAllowed) {
        const result=await s.signInStored('AUTOMATION');
        if(result.kind!=='AUTHENTICATED' && result.kind!=='CURRENT_SESSION')return;
      }
      for (const resource of resources.filter(r => r.provider === id)) {
        s.assertAutomatic(); await this.scanResource(s, resource);
      }
    });
  }
  async scanResource(session: ProviderSession, resource: Resource, retriedLogin=false):Promise<void> {
    const policy = this.store.policy(); let result: ScanResult;
    try {
      const page = await session.page(resource);
      const moduleUrl = new URL(`./adapters/${resource.provider}.ts`, import.meta.url);
      const adapter = await import(`${moduleUrl.href}?v=${statSync(moduleUrl).mtimeMs}`);
      if (resource.provider === 'playfootball') result = await adapter.scanPlayFootball(page, resource, policy, session);
      else if (resource.provider === 'ggcb') result = await adapter.scanGgcb(page, resource, policy, session);
      else result = await adapter.scanCouncil(page, policy, session);
      if(result.status==='LOGIN_REQUIRED' && session.hasCredentials && session.automaticLoginAllowed && !retriedLogin) {
        const login=await session.signInStored('AUTOMATION');
        if(login.kind==='AUTHENTICATED' || login.kind==='CURRENT_SESSION') {
          if(resource.provider!=='council')return this.scanResource(session,resource,true);
          session.mode='MANUAL_CONTROL';
          result={observations:[],coverage:targetDates(policy).map(date=>({date,status:'UNKNOWN',note:'登录已恢复，需人工进入官网日历'})),status:'PARTIAL',summary:'已自动恢复登录；请在官网核对资格、资料并进入Book pitch日历后恢复监测。'};
        }
      }
      if(result.status==='LOGIN_REQUIRED')session.mode='MANUAL_CONTROL';
      if (resource.provider !== 'council' && session.status !== 'AUTHENTICATED') session.status = 'ANONYMOUS_READABLE';
    } catch (error) {
      if (error instanceof Interrupted) return;
      const detail = error instanceof Error ? error.message.split('\n')[0].replace(/https?:\/\/\S+/g, '[官网地址]').slice(0, 220) : '未知异常';
      console.error(`${resource.id}: ${detail}`);
      const kind = error instanceof Error && /Timeout|timeout/i.test(error.name + error.message) ? '页面加载超时' : '浏览器或页面结构异常';
      result = { observations: [], coverage: targetDates(policy).map(date => ({ date, status: 'UNKNOWN', note: kind })), status: 'ERROR', summary: `${kind}；请打开页面检查。失败不代表没有空位。` };
    }
    result.observations=result.observations.map(observation=>({...observation,bookingUrl:resource.url,priceNote:observation.priceNote || (observation.price?'官网时段报价，结算前需复核':'官网报价尚未读取')}));
    this.store.saveScan(resource, result); this.store.event(`${resource.name}：${result.summary}`);
  }
  async automaticLogin(id:ProviderId,input:unknown,retry=false) {
    const session=this.sessions.get(id)!;const result=await (retry?session.retrySignIn():session.signIn(input));
    this.store.event(`${id}：${result.message}`);
    if(result.kind==='AUTHENTICATED' || result.kind==='CURRENT_SESSION') {
      if(id==='council') {session.mode='MANUAL_CONTROL';result.message+=' 请在官网进入Book pitch日历后恢复监测。';}
      else {session.mode='AUTOMATION';session.nextScanAt=0;void this.scan(id).catch(()=>{});}
    }
    return result;
  }
  async openSlot(resourceId:unknown,date:unknown,start:unknown) {
    const resource=resources.find(resource=>resource.id===resourceId);
    if(!resource || typeof date!=='string' || start!=='18:00')throw new Error('场馆或场次不存在');
    const observation=this.store.latest(resource.id)?.result.observations.find(o=>o.date===date && o.start===start && o.availability==='AVAILABLE');
    if(!observation)throw new Error('该场次观察已更新，请刷新列表后重试');
    await this.action(resource.provider,'open',resource.id);
    return {message:`已打开${resource.name}官网入口并交由你接管。请在官网核对${date} ${start}场次、租期和报价；尚未选择或锁位。`,url:resource.url};
  }
  async prepareCouncil() {
    const defaults=this.store.councilDefaults();if(!defaults)throw new Error('Council默认选项尚未保存');
    const session=this.sessions.get('council')!;session.mode='MANUAL_CONTROL';await session.job?.catch(()=>{});
    return session.exclusive(async()=>{
      const page=await councilUserPage(session);if(!page)throw new Error('请先登录Council并打开场地表单');
      const url=new URL('./council-setup.ts',import.meta.url);const {prepareCouncil}=await import(`${url.href}?v=${statSync(url).mtimeMs}`) as typeof import('./council-setup.ts');
      const result=await prepareCouncil(page,defaults,session);await session.saveSession();this.store.event(`Council：${result.message}`);return result;
    });
  }
  async action(id: ProviderId, action: string, resourceId?: string) {
    const s = this.sessions.get(id)!;
    if (action === 'login') { await s.manual(); this.store.event(`${id}：已交由用户手动登录，同网站扫描暂停`); }
    else if (action === 'open') {
      const resource = resources.find(r => r.id === resourceId && r.provider === id);
      if (!resource) throw new Error('场馆不存在');
      const current=id==='council'?await councilUserPage(s):undefined;
      await s.manual(current?undefined:resource.url); this.store.event(`${resource.name}：已打开官网并暂停自动操作`);
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
