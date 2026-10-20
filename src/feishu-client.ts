import { resources } from './domain.ts';
import type { NotificationPayload } from './notifications.ts';
import type { FeishuRecipient, FeishuSettings } from './feishu-settings.ts';

const base='https://open.feishu.cn/open-apis';
type Fetcher=(url:string,init:RequestInit)=>Promise<Response>;
export class FeishuError extends Error {
  uncertain:boolean; code:number; status:number;
  constructor(message:string,options:{uncertain?:boolean;code?:number;status?:number}={}){super(message);this.uncertain=options.uncertain??false;this.code=options.code??0;this.status=options.status??0;}
}
export function feishuFailureMessage(status:number,code:number){
  if(code===99992361)return `飞书收件人 Open ID 不属于当前应用（HTTP ${status}，错误码 ${code}）。请在当前应用下重新获取该用户的 Open ID，或使用与该 Open ID 配套的应用凭据。`;
  return `飞书请求未成功（HTTP ${status}，错误码 ${code}），请检查应用权限与收件人可见范围`;
}
export function buildPitchMessage(payload:NotificationPayload,test=false){
  const resource=resources.find(row=>row.id===payload.resourceId);const date=new Date(payload.date+'T12:00:00Z');
  if(!resource||!/^\d{4}-\d{2}-\d{2}$/.test(payload.date)||Number.isNaN(date.getTime())||date.toISOString().slice(0,10)!==payload.date||!/^\d{2}:\d{2}$/.test(payload.start))throw new FeishuError('飞书场次消息数据无效');
  const weekday=['星期日','星期一','星期二','星期三','星期四','星期五','星期六'][date.getUTCDay()];
  const [hour,minute]=payload.start.split(':').map(Number);const end=payload.duration===null?null:hour*60+minute+payload.duration;
  const time=end===null?payload.start+'（结束时间待核实）':payload.start+'–'+String(Math.floor(end/60)%24).padStart(2,'0')+':'+String(end%60).padStart(2,'0');
  const lines=[...(test?['测试消息，仅验证消息格式，不代表实时空位。']:[]),
    `日期：${payload.date}（${weekday}）`,`时间：${time}（伦敦当地时间）`,
    `场地：${resource.name}（${resource.format.replace(/ · 产品\d+/,'')}）`,`价格：${payload.price||'待核实'}（以官网结算为准）`];
  return {text:[...lines,`点击链接查看：${resource.url}`].join('\n'),
    post:{zh_cn:{title:test?'订场通知 · 测试消息':'发现可订场地',content:[...lines.map(text=>[{tag:'text',text}]),[{tag:'a',text:'点击链接查看',href:resource.url}]]}}};
}
export class FeishuClient {
  #token='';#refreshAt=0;#refreshJob?:Promise<string>;
  private settings:Pick<FeishuSettings,'appId'|'appSecret'>;private request:Fetcher;private clock:()=>number;
  constructor(settings:Pick<FeishuSettings,'appId'|'appSecret'>,options:{fetch?:Fetcher;clock?:()=>number}={}){this.settings=settings;this.request=options.fetch??fetch;this.clock=options.clock??Date.now;}
  private async call(path:string,body:unknown,token='',messageRequest=false){
    let response:Response;
    try{response=await this.request(base+path,{method:'POST',headers:{'Content-Type':'application/json; charset=utf-8',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(12000)});}
    catch{throw new FeishuError('飞书网络请求未确认，请检查网络连接',{uncertain:messageRequest});}
    let data:Record<string,unknown>;try{data=await response.json() as Record<string,unknown>;}catch{throw new FeishuError('飞书返回无效响应',{status:response.status,uncertain:messageRequest&&response.status!==401&&response.status!==403&&response.status!==429});}
    if(!data||typeof data!=='object'||!response.ok||data.code!==0){const code=typeof data?.code==='number'?data.code:0;
      throw new FeishuError(feishuFailureMessage(response.status,code),{status:response.status,code,uncertain:messageRequest&&(response.status>=500||response.ok&&data?.code===undefined)});}
    return data;
  }
  private async token(){
    if(this.#token&&this.clock()<this.#refreshAt)return this.#token;
    if(!this.#refreshJob)this.#refreshJob=(async()=>{const data=await this.call('/auth/v3/tenant_access_token/internal',{app_id:this.settings.appId,app_secret:this.settings.appSecret});
      if(typeof data.tenant_access_token!=='string'||!data.tenant_access_token||typeof data.expire!=='number'||data.expire<=0)throw new FeishuError('飞书鉴权响应缺少有效凭据');
      this.#token=data.tenant_access_token;this.#refreshAt=this.clock()+Math.max(0,data.expire-Math.min(60,data.expire/10))*1000;return this.#token;
    })().finally(()=>{this.#refreshJob=undefined;});return this.#refreshJob;
  }
  async validate(){await this.token();}
  async sendPost(recipient:FeishuRecipient,post:unknown,uuid:string,allowed:()=>boolean=()=>true){
    if(!/^[a-zA-Z0-9-]{16,50}$/.test(uuid))throw new FeishuError('飞书消息去重标识无效');
    const body={receive_id:recipient.receiveId,msg_type:'post',content:JSON.stringify(post),uuid};
    for(let attempt=0;attempt<2;attempt++){
      const token=await this.token();if(!allowed())throw new FeishuError('飞书发送已暂停或配置已变更');
      try{const response=await this.call('/im/v1/messages?receive_id_type='+recipient.type,body,token,true);
        const id=(response.data as {message_id?:unknown}|undefined)?.message_id;
        if(typeof id!=='string'||!id)throw new FeishuError('飞书已响应但缺少消息回执，需要核对送达',{uncertain:true});return id;
      }catch(error){if(error instanceof FeishuError&&attempt===0&&(error.status===401||[99991663,99991668].includes(error.code))){this.#token='';this.#refreshAt=0;continue;}throw error;}
    }
    throw new FeishuError('飞书鉴权失败');
  }
}
