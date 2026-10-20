import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname,join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {SecretStorage} from './secret-storage.ts';

export type ReceiveIdType='open_id'|'user_id'|'union_id'|'email'|'chat_id';
export interface FeishuRecipient { name:string; type:ReceiveIdType; receiveId:string; enabled:boolean; }
export interface FeishuSettings { appId:string; appSecret:string; enabled:boolean; recipients:FeishuRecipient[]; adminEnabled?:boolean;adminRecipients?:FeishuRecipient[]; }
const types:ReceiveIdType[]=['open_id','user_id','union_id','email','chat_id'];
export function parseFeishuSettings(input:unknown,current?:FeishuSettings):FeishuSettings {
  if(!input||typeof input!=='object')throw new Error('飞书配置格式无效');
  const data=input as Record<string,unknown>;
  const appId=typeof data.appId==='string'?data.appId.trim():'';
  const supplied=typeof data.appSecret==='string'?data.appSecret:'';
  const appSecret=supplied || (appId===current?.appId?current.appSecret:'');
  if(!/^cli_[a-zA-Z0-9_]{3,100}$/.test(appId)||!appSecret||appSecret.length>512||/\s/.test(appSecret))throw new Error('飞书 App ID 或 App Secret 无效；更换 App ID 时需重新填写密钥');
  if(typeof data.enabled!=='boolean'||!Array.isArray(data.recipients)||data.recipients.length>10)throw new Error('飞书收件人配置无效（最多10个）');
  const seen=new Set<string>();
  const recipients=data.recipients.map((value,index)=>{
    if(!value||typeof value!=='object')throw new Error('飞书收件人格式无效');
    const row=value as Record<string,unknown>;const type=row.type as ReceiveIdType;
    const receiveId=typeof row.receiveId==='string'?(type==='email'?row.receiveId.trim().toLowerCase():row.receiveId.trim()):'';
    const name=typeof row.name==='string'?row.name.trim():'';
    if(!types.includes(type)||!receiveId||receiveId.length>256||/[\s<>\x00-\x1f\x7f]/.test(receiveId)||name.length>80||typeof row.enabled!=='boolean'
      ||type==='open_id'&&!/^ou_[A-Za-z0-9_-]+$/.test(receiveId)||type==='chat_id'&&!/^oc_[A-Za-z0-9_-]+$/.test(receiveId)
      ||type==='email'&&!/^[^@]+@[^@]+\.[^@]+$/.test(receiveId))throw new Error('飞书收件人ID或类型无效，请核对用户ID、邮箱或群聊 Chat ID');
    const key=JSON.stringify([type,receiveId]);if(seen.has(key))throw new Error('飞书收件人重复，请合并相同的接收者');seen.add(key);
    return {name:name||((type==='chat_id'?'群组':'用户')+' '+(index+1)),type,receiveId,enabled:row.enabled};
  });
  if(data.enabled&&!recipients.some(row=>row.enabled))throw new Error('飞书自动通知至少需要一个启用的收件人');
  const adminEnabled=data.adminEnabled??current?.adminEnabled??false;
  if(typeof adminEnabled!=='boolean')throw new Error('飞书管理员通知开关无效');
  // Reuse the same strict user/group validation, keeping administrator targets separate.
  const adminRecipients=data.adminRecipients===undefined?(current?.adminRecipients??[]):parseFeishuSettings({appId,appSecret,enabled:false,recipients:data.adminRecipients}).recipients;
  if(adminEnabled&&!adminRecipients.some(row=>row.enabled))throw new Error('飞书管理员通知至少需要一个启用的管理员');
  return {appId,appSecret,enabled:data.enabled,recipients,...(data.adminEnabled!==undefined||current?.adminEnabled!==undefined?{adminEnabled}:{}),...(data.adminRecipients!==undefined||current?.adminRecipients!==undefined?{adminRecipients}:{})};
}
export class FeishuSettingsRepository {
  readonly path:string;
  constructor(root:string){this.path=join(root,'integrations','feishu.json');}
  async load():Promise<FeishuSettings|undefined>{
    let raw:string;try{raw=await readFile(this.path,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw new Error('飞书配置无法读取');}
    let plain:Buffer|undefined;
    try{plain=await new SecretStorage(dirname(dirname(this.path))).unprotect(JSON.parse(raw),'feishu');return parseFeishuSettings(JSON.parse(plain.toString('utf8')));
    }catch{throw new Error('飞书配置无法解密，请重新保存配置');}finally{plain?.fill(0);}
  }
  async save(settings:FeishuSettings){
    const safe=parseFeishuSettings(settings);const plain=Buffer.from(JSON.stringify(safe));let encrypted;
    try{encrypted=await new SecretStorage(dirname(dirname(this.path))).protect(plain,'feishu');}finally{plain.fill(0);}
    const folder=dirname(this.path);await mkdir(folder,{recursive:true,mode:0o700});const temporary=join(folder,randomUUID()+'.tmp');
    try{await writeFile(temporary,JSON.stringify(encrypted),{mode:0o600});await rename(temporary,this.path);}
    finally{await rm(temporary,{force:true});}
  }
}
