import { ProviderSession, Interrupted } from './browser.ts';
import { providerIds, resources, targetDates } from './domain.ts';
import type { ProviderId, Resource, ScanResult } from './domain.ts';
import { statSync } from 'node:fs';
import type { Store } from './store.ts';
import {councilUserPage} from './council-page.ts';
import {CredentialVault} from './credential-vault.ts';
import {browserOptions,manualBrowserUrl} from './runtime-config.ts';

export class Monitor {
  store: Store;
  sessions: Map<ProviderId, ProviderSession>;
  timer?: NodeJS.Timeout;
  stopping = false;
  constructor(store: Store, root: string, persistCredentials=false) { this.store = store; const vault=persistCredentials?new CredentialVault(root):undefined;this.sessions = new Map(providerIds.map(id => [id, new ProviderSession(id, root,vault)])); }
  async restoreCredentials(){await Promise.all([...this.sessions.values()].map(session=>session.restoreCredentials()));}
  state() {
    const policy = this.store.policy();
    this.store.notifications.expire(policy);
    return { policy,notifications:{...this.store.notifications.list(),summary:this.store.notifications.summary(),deliveryConfigured:false},councilDefaults:this.store.councilDefaults(), readOnly: true, providers: providerIds.map(id => {
      const s = this.sessions.get(id)!;
      return { id, mode: s.mode, session: s.status, busy: !!s.job,restarting:s.restarting,attention:s.attention??null,manualBrowserUrl:manualBrowserUrl(),headless:browserOptions().headless,autoResumeAt:s.mode==='MANUAL_CONTROL'?new Date(Math.max(s.lastManualActivityAt+60000,s.nextIdleCheckAt)).toISOString():null, nextScanAt: s.nextScanAt ? new Date(s.nextScanAt).toISOString() : null, browserOpen: !!s.context,hasCredentials:s.hasCredentials,hasSavedCredentials:s.hasSavedCredentials,savedUsername:s.savedUsername??null,credentialError:s.credentialError,automaticLoginAllowed:s.automaticLoginAllowed,loginResult:s.loginResult };
    }),incidents:this.store.incidents.list(), resources: resources.map(resource => ({ ...resource, latest: this.store.latest(resource.id) })), events: this.store.events() };
  }
  start() {
    this.timer = setInterval(() => { void this.tick(); }, 5000);
    void this.tick();
  }
  async tick() {
    if (this.stopping || !targetDates(this.store.policy()).length) return;
    await Promise.allSettled(providerIds.map(async id => {
      const s = this.sessions.get(id)!;
      if(await s.resumeAfterInactivity())this.store.event(`${id}：用户1分钟无操作，已自动恢复只读监测`);
      if(this.stopping)return;
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
        if(s.mode!=='AUTOMATION')break;await this.scanResource(s, resource);
        this.publishBlockedResources(s,resource);
      }
    });
  }
  private publishBlockedResources(session:ProviderSession,scanned:Resource){
    const attention=session.attention;if(session.mode!=='MANUAL_CONTROL'||!attention)return;
    for(const resource of resources.filter(row=>row.provider===session.id&&row.id!==scanned.id))this.store.saveScan(resource,{
      status:'PARTIAL',observations:[],coverage:targetDates(this.store.policy()).map(date=>({date,status:'UNKNOWN',note:attention.message})),
      summary:`${attention.message.startsWith('暂无信息')?'':'暂无信息：'}${attention.message} 同一网站的此场地尚未查询，等待人工接管。`
    });
  }
  async scanResource(session: ProviderSession, resource: Resource, retriedLogin=false):Promise<void> {
    const policy = this.store.policy(); let result: ScanResult|undefined;
    for(let attempt=0;attempt<2;attempt++)try {
      const page = await session.page(resource);
      const challenge=await session.challengePage();session.assertAutomatic();
      if(challenge){const message='暂无信息：官网出现人机验证，请手动接管完成验证；验证期间停止自动刷新。';await session.requireManual('HUMAN_VERIFICATION',message,challenge);this.store.incidents.report(session.id,'HUMAN_VERIFICATION',message);result={status:'PARTIAL',observations:[],coverage:targetDates(policy).map(date=>({date,status:'UNKNOWN',note:'官网需要人机验证'})),summary:message};break;}
      const moduleUrl = new URL(`./adapters/${resource.provider}.ts`, import.meta.url);
      const adapter = await import(`${moduleUrl.href}?v=${statSync(moduleUrl).mtimeMs}`);
      if (resource.provider === 'playfootball') result = await adapter.scanPlayFootball(page, resource, policy, session);
      else if (resource.provider === 'ggcb') result = await adapter.scanGgcb(page, resource, policy, session);
      else result = await adapter.scanCouncil(page, policy, session,this.store.councilDefaults()??undefined);
      if(!result)throw new Error('官网读取未返回结果');
      if(result.status==='ERROR')this.store.incidents.report(session.id,'SCAN_ERROR','官网读取返回异常，请检查运行记录和页面结构。');
      if(/超时|timeout/i.test(result.summary)&&!result.coverage.some(row=>row.status==='READ')){const timeout=new Error('官网请求超时');timeout.name='TimeoutError';throw timeout;}
      if(result.status==='LOGIN_REQUIRED' && session.hasCredentials && session.automaticLoginAllowed && !retriedLogin) {
        const login=await session.signInStored('AUTOMATION');
        if(login.kind==='AUTHENTICATED' || login.kind==='CURRENT_SESSION') {
          return this.scanResource(session,resource,true);
        }
      }
      if(result.status==='LOGIN_REQUIRED')session.mode='MANUAL_CONTROL';
      if (resource.provider !== 'council' && session.status !== 'AUTHENTICATED') session.status = 'ANONYMOUS_READABLE';
      if(session.mode==='AUTOMATION'&&result.coverage.some(row=>row.status==='READ')){session.attention=undefined;this.store.incidents.resolve(session.id);}
      break;
    } catch (error) {
      if (error instanceof Interrupted) return;
      if(session.mode!=='AUTOMATION')return;
      const challenge=await session.challengePage().catch(()=>undefined);
      if(challenge){const message='暂无信息：官网出现人机验证，请手动接管完成验证；验证期间停止自动刷新。';await session.requireManual('HUMAN_VERIFICATION',message,challenge);this.store.incidents.report(session.id,'HUMAN_VERIFICATION',message);result={status:'PARTIAL',observations:[],coverage:targetDates(policy).map(date=>({date,status:'UNKNOWN',note:'官网需要人机验证'})),summary:message};break;}
      const timedOut=error instanceof Error&&/Timeout|timeout|超时/i.test(error.name+error.message);
      if(timedOut&&attempt===0){this.store.event(`${resource.name}：请求超时，关闭并重新打开官网后重试一次`);try{await session.reopenResource(resource);continue;}catch(reopenError){if(reopenError instanceof Interrupted)return;}}
      const detail = error instanceof Error ? error.message.split('\n')[0].replace(/https?:\/\/\S+/g, '[官网地址]').slice(0, 220) : '未知异常';
      console.error(`${resource.id}: ${detail}`);
      const kind = timedOut ? '页面重新打开后仍超时，请手动接管' : '浏览器或页面结构异常';
      session.nextScanAt=Date.now()+60000;
      if(timedOut)await session.requireManual('TIMEOUT',kind,session.pages.get(resource.id));
      this.store.incidents.report(session.id,timedOut?'TIMEOUT':'SCAN_ERROR',kind);
      result = { observations: [], coverage: targetDates(policy).map(date => ({ date, status: 'UNKNOWN', note: kind })), status: 'ERROR', summary: `暂无信息：${kind}；${timedOut?'已暂停该网站自动请求，页面恢复后空闲1分钟会自动检查。':'将在1分钟后自动重试。'}失败不代表没有空位。` };break;
    }
    if(!result)return;
    result.observations=result.observations.map(observation=>({...observation,bookingUrl:resource.url,priceNote:observation.priceNote || (observation.price?'官网时段报价，结算前需复核':'官网报价尚未读取')}));
    this.store.saveScan(resource, result); this.store.event(`${resource.name}：${result.summary}`);
  }
  async automaticLogin(id:ProviderId,input:unknown,retry=false) {
    const session=this.sessions.get(id)!;if(session.restarting)throw new Error('该网站浏览器正在重启，请稍后再试');const result=await (retry?session.retrySignIn():session.signIn(input));
    this.store.event(`${id}：${result.message}`);
    if(result.kind==='AUTHENTICATED' || result.kind==='CURRENT_SESSION') {
      session.mode='AUTOMATION';session.nextScanAt=0;void this.scan(id).catch(()=>{});
    }
    return result;
  }
  async openSlot(resourceId:unknown,date:unknown,start:unknown) {
    const resource=resources.find(resource=>resource.id===resourceId);
    if(!resource || typeof date!=='string' || start!=='18:00')throw new Error('场馆或场次不存在');
    const observation=this.store.latest(resource.id)?.result.observations.find(o=>o.date===date && o.start===start && o.availability==='AVAILABLE');
    if(!observation)throw new Error('该场次观察已更新，请刷新列表后重试');
    return {message:`请在你的浏览器打开${resource.name}官网，核对${date} ${start}场次、租期和报价；尚未选择或锁位。`,url:resource.url};
  }
  async prepareCouncil() {
    const defaults=this.store.councilDefaults();if(!defaults)throw new Error('Council默认选项尚未保存');
    const session=this.sessions.get('council')!;if(session.restarting)throw new Error('该网站浏览器正在重启，请稍后再试');session.mode='MANUAL_CONTROL';await session.job?.catch(()=>{});
    session.recordManualActivity();const result=await session.exclusive(async()=>{
      const page=await councilUserPage(session);if(!page)throw new Error('请先登录Council并打开场地表单');
      const url=new URL('./council-setup.ts',import.meta.url);const {prepareCouncil}=await import(`${url.href}?v=${statSync(url).mtimeMs}`) as typeof import('./council-setup.ts');
      const result=await prepareCouncil(page,defaults,session);await session.saveSession();this.store.event(`Council：${result.message}`);return result;
    });
    if(result.stage==='CALENDAR'&&session.mode==='MANUAL_CONTROL'&&!this.stopping){session.mode='AUTOMATION';session.nextScanAt=0;void this.scan('council').catch(()=>{});}
    return result;
  }
  async action(id: ProviderId, action: string, resourceId?: string) {
    const s = this.sessions.get(id)!;
    if(s.restarting&&action!=='pause')throw new Error('该网站浏览器正在重启，请稍后再试');
    if(action==='restart'){
      const resource=resources.find(resource=>resource.provider===id)!;
      this.store.event(`${id}：正在关闭并重启该网站浏览器`);
      try{await s.restartBrowser(resource);}catch(error){if(!(error instanceof Interrupted))this.store.incidents.report(id,'SCAN_ERROR','浏览器重启失败，请检查运行记录并手动接管。');throw error;}
      if(s.attention)this.store.incidents.report(id,s.attention.kind,s.attention.message);
      this.publishBlockedResources(s,resource);this.store.event(`${id}：浏览器已重启；${s.mode==='PAUSED'?'监测保持暂停':s.mode==='MANUAL_CONTROL'?'等待人工接管':'恢复只读监测'}`);
      if(s.mode==='AUTOMATION'&&!this.stopping)void this.scan(id).catch(()=>{});
      return {message:s.attention?`该网站浏览器已重启。${s.attention.message}`:s.mode==='PAUSED'?'该网站浏览器已重启，监测保持暂停。':s.mode==='MANUAL_CONTROL'?'该网站浏览器已重启，保持手动接管；无操作1分钟后自动检测。':'该网站浏览器已重启，已恢复只读监测。'};
    }
    if (action === 'login') { await s.manual(); this.store.event(`${id}：已交由用户手动登录，同网站扫描暂停`); }
    else if (action === 'open') {
      const resource = resources.find(r => r.id === resourceId && r.provider === id);
      if (!resource) throw new Error('场馆不存在');
      const current=id==='council'?await councilUserPage(s):undefined;
      await s.manual(current?undefined:resource.url); this.store.event(`${resource.name}：已打开官网并暂停自动操作`);
    } else if (action === 'pause') { s.mode = 'PAUSED'; await s.job?.catch(() => {}); this.store.event(`${id}：监测已暂停`); }
    else if (action === 'check') { s.recordManualActivity();await s.check(); this.store.event(`${id}：会话检测 ${s.status}`); }
    else if (action === 'resume') {
      await s.check();
      if(s.needsHumanVerification)throw new Error('官网仍需人机验证，请手动完成后等待自动检测');
      if (s.status === 'LOGIN_REQUIRED') throw new Error('页面仍显示登录表单，请先在官网完成登录');
      s.mode = 'AUTOMATION'; s.nextScanAt = 0; void this.scan(id).catch(() => {}); this.store.event(`${id}：恢复只读监测`);
    } else if (action === 'scan') { void this.scan(id).catch(() => {}); }
    else throw new Error('不支持的操作');
  }
  async close() { this.stopping = true; clearInterval(this.timer); for (const s of this.sessions.values()) s.mode = 'PAUSED'; await Promise.allSettled([...this.sessions.values()].map(async s => { await s.job?.catch(() => {}); await s.close(); })); }
}
