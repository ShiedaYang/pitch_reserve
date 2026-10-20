import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { londonDate, targetDates } from './domain.ts';
import type { Observation, Policy, Resource, ScanResult } from './domain.ts';

export type NotificationStatus = 'PENDING' | 'PROCESSING' | 'FAILED' | 'SENT' | 'CANCELLED' | 'EXPIRED' | 'REVIEW_REQUIRED';
export class UncertainDelivery extends Error { constructor(){super('飞书送达结果需人工核对，已停止盲目重发');} }
export interface NotificationPayload {
  resourceId:string; resourceName:string; date:string; start:string;
  duration:number|null; price:string|null; bookingUrl:string;
}
export interface Notification {
  id:string; occurrence:number; payload:NotificationPayload; status:NotificationStatus;
  firstSeenAt:string; lastSeenAt:string; attempts:number; nextAttemptAt:string;
  sentAt:string|null; lastError:string|null; receiptId:string|null;
}
interface NotificationRow {
  seq:number; id:string; slot_key:string; occurrence:number; payload:string; status:NotificationStatus;
  first_seen_at:string; last_seen_at:string; attempts:number; next_attempt_at:string;
  lease_token:string|null; lease_until:string|null; sent_at:string|null; last_error:string|null; receipt_id:string|null;
}
interface SlotRow { slot_key:string; slot_date:string; active:number; occurrence:number; last_observed_at:string; }
const statuses:NotificationStatus[]=['PENDING','PROCESSING','FAILED','SENT','CANCELLED','EXPIRED','REVIEW_REQUIRED'];
const decode=(row:NotificationRow):Notification=>({id:row.id,occurrence:row.occurrence,payload:JSON.parse(row.payload),status:row.status,
  firstSeenAt:row.first_seen_at,lastSeenAt:row.last_seen_at,attempts:row.attempts,nextAttemptAt:row.next_attempt_at,
  sentAt:row.sent_at,lastError:row.last_error,receiptId:row.receipt_id});

/** Durable outbox. Scan persistence and observe() share the Store transaction. */
export class NotificationQueue {
  private db:DatabaseSync;
  constructor(db:DatabaseSync){
    this.db=db;
    db.exec(`CREATE TABLE IF NOT EXISTS notification_slots (
      slot_key TEXT PRIMARY KEY,slot_date TEXT NOT NULL,active INTEGER NOT NULL,
      occurrence INTEGER NOT NULL,last_observed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notifications (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,slot_key TEXT NOT NULL,
      occurrence INTEGER NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,lease_token TEXT,lease_until TEXT,sent_at TEXT,last_error TEXT,receipt_id TEXT,
      UNIQUE(slot_key,occurrence));
      CREATE INDEX IF NOT EXISTS notifications_ready ON notifications(status,next_attempt_at);
      CREATE INDEX IF NOT EXISTS notifications_slot ON notifications(slot_key,occurrence);`);
  }
  observe(resource:Resource,result:ScanResult,policy:Policy,observedAt:string,now=new Date()){
    const wanted=new Set(targetDates(policy,londonDate(now),now));
    const grouped=new Map<string,Observation>();
    for(const item of result.observations){
      if(item.resourceId!==resource.id||item.start!=='18:00'||!wanted.has(item.date))continue;
      const key=JSON.stringify([resource.id,item.date,item.start]);const previous=grouped.get(key);
      if(!previous || previous.availability!=='AVAILABLE' && (item.availability==='AVAILABLE'||previous.availability==='UNKNOWN'))grouped.set(key,item);
    }
    for(const [key,item] of grouped){
      if(item.availability==='UNKNOWN')continue; // Failed/unknown scans must not manufacture reappearance events.
      const slot=this.db.prepare('SELECT * FROM notification_slots WHERE slot_key=?').get(key) as unknown as SlotRow|undefined;
      if(slot && slot.last_observed_at>=observedAt)continue;
      const available=item.availability==='AVAILABLE';
      const occurrence=slot?slot.occurrence+(available&&!slot.active?1:0):(available?1:0);
      this.db.prepare(`INSERT INTO notification_slots VALUES (?,?,?,?,?) ON CONFLICT(slot_key) DO UPDATE SET
        active=excluded.active,occurrence=excluded.occurrence,last_observed_at=excluded.last_observed_at`)
        .run(key,item.date,available?1:0,occurrence,observedAt);
      if(available){
        const payload:NotificationPayload={resourceId:resource.id,resourceName:resource.name,date:item.date,start:item.start,
          price:item.price,duration:item.duration,bookingUrl:resource.url};
        this.db.prepare(`INSERT OR IGNORE INTO notifications
          (id,slot_key,occurrence,payload,status,first_seen_at,last_seen_at,next_attempt_at) VALUES (?,?,?,?,'PENDING',?,?,?)`)
          .run(randomUUID(),key,occurrence,JSON.stringify(payload),observedAt,observedAt,now.toISOString());
        // A temporary policy exclusion is not a disappearance at the venue. Reuse the same
        // unsent event when a fresh in-range scan reconfirms it; never renotify a SENT event.
        this.db.prepare(`UPDATE notifications SET status='PENDING',last_error=NULL,next_attempt_at=?
          WHERE slot_key=? AND occurrence=? AND status='CANCELLED' AND last_error='已不在监测范围内'`)
          .run(now.toISOString(),key,occurrence);
        this.db.prepare(`UPDATE notifications SET last_seen_at=?,payload=CASE WHEN status IN ('PENDING','FAILED') AND attempts=0 THEN ? ELSE payload END
          WHERE slot_key=? AND occurrence=?`).run(observedAt,JSON.stringify(payload),key,occurrence);
      }else{
        this.db.prepare(`UPDATE notifications SET status='CANCELLED',last_error='该场次已不可订',lease_token=NULL,lease_until=NULL
          WHERE slot_key=? AND status IN ('PENDING','FAILED','PROCESSING')`).run(key);
      }
    }
    this.expire(policy,now);
  }
  expire(policy:Policy,now=new Date()){
    this.db.exec('SAVEPOINT notification_expiry');
    try{
    const wanted=new Set(targetDates(policy,londonDate(now),now));
    const today=londonDate(now);
    for(const slot of this.db.prepare('SELECT * FROM notification_slots WHERE active=1').all() as unknown as SlotRow[]){
      if(wanted.has(slot.slot_date))continue;
      const expired=slot.slot_date<=today;
      if(expired)this.db.prepare('UPDATE notification_slots SET active=0 WHERE slot_key=?').run(slot.slot_key);
      this.db.prepare(`UPDATE notifications SET status=?,last_error=?,lease_token=NULL,lease_until=NULL
        WHERE slot_key=? AND status IN ('PENDING','FAILED','PROCESSING')`)
        .run(expired?'EXPIRED':'CANCELLED',expired?'场次时间已过':'已不在监测范围内',slot.slot_key);
    }
    this.db.exec('RELEASE notification_expiry');
    }catch(error){this.db.exec('ROLLBACK TO notification_expiry; RELEASE notification_expiry');throw error;}
  }
  list(options:{limit?:number;before?:number;status?:NotificationStatus}={}){
    const limit=options.limit??50;
    if(!Number.isInteger(limit)||limit<1||limit>100||options.before!==undefined&&(!Number.isSafeInteger(options.before)||options.before<1)||options.status!==undefined&&!statuses.includes(options.status))throw new Error('通知查询参数无效');
    const rows=this.db.prepare(`SELECT * FROM notifications WHERE seq<? AND (? IS NULL OR status=?) ORDER BY seq DESC LIMIT ?`)
      .all(options.before??Number.MAX_SAFE_INTEGER,options.status??null,options.status??null,limit+1) as unknown as NotificationRow[];
    const page=rows.slice(0,limit);return {items:page.map(decode),nextCursor:rows.length>limit?page.at(-1)!.seq:null};
  }
  summary(){
    const counts:Record<NotificationStatus,number>={PENDING:0,PROCESSING:0,FAILED:0,SENT:0,CANCELLED:0,EXPIRED:0,REVIEW_REQUIRED:0};
    for(const row of this.db.prepare('SELECT status,COUNT(*) AS count FROM notifications GROUP BY status').all() as unknown as Array<{status:NotificationStatus;count:number}>)counts[row.status]=row.count;
    return counts;
  }
  claim(policy:Policy,now=new Date(),leaseMilliseconds=120000,notificationId?:string):{notification:Notification;leaseToken:string}|null{
    if(!Number.isFinite(leaseMilliseconds)||leaseMilliseconds<1000)throw new Error('通知租约无效');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.expire(policy,now);
      const at=now.toISOString();
      this.db.prepare(`UPDATE notifications SET status='FAILED',last_error='发送确认租约已过期，等待重试',lease_token=NULL,lease_until=NULL
        WHERE status='PROCESSING' AND lease_until<=?`).run(at);
      const freshAfter=new Date(now.getTime()-Math.max(policy.intervalMinutes*120000,1800000)).toISOString();
      const row=this.db.prepare(`SELECT n.* FROM notifications n JOIN notification_slots s ON s.slot_key=n.slot_key
        AND s.occurrence=n.occurrence WHERE s.active=1 AND n.status IN ('PENDING','FAILED')
        AND (? IS NULL OR n.id=?) AND (? IS NOT NULL OR n.next_attempt_at<=?) AND n.last_seen_at>=? ORDER BY n.seq LIMIT 1`)
        .get(notificationId??null,notificationId??null,notificationId??null,at,freshAfter) as unknown as NotificationRow|undefined;
      if(!row){this.db.exec('COMMIT');return null;}
      const leaseToken=randomUUID();
      this.db.prepare(`UPDATE notifications SET status='PROCESSING',attempts=attempts+1,lease_token=?,lease_until=? WHERE id=?`)
        .run(leaseToken,new Date(now.getTime()+leaseMilliseconds).toISOString(),row.id);
      this.db.exec('COMMIT');return {notification:{...decode(row),status:'PROCESSING',attempts:row.attempts+1},leaseToken};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  complete(id:string,leaseToken:string,receiptId:string|null,now=new Date()){
    return this.db.prepare(`UPDATE notifications SET status='SENT',sent_at=?,receipt_id=?,last_error=NULL,lease_token=NULL,lease_until=NULL
      WHERE id=? AND status='PROCESSING' AND lease_token=? AND lease_until>?`)
      .run(now.toISOString(),receiptId,id,leaseToken,now.toISOString()).changes===1;
  }
  fail(id:string,leaseToken:string,now=new Date()){
    // Deliberately avoid persisting arbitrary provider errors, which may contain credentials.
    const row=this.db.prepare(`SELECT attempts FROM notifications WHERE id=? AND status='PROCESSING' AND lease_token=?`).get(id,leaseToken) as {attempts:number}|undefined;
    if(!row)return false;
    const retryAt=new Date(now.getTime()+Math.min(3600000,30000*2**Math.min(row.attempts-1,7))).toISOString();
    return this.db.prepare(`UPDATE notifications SET status='FAILED',last_error='发送未确认，等待重试',next_attempt_at=?,lease_token=NULL,lease_until=NULL
      WHERE id=? AND status='PROCESSING' AND lease_token=?`).run(retryAt,id,leaseToken).changes===1;
  }
  requireReview(id:string,leaseToken:string){
    return this.db.prepare(`UPDATE notifications SET status='REVIEW_REQUIRED',last_error='飞书送达结果需人工核对，已停止自动重发',lease_token=NULL,lease_until=NULL
      WHERE id=? AND status='PROCESSING' AND lease_token=?`).run(id,leaseToken).changes===1;
  }
}

/** Delivery adapter contract; the server's optional Feishu integration implements it. */
export interface NotificationSender {
  send(notification:Notification,context:{idempotencyKey:string}):Promise<{receiptId?:string}>;
}
export async function dispatchNotifications(queue:NotificationQueue,policy:Policy,sender:NotificationSender,
  options:{limit?:number;now?:()=>Date;leaseMilliseconds?:number;notificationId?:string}={}){
  const limit=options.limit??10;const clock=options.now??(()=>new Date());
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('通知发送批量大小无效');
  const result={sent:0,failed:0};
  for(let i=0;i<(options.notificationId?1:limit);i++){
    const job=queue.claim(policy,clock(),options.leaseMilliseconds,options.notificationId);if(!job)break;
    try{
      const receipt=await sender.send(job.notification,{idempotencyKey:job.notification.id});
      if(queue.complete(job.notification.id,job.leaseToken,receipt.receiptId??null,clock()))result.sent++;
      else result.failed++; // Lost lease/withdrawn inventory is never marked as delivered.
    }catch(error){if(error instanceof UncertainDelivery)queue.requireReview(job.notification.id,job.leaseToken);else queue.fail(job.notification.id,job.leaseToken,clock());result.failed++;}
  }
  return result;
}
