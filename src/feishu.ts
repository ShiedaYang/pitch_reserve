import { createHash } from 'node:crypto';
import { londonDate, resources, targetDates } from './domain.ts';
import { FeishuClient, FeishuError, buildPitchMessage, feishuFailureMessage } from './feishu-client.ts';
import { parseFeishuSettings } from './feishu-settings.ts';
import type { FeishuSettings, FeishuSettingsRepository, FeishuRecipient } from './feishu-settings.ts';
import { dispatchNotifications, UncertainDelivery } from './notifications.ts';
import type { Notification, NotificationSender } from './notifications.ts';
import type { Store } from './store.ts';

interface DeliveryRow { notification_id:string;target_key:string;target_name:string;status:string;content:string;uuid:string;uncertain_since:string|null;receipt_id:string|null;sent_at:string|null;last_error:string|null; }
interface SettingsRepository { load():Promise<FeishuSettings|undefined>;save(settings:FeishuSettings):Promise<void>; }
const recipientKey=(settings:FeishuSettings,recipient:FeishuRecipient)=>createHash('sha256').update(JSON.stringify([settings.appId,recipient.type,recipient.receiveId])).digest('hex');
const crossAppFailure=(error:unknown)=>typeof error==='string'&&/错误码 99992361\b/.test(error);
export class FeishuIntegration {
  #settings?:FeishuSettings;#client?:FeishuClient;#generation=0;#job?:Promise<unknown>;#saving=false;#stopping=false;
  #timer?:NodeJS.Timeout;#error:string|null=null;#adminError:string|null=null;#validatedAt:string|null=null;#lastDispatchAt:string|null=null;
  private store:Store;private repository:SettingsRepository;private clientFactory:(settings:FeishuSettings)=>FeishuClient;private clock:()=>Date;
  constructor(store:Store,repository:FeishuSettingsRepository|SettingsRepository,options:{clientFactory?:(settings:FeishuSettings)=>FeishuClient;clock?:()=>Date}={}){
    this.store=store;this.repository=repository;this.clock=options.clock??(()=>new Date());this.clientFactory=options.clientFactory??(settings=>new FeishuClient(settings));
    store.db.exec(`CREATE TABLE IF NOT EXISTS feishu_deliveries (
      notification_id TEXT NOT NULL,target_key TEXT NOT NULL,target_name TEXT NOT NULL,status TEXT NOT NULL,
      content TEXT NOT NULL,uuid TEXT NOT NULL,uncertain_since TEXT,receipt_id TEXT,sent_at TEXT,last_error TEXT,
      PRIMARY KEY(notification_id,target_key));
      CREATE TABLE IF NOT EXISTS feishu_admin_notifications(id TEXT PRIMARY KEY,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT NOT NULL,last_error TEXT);
      CREATE TABLE IF NOT EXISTS feishu_resends(id TEXT PRIMARY KEY,notification_id TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,last_error TEXT);`);
  }
  async restore(){try{this.#settings=await this.repository.load();if(this.#settings)this.#client=this.clientFactory(this.#settings);}catch{this.#error='飞书配置无法恢复，请重新保存配置';}}
  private knownRecipientError(){
    for(const recipient of this.#settings?.recipients.filter(row=>row.enabled)??[]){
      const failures=this.store.db.prepare("SELECT last_error FROM feishu_deliveries WHERE target_key=? AND status<>'SENT'").all(recipientKey(this.#settings!,recipient)) as Array<{last_error:string|null}>;
      if(failures.some(row=>crossAppFailure(row.last_error)))return feishuFailureMessage(400,99992361);
    }return null;
  }
  private historicalWarning(){return this.knownRecipientError()?'历史发送记录曾返回 99992361（Open ID 与应用不匹配）；这是历史结果，本次未重新验证收件人能否接收消息。':null;}
  state(){const settings=this.#settings;return {appId:settings?.appId??'',hasSecret:!!settings?.appSecret,enabled:settings?.enabled??false,
    configured:!!settings?.appSecret&&!!settings.recipients.some(row=>row.enabled),recipients:settings?.recipients??[],adminEnabled:settings?.adminEnabled??false,adminRecipients:settings?.adminRecipients??[],adminError:this.#adminError,adminNotices:this.adminNotices(),
    busy:!!this.#job||this.#saving,error:this.#error,deliveryWarning:this.historicalWarning(),validatedAt:this.#validatedAt,lastDispatchAt:this.#lastDispatchAt,preview:this.preview()};}
  private preview(){const payload=this.store.notifications.list({limit:1}).items[0]?.payload??{resourceId:resources[0].id,resourceName:resources[0].name,date:targetDates(this.store.policy(),londonDate(this.clock()),this.clock())[0]??londonDate(this.clock()),start:'18:00',duration:55,price:null,bookingUrl:resources[0].url};return buildPitchMessage(payload,true).text;}
  async save(input:unknown){
    if(this.#saving)throw new Error('飞书配置正在保存，请稍后重试');const settings=parseFeishuSettings(input,this.#settings);
    this.#saving=true;this.#generation++;
    try{await this.repository.save(settings);this.#settings=settings;this.#client=this.clientFactory(settings);this.#validatedAt=null;this.#error=null;}
    finally{this.#saving=false;}
    this.store.event(settings.enabled?'飞书自动通知已启用':'飞书配置已保存，自动通知关闭');return this.state();
  }
  async validate(){
    if(!this.#client||this.#saving)throw new Error('飞书配置尚未保存或正在更新');const generation=this.#generation;
    try{await this.#client.validate();if(generation!==this.#generation)throw new FeishuError('飞书配置已变更，请重新验证');this.#validatedAt=this.clock().toISOString();this.#error=null;const warning=this.historicalWarning();return {credentialsValid:true,recipientDeliveryVerified:false,warning,message:'飞书应用凭据验证成功，未发送消息。'+(warning??'收件人能否接收须通过实际投递确认。')};}
    catch(error){this.#validatedAt=null;this.#error=error instanceof FeishuError?error.message:'飞书凭据验证失败，请检查配置';throw new Error(this.#error);}
  }
  decorate(items:Notification[]){
    const keys=new Set(this.#settings?.recipients.filter(row=>row.enabled).map(row=>recipientKey(this.#settings!,row))??[]);
    return items.map(item=>{const deliveries=this.store.db.prepare('SELECT target_key AS targetKey,target_name AS targetName,status,receipt_id AS receiptId,sent_at AS sentAt,last_error AS error FROM feishu_deliveries WHERE notification_id=?').all(item.id) as unknown as Array<{targetKey:string;targetName:string;status:string;receiptId:string|null;sentAt:string|null;error:string|null}>;
      const rejected=item.status!=='SENT'&&deliveries.some(row=>keys.has(row.targetKey)&&row.status!=='SENT'&&crossAppFailure(row.error));
      const resends=this.store.db.prepare('SELECT id,status,created_at AS createdAt,last_error AS error FROM feishu_resends WHERE notification_id=? ORDER BY created_at DESC LIMIT 10').all(item.id).map(row=>({...row,deliveries:this.store.db.prepare('SELECT target_key AS targetKey,target_name AS targetName,status FROM feishu_deliveries WHERE notification_id=?').all(String(row.id))}));
      return {...item,lastError:rejected?'历史发送失败：'+feishuFailureMessage(400,99992361):item.lastError,deliveries,resends};});
  }
  private async sendOne(notification:Pick<Notification,'id'> & {payload?:Notification['payload']},recipient:FeishuRecipient,settings:FeishuSettings,client:FeishuClient,allowed:()=>boolean,post?:unknown){
    if(!allowed())throw new FeishuError('飞书发送已暂停或配置已变更');
    const targetKey=recipientKey(settings,recipient);
    const uuid=createHash('sha256').update(notification.id+':'+targetKey).digest('hex').slice(0,32);
    this.store.db.prepare(`INSERT OR IGNORE INTO feishu_deliveries (notification_id,target_key,target_name,status,content,uuid) VALUES (?,?,?,'PENDING',?,?)`)
      .run(notification.id,targetKey,recipient.name,JSON.stringify(post??buildPitchMessage(notification.payload!).post),uuid);
    const row=this.store.db.prepare('SELECT * FROM feishu_deliveries WHERE notification_id=? AND target_key=?').get(notification.id,targetKey) as unknown as DeliveryRow;
    if(row.status==='SENT')return row.receipt_id!;
    // Feishu's UUID dedupe window is one hour. Leave a safety margin and never retry an
    // ambiguous/crashed delivery outside that window without a human reconciling it.
    if(row.uncertain_since && this.clock().getTime()-Date.parse(row.uncertain_since)>=55*60000)throw new UncertainDelivery();
    const since=row.uncertain_since??this.clock().toISOString();
    this.store.db.prepare("UPDATE feishu_deliveries SET status='UNCERTAIN',uncertain_since=? WHERE notification_id=? AND target_key=?").run(since,notification.id,targetKey);
    try{const receiptId=await client.sendPost(recipient,JSON.parse(row.content),row.uuid,allowed);
      this.store.db.prepare("UPDATE feishu_deliveries SET status='SENT',receipt_id=?,sent_at=?,last_error=NULL WHERE notification_id=? AND target_key=?")
        .run(receiptId,this.clock().toISOString(),notification.id,targetKey);return receiptId;
    }catch(error){
      const definite=error instanceof FeishuError&&!error.uncertain&&!row.uncertain_since;
      this.store.db.prepare('UPDATE feishu_deliveries SET status=?,uncertain_since=?,last_error=? WHERE notification_id=? AND target_key=?')
        .run(definite?'PENDING':'UNCERTAIN',definite?null:since,error instanceof FeishuError?error.message:'飞书发送未确认',notification.id,targetKey);throw error;
    }
  }
  async tick(){
    if(this.#stopping||this.#job||this.#saving||!this.#settings||!this.#client)return;
    if(this.#settings.adminEnabled){const job=this.dispatchAdmins().finally(()=>{if(this.#job===job)this.#job=undefined;});this.#job=job;await job;}
    if(!this.#stopping&&!this.#job&&!this.#saving&&this.#settings.enabled)await this.dispatch();
  }
  async sendManual(input:unknown){
    const id=(input as {notificationId?:unknown}|null)?.notificationId;
    if(typeof id!=='string'||!id||id.length>100)throw new Error('飞书通知记录参数无效');
    if(this.#stopping||this.#job||this.#saving)throw new Error('飞书正在处理，请稍后再手动发送');
    if(!this.#settings||!this.#client||!this.#settings.recipients.some(row=>row.enabled))throw new Error('飞书请先保存应用配置并勾选收件人');
    if((input as {resend?:unknown}).resend===true)return this.resend(id,(input as {requestId?:unknown}).requestId);
    const result=await this.dispatch(id);
    if(!result)throw new Error('飞书通知任务暂不可用，队列记录仍保留');
    if(!result.sent&&!result.failed)throw new Error('飞书该记录已处理、不可订或需要重新监测确认，请刷新通知列表');
    this.store.event(result.sent?'已手动发送飞书场次通知':'飞书手动发送尚未全部确认，请查看通知记录');
    return {message:result.sent?'已向勾选的收件人发送；已确认送达的收件人已跳过。':'发送尚未全部确认，请查看该记录的状态及送达详情。',sent:result.sent,failed:result.failed};
  }
  private async dispatch(notificationId?:string){
    const settings=this.#settings,client=this.#client,generation=this.#generation;
    if(!settings||!client)return;
    const allowed=()=>!this.#stopping&&!this.#saving&&generation===this.#generation&&(!!notificationId||!!this.#settings?.enabled);
    const sender:NotificationSender={send:async(notification)=>{
      try{const receipts:string[]=[];for(const recipient of settings.recipients.filter(row=>row.enabled))receipts.push(await this.sendOne(notification,recipient,settings,client,allowed));
        if(!receipts.length)throw new FeishuError('飞书没有启用的收件人');this.#error=null;return {receiptId:JSON.stringify(receipts)};
      }catch(error){this.#error=error instanceof FeishuError||error instanceof UncertainDelivery?error.message:'飞书发送未确认';throw error;}
    }};
    const job=dispatchNotifications(this.store.notifications,this.store.policy(),sender,{limit:3,now:this.clock,leaseMilliseconds:600000,notificationId})
      .then(result=>{this.#lastDispatchAt=this.clock().toISOString();if(result.failed)this.store.incidents.report('feishu','DELIVERY_ERROR','飞书场次消息发送失败，请检查应用权限、收件人及送达记录。',this.clock());else if(result.sent)this.store.incidents.resolve('feishu',this.clock());if(result.sent||result.failed)this.store.event(result.failed?'飞书场次通知未全部送达':'飞书场次通知发送完成',{level:result.failed?'ERROR':'INFO',provider:'feishu',stage:'DELIVERY',code:result.failed?'DELIVERY_FAILED':'DELIVERED',details:{sent:result.sent,failed:result.failed,...(result.failed?{reason:this.#error||'消息未确认送达',remedy:'在通知列表查看送达详情，核对应用权限与收件人；送达不确定时先人工核实，避免重复发送'}:{})}});return result;})
      .catch(()=>{this.#error='飞书通知任务暂不可用，队列记录仍保留';this.store.event(this.#error,{level:'ERROR',provider:'feishu',stage:'DELIVERY',code:'DELIVERY_TASK_FAILED',details:{remedy:'检查通知列表及管理员通知配置；恢复后队列继续处理'}});}).finally(()=>{this.#job=undefined;});
    this.#job=job;return await job;
  }
  async reconcile(input:unknown){
    if(this.#job)throw new Error('飞书正在发送，请稍后核对');
    const data=input as {notificationId?:unknown;targetKey?:unknown;decision?:unknown};
    if(!data||typeof data.notificationId!=='string'||typeof data.targetKey!=='string'||!['delivered','retry'].includes(String(data.decision)))throw new Error('飞书送达核对参数无效');
    if(this.store.db.prepare('SELECT id FROM feishu_resends WHERE id=?').get(data.notificationId))return this.reconcileResend(data as {notificationId:string;targetKey:string;decision:string});
    const db=this.store.db;db.exec('BEGIN IMMEDIATE');
    try{const row=db.prepare(`SELECT d.* FROM feishu_deliveries d JOIN notifications n ON n.id=d.notification_id
        WHERE d.notification_id=? AND d.target_key=? AND d.status='UNCERTAIN' AND n.status='REVIEW_REQUIRED'`).get(data.notificationId,data.targetKey) as unknown as DeliveryRow|undefined;
      if(!row)throw new Error('飞书没有需要人工核对的记录');
      if(data.decision==='delivered')db.prepare("UPDATE feishu_deliveries SET status='SENT',receipt_id='manual-confirmed',sent_at=?,last_error=NULL WHERE notification_id=? AND target_key=?").run(this.clock().toISOString(),data.notificationId,data.targetKey);
      else db.prepare("UPDATE feishu_deliveries SET status='PENDING',uncertain_since=NULL,last_error=NULL WHERE notification_id=? AND target_key=?").run(data.notificationId,data.targetKey);
      const pending=db.prepare("SELECT COUNT(*) AS count FROM feishu_deliveries WHERE notification_id=? AND status='UNCERTAIN'").get(data.notificationId) as {count:number};
      const keys=(this.#settings?.recipients??[]).filter(row=>row.enabled).map(row=>createHash('sha256').update(JSON.stringify([this.#settings!.appId,row.type,row.receiveId])).digest('hex'));
      const deliveries=db.prepare('SELECT * FROM feishu_deliveries WHERE notification_id=?').all(data.notificationId) as unknown as DeliveryRow[];
      const allSent=keys.length>0&&keys.every(key=>deliveries.some(row=>row.target_key===key&&row.status==='SENT'));
      const active=db.prepare('SELECT s.active FROM notification_slots s JOIN notifications n ON n.slot_key=s.slot_key WHERE n.id=?').get(data.notificationId) as {active:number};
      const status=pending.count?'REVIEW_REQUIRED':allSent?'SENT':active.active?'FAILED':'CANCELLED';
      db.prepare('UPDATE notifications SET status=?,next_attempt_at=?,last_error=?,sent_at=?,receipt_id=? WHERE id=?')
        .run(status,this.clock().toISOString(),status==='SENT'?null:status==='REVIEW_REQUIRED'?'其他收件人仍需核对':status==='CANCELLED'?'场次已不可订或已过期，不再重发':'已人工核对，等待继续处理',status==='SENT'?this.clock().toISOString():null,status==='SENT'?JSON.stringify(deliveries.filter(row=>row.status==='SENT').map(row=>row.receipt_id)):null,data.notificationId);db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    this.#error=null;this.store.event('已人工核对飞书通知送达结果');return {message:'已保存人工核对结果；启用自动通知后继续处理。'};
  }
  private adminNotices(){return this.store.db.prepare(`SELECT i.id,i.provider,i.message,i.opened_at AS openedAt,i.resolved_at AS resolvedAt,n.status,n.last_error AS error FROM monitor_incidents i LEFT JOIN feishu_admin_notifications n ON n.id=i.id ORDER BY i.opened_at DESC LIMIT 20`).all();}
  private async dispatchAdmins(){
    const settings=this.#settings!,client=this.#client!,generation=this.#generation;
    const allowed=()=>!this.#stopping&&!this.#saving&&generation===this.#generation&&!!this.#settings?.adminEnabled;
    for(const incident of this.store.incidents.list(true))this.store.db.prepare("INSERT OR IGNORE INTO feishu_admin_notifications(id,status,next_attempt_at) VALUES(?,'PENDING',?)").run(incident.id,this.clock().toISOString());
    const jobs=this.store.db.prepare(`SELECT n.id,n.attempts,i.provider,i.kind,i.message,i.opened_at FROM feishu_admin_notifications n JOIN monitor_incidents i ON i.id=n.id WHERE i.resolved_at IS NULL AND n.status IN ('PENDING','FAILED') AND n.next_attempt_at<=? ORDER BY i.opened_at LIMIT 3`).all(this.clock().toISOString()) as Array<{id:string;attempts:number;provider:string;kind:string;message:string;opened_at:string}>;
    for(const row of jobs){if(!allowed())return;
      const names:Record<string,string>={ggcb:'GGCB',council:'Tower Hamlets',playfootball:'PlayFootball',feishu:'飞书发送'};
      const lines=[`网站 / 模块：${names[row.provider]??row.provider}`,`发现时间：${new Date(row.opened_at).toLocaleString('zh-CN',{timeZone:'Europe/London',hour12:false})}（伦敦时间）`,`问题：${row.message}`,'请管理员打开控制台检查运行记录；如遇人机验证，请人工完成验证。'];
      const post={zh_cn:{title:'场地监测需要管理员处理',content:lines.map(text=>[{tag:'text',text}])}};
      try{for(const recipient of settings.adminRecipients?.filter(recipient=>recipient.enabled)??[])await this.sendOne({id:row.id},recipient,settings,client,allowed,post);
        if(!allowed())return;this.store.db.prepare("UPDATE feishu_admin_notifications SET status='SENT',last_error=NULL WHERE id=?").run(row.id);this.#adminError=null;
      }catch(error){const message=error instanceof FeishuError||error instanceof UncertainDelivery?error.message:'管理员通知发送未确认';this.#adminError=message;
        this.store.db.prepare('UPDATE feishu_admin_notifications SET status=?,attempts=attempts+1,next_attempt_at=?,last_error=? WHERE id=?').run(error instanceof UncertainDelivery?'REVIEW_REQUIRED':'FAILED',new Date(this.clock().getTime()+Math.min(3600000,60000*2**Math.min(row.attempts,6))).toISOString(),message,row.id);
      }
    }
  }
  private async resend(notificationId:string,requestId:unknown){
    if(typeof requestId!=='string'||!/^[0-9a-f-]{36}$/i.test(requestId))throw new Error('飞书重发请求标识无效，请刷新后重试');
    const db=this.store.db,settings=this.#settings!,client=this.#client!,generation=this.#generation;
    const source=db.prepare("SELECT payload FROM notifications WHERE id=? AND status='SENT'").get(notificationId) as {payload:string}|undefined;
    if(!source)throw new Error('飞书仅支持重发已发送的通知记录');
    const requestKey='resend-'+requestId;
    const repeated=db.prepare('SELECT notification_id,status FROM feishu_resends WHERE id=?').get(requestKey) as {notification_id:string;status:string}|undefined;
    if(repeated&&repeated.notification_id!==notificationId)throw new Error('飞书重发请求与原记录不匹配');
    if(repeated?.status==='SENT')return {message:'这次重发已确认完成，没有重复发送。',sent:1,failed:0};
    const pending=db.prepare("SELECT id,status FROM feishu_resends WHERE notification_id=? AND status<>'SENT' ORDER BY created_at LIMIT 1").get(notificationId) as {id:string;status:string}|undefined;
    if(pending?.status==='REVIEW_REQUIRED')throw new Error('飞书上次重发送达不确定，请先核对送达详情');
    const id=pending?.id??requestKey;
    if(!pending)db.prepare("INSERT INTO feishu_resends VALUES(?,?,'PENDING',?,NULL)").run(id,notificationId,this.clock().toISOString());
    const post=buildPitchMessage(JSON.parse(source.payload)).post;post.zh_cn.title='手动重发 · 场地历史观察';post.zh_cn.content.unshift([{tag:'text',text:'这是已发送记录的手动重发，库存和价格为当时观察，请点击官网重新核实。'}]);
    const allowed=()=>!this.#stopping&&!this.#saving&&generation===this.#generation;
    const job=(async()=>{try{for(const recipient of settings.recipients.filter(row=>row.enabled))await this.sendOne({id},recipient,settings,client,allowed,post);
        db.prepare("UPDATE feishu_resends SET status='SENT',last_error=NULL WHERE id=?").run(id);this.store.event('已手动重新发送飞书通知，原始送达记录保留');return {message:'已重新发送，原回执和本次重发记录均已保留。',sent:1,failed:0};
      }catch(error){const message=error instanceof FeishuError||error instanceof UncertainDelivery?error.message:'飞书重发未确认';db.prepare('UPDATE feishu_resends SET status=?,last_error=? WHERE id=?').run(error instanceof UncertainDelivery?'REVIEW_REQUIRED':'FAILED',message,id);this.store.incidents.report('feishu','DELIVERY_ERROR','飞书重发消息未全部确认，请检查送达详情。',this.clock());return {message,sent:0,failed:1};}
    })().finally(()=>{this.#job=undefined;});this.#job=job;return job;
  }
  private reconcileResend(data:{notificationId:string;targetKey:string;decision:string}){
    const db=this.store.db;db.exec('BEGIN IMMEDIATE');try{const row=db.prepare("SELECT status FROM feishu_deliveries WHERE notification_id=? AND target_key=? AND status='UNCERTAIN'").get(data.notificationId,data.targetKey);
    if(!row)throw new Error('飞书没有需要人工核对的重发记录');
    if(data.decision==='delivered')db.prepare("UPDATE feishu_deliveries SET status='SENT',receipt_id='manual-confirmed',sent_at=?,last_error=NULL WHERE notification_id=? AND target_key=?").run(this.clock().toISOString(),data.notificationId,data.targetKey);
    else db.prepare("UPDATE feishu_deliveries SET status='PENDING',uncertain_since=NULL,last_error=NULL WHERE notification_id=? AND target_key=?").run(data.notificationId,data.targetKey);
    const rows=db.prepare('SELECT target_key,status FROM feishu_deliveries WHERE notification_id=?').all(data.notificationId) as Array<{target_key:string;status:string}>;
    const allSent=this.#settings!.recipients.filter(recipient=>recipient.enabled).every(recipient=>rows.some(row=>row.target_key===recipientKey(this.#settings!,recipient)&&row.status==='SENT'));
    const uncertain=rows.some(row=>row.status==='UNCERTAIN');db.prepare('UPDATE feishu_resends SET status=?,last_error=NULL WHERE id=?').run(uncertain?'REVIEW_REQUIRED':allSent?'SENT':'FAILED',data.notificationId);
    db.exec('COMMIT');return {message:'已核对重发送达结果；未送达时可再次点击重新发送。'};
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  start(){this.#timer=setInterval(()=>{void this.tick().catch(()=>{this.#error='飞书通知任务暂不可用，请查看运行记录';});},5000);void this.tick().catch(()=>{this.#error='飞书通知任务暂不可用，请查看运行记录';});}
  async close(){this.#stopping=true;this.#generation++;clearInterval(this.#timer);await this.#job;}
}
