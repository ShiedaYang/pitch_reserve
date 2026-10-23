import type {DatabaseSync} from 'node:sqlite';
import {appendFileSync,mkdirSync,readdirSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {addDays,londonDate} from './domain.ts';

export const eventLevels=['INFO','WARN','ERROR'] as const;
export const eventProviders=['system','ggcb','council','playfootball','feishu'] as const;
export type EventLevel=typeof eventLevels[number];
export interface EventContext {level?:EventLevel;provider?:typeof eventProviders[number];resourceId?:string;stage?:string;code?:string;runId?:string;details?:Record<string,unknown>;}
export interface ActivityEvent {id:number;at:string;message:string;level:EventLevel;provider:string;resourceId:string|null;stage:string;code:string|null;runId:string|null;details:Record<string,string|number|boolean>;}
export interface EventQuery {limit?:number;before?:number;level?:string;provider?:string;}
export function safeLogText(value:unknown){return String(value??'')
 .replace(/Bearer\s+\S+/gi,'[凭据已隐藏]')
 .replace(/(?:password|passwd|app_?secret|authorization|cookie|(?:access_|refresh_)?token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,'[敏感字段已隐藏]')
 .replace(/Bearer\s+\S+/gi,'[凭据已隐藏]').replace(/https?:\/\/\S+/gi,'[链接已隐藏]')
 .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[邮箱已隐藏]')
 .replace(/\b(?:ou_|oc_|cli_|ghp_)[A-Za-z0-9_]+\b/g,'[账号标识已隐藏]')
 .replace(/[A-Z]:\\[^\s]+|\/(?:home|root|tmp|var|srv)\/[^\s]+/gi,'[本地路径已隐藏]')
 .replace(/<[^>]*>/g,'').replace(/[\u0000-\u0008\u000b-\u001f]/g,'').slice(0,1800);}
const detailKeys=new Set(['reason','remedy','action','dateFrom','dateTo','targetDays','readDays','unknownDays','observations','available','priced','attempt','durationMs','nextRetryAt','status','navigation','headless','displayAvailable','remoteDesktopConfigured','sent','failed','cancelled','errorType','location']);
function safeDetails(input:Record<string,unknown>={}){const out:Record<string,string|number|boolean>={};for(const [key,value] of Object.entries(input)){if(!detailKeys.has(key))continue;if(typeof value==='string')out[key]=safeLogText(value);else if(typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))out[key]=value;}return out;}
export function diagnoseError(error:unknown){
 const value=error instanceof Error?error.name+' '+error.message:String(error);
 const cases:[RegExp,string,string,string][]=[
  [/executable.*(?:doesn't|does not) exist|浏览器.*尚未安装|所需的浏览器|browser distribution.+not found/i,'BROWSER_NOT_INSTALLED','当前用户缺少所需版本的浏览器','以服务用户在项目目录执行 npx playwright install --with-deps chromium'],
  [/missing dependencies|loading shared libraries|缺少系统依赖/i,'BROWSER_DEPENDENCIES','缺少浏览器系统依赖','执行 npx playwright install-deps chromium 后重新启动'],
  [/SANDBOX_UNAVAILABLE|No usable sandbox|Chromium sandboxing failed|Failed to move to new namespace|Running as root without --no-sandbox/i,'SANDBOX_UNAVAILABLE','系统无法创建 Chromium 沙箱','以普通用户运行；Ubuntu 请检查用户命名空间和 AppArmor 限制，按部署文档为实际浏览器路径配置专用策略后重试'],
  [/DISPLAY_UNAVAILABLE|xserver|Missing X server|\$DISPLAY|missing.*display|图形桌面\/DISPLAY|X11 connection rejected/i,'DISPLAY_UNAVAILABLE','有界面浏览器无法连接图形桌面','使用 sh start-desktop.sh 启动远程桌面，确认浏览器与桌面使用同一个 DISPLAY 和 XAUTHORITY'],
  [/BROWSER_PERMISSION|\bEACCES\b|(?:Permission denied|Operation not permitted).*(?:chrome|chromium|profile|user-data-dir)/i,'BROWSER_PERMISSION','服务用户无法访问浏览器或专用数据目录','检查浏览器执行权限和 PITCH_DATA_DIR 的属主；不要用 sudo 启动服务，也不要删除已有会话'],
  [/PROFILE_IN_USE|SingletonLock|ProcessSingleton|user data directory.*in use|profile.*(?:in use|占用)/i,'PROFILE_IN_USE','专用浏览器目录正在被其他进程占用','先正常关闭旧实例或普通验证窗口，再重试；不要删除 profile'],
  [/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i,'NETWORK_DNS','官网域名解析失败','检查服务器 DNS 与网络连通性，等待下一次重试'],
  [/ERR_CONNECTION|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i,'NETWORK_CONNECTION','官网连接失败或被中断','检查服务器网络、代理和官网状态'],
  [/Timeout|timeout|超时/i,'TIMEOUT','官网请求或日历加载超时','程序会先重开一次；仍失败则手动接管检查页面'],
  [/Target.*closed|browser.*closed|context.*closed/i,'BROWSER_CLOSED','浏览器或标签页已关闭','使用重启浏览器恢复；检查是否关闭了工具窗口'],
  [/日期|表头|日历|数量不一致|结构|未返回结果/i,'PAGE_STRUCTURE','官网日历结构或数据未按预期返回','在远程浏览器确认页面状态，保留日志供修复解析器']
 ];
 const match=cases.find(([pattern])=>pattern.test(value));const issue=match?{code:match[1],reason:match[2],remedy:match[3]}:{code:'UNEXPECTED_ERROR',reason:'浏览器或官网读取发生未分类异常',remedy:'检查远程浏览器与相邻运行记录；持续发生时通知管理员'};
 const location=error instanceof Error?error.stack?.replaceAll('\\','/').match(/\b(?:src|scripts)\/[A-Za-z0-9_/-]+\.ts:\d+:\d+/)?.[0]:undefined;
 return {...issue,errorType:error instanceof Error&&/^[A-Za-z][A-Za-z0-9]{0,49}$/.test(error.name)?error.name:'UnknownError',...(location?{location}:{})};
}
export class ActivityLog {
 db:DatabaseSync;folder?:string;fileError:string|null=null;private prunedDay='';
 constructor(db:DatabaseSync,folder?:string){this.db=db;this.folder=folder;const columns=new Set((db.prepare('PRAGMA table_info(events)').all() as {name:string}[]).map(row=>row.name));
  for(const [name,type] of [['level',"TEXT NOT NULL DEFAULT 'INFO'"],['provider',"TEXT NOT NULL DEFAULT 'system'"],['resource', 'TEXT'],['stage',"TEXT NOT NULL DEFAULT 'LEGACY'"],['code','TEXT'],['run_id','TEXT'],['details',"TEXT NOT NULL DEFAULT '{}'" ]])if(!columns.has(name))db.exec(`ALTER TABLE events ADD COLUMN ${name} ${type}`);
  db.exec('CREATE INDEX IF NOT EXISTS events_filter ON events(level,provider,id)');
 }
 record(message:string,context:EventContext={},now=new Date()){
  const text=safeLogText(message);const details=safeDetails(context.details);const level=eventLevels.includes(context.level!)?context.level!:'INFO';const provider=eventProviders.includes(context.provider!)?context.provider!:'system';
  const tag=(value:string|undefined)=>value&&/^[a-zA-Z0-9_-]{1,100}$/.test(value)?value:null;
  const row=this.db.prepare('INSERT INTO events(at,message,level,provider,resource,stage,code,run_id,details) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id').get(now.toISOString(),text,level,provider,tag(context.resourceId),tag(context.stage)||'OPERATION',tag(context.code),tag(context.runId),JSON.stringify(details)) as {id:number};
  this.db.exec('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 5000)');
  const event={id:row.id,at:now.toISOString(),message:text,level,provider,resourceId:tag(context.resourceId),stage:tag(context.stage)||'OPERATION',code:tag(context.code),runId:tag(context.runId),details};
  if(this.folder)try{mkdirSync(this.folder,{recursive:true,mode:0o700});const day=londonDate(now);appendFileSync(join(this.folder,`runtime-${day}.jsonl`),JSON.stringify(event)+'\n',{mode:0o600});if(this.prunedDay!==day){for(const file of readdirSync(this.folder)){const match=/^runtime-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file);if(match&&match[1]<addDays(day,-13))unlinkSync(join(this.folder,file));}this.prunedDay=day;}this.fileError=null;}catch{this.fileError='日志文件写入失败，运行记录仍保存在数据库中。';}
  return event;
 }
 list(query:EventQuery={}){
  const limit=query.limit??50;if(!Number.isInteger(limit)||limit<1||limit>200||query.before!==undefined&&(!Number.isInteger(query.before)||query.before<1)||query.level&&!eventLevels.includes(query.level as EventLevel)||query.provider&&!eventProviders.includes(query.provider as typeof eventProviders[number]))throw new Error('运行记录查询参数无效');
  const where:string[]=[];const args:(string|number)[]=[];if(query.before!==undefined){where.push('id<?');args.push(query.before);}if(query.level){where.push('level=?');args.push(query.level);}if(query.provider){where.push('provider=?');args.push(query.provider);}
  const rows=this.db.prepare(`SELECT id,at,message,level,provider,resource AS resourceId,stage,code,run_id AS runId,details FROM events ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY id DESC LIMIT ?`).all(...args,limit+1) as unknown as (Omit<ActivityEvent,'details'>&{details:string})[];
  const items=rows.slice(0,limit).map(row=>({...row,message:safeLogText(row.message),details:safeDetails(JSON.parse(row.details))}));return {items,nextCursor:rows.length>limit?items.at(-1)!.id:null,retained:5000,fileError:this.fileError};
 }
}
