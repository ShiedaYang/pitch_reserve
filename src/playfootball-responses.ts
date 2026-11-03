import type {BrowserContext,Page} from 'playwright';
export const playFootballQuietMinutes=30;

export class WebsiteResponseError extends Error {
  kind:'HUMAN_VERIFICATION'|'RATE_LIMITED';page:Page;httpStatus:number;retryAt?:number;responseType:string;
  constructor(kind:'HUMAN_VERIFICATION'|'RATE_LIMITED',page:Page,httpStatus:number,retryAt?:number,responseType='document'){
    super(kind==='HUMAN_VERIFICATION'?'官网请求需要人机验证':'官网返回 HTTP 429 限流');
    this.name='WebsiteResponseError';this.kind=kind;this.page=page;this.httpStatus=httpStatus;this.retryAt=retryAt;this.responseType=responseType;
  }
}

// Observe only first-party responses. Do not read challenge bodies, cookies or tokens.
export class PlayFootballResponses {
  issue?:WebsiteResponseError;
  private generation=0;
  private rateLimits=0;
  watch(context:BrowserContext){
    const generation=++this.generation;
    context.on('response',response=>{
      if(generation!==this.generation)return;
      try{
        const host=new URL(response.url()).hostname;
        if(host!=='playfootball.net'&&!host.endsWith('.playfootball.net'))return;
        const request=response.request(),page=request.frame().page(),headers=response.headers(),status=response.status();
        if(headers['cf-mitigated']==='challenge'){
          if(this.issue?.kind!=='HUMAN_VERIFICATION')this.issue=new WebsiteResponseError('HUMAN_VERIFICATION',page,status,undefined,request.resourceType());
          else if(this.issue.page.isClosed())this.issue.page=page;
        }
        else if(status===429&&this.issue?.kind!=='HUMAN_VERIFICATION'){
          const now=Date.now();
          if(this.issue?.kind!=='RATE_LIMITED'||now>=this.issue.retryAt!)this.rateLimits++;
          const quiet=now+playFootballQuietMinutes*2**Math.min(this.rateLimits-1,2)*60000;
          const raw=headers['retry-after']??'';
          const requested=/^\d+$/.test(raw)?now+Number(raw)*1000:Date.parse(raw);
          const retryAt=Math.max(quiet,this.issue?.retryAt??0,Number.isFinite(requested)&&requested<8.64e15?requested:0);
          if(this.issue?.kind==='RATE_LIMITED')this.issue.retryAt=retryAt;
          else this.issue=new WebsiteResponseError('RATE_LIMITED',page,status,retryAt,request.resourceType());
        }else if(status>=200&&status<300&&request.isNavigationRequest()&&request.frame()===page.mainFrame()
          &&this.issue?.kind==='HUMAN_VERIFICATION'&&(this.issue.page===page||this.issue.page.isClosed())){
          this.issue=undefined;
        }
      }catch{/* Closed frames and unrelated service-worker responses are not monitoring failures. */}
    });
  }
  check(){
    if(this.issue?.kind==='RATE_LIMITED'&&Date.now()>=this.issue.retryAt!)this.issue=undefined;
    if(this.issue)throw this.issue;
  }
  recovered(){if(!this.issue)this.rateLimits=0;}
}
