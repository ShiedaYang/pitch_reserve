import {request} from 'node:http';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Duplex} from 'node:stream';

export function desktopUpstream(env:NodeJS.ProcessEnv=process.env){
 if(!env.PITCH_DESKTOP_UPSTREAM)return null;let url:URL;try{url=new URL(env.PITCH_DESKTOP_UPSTREAM);}catch{throw new Error('远程桌面上游必须是本机 HTTP 地址');}
 if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('远程桌面上游必须是本机 HTTP 根地址，不能包含凭据、路径或查询参数');return url;
}
export class DesktopProxy {
 upstream:URL|null;onFault:()=>void;private lastFault=0;
 constructor(upstream:URL|null,onFault:()=>void=()=>{}){this.upstream=upstream;this.onFault=onFault;}
 private fault(){if(Date.now()-this.lastFault>30000){this.lastFault=Date.now();this.onFault();}}
 async check(){if(!this.upstream)return {configured:false,reachable:false};const upstream=this.upstream;return new Promise<{configured:boolean;reachable:boolean}>(resolve=>{const req=request(new URL('/vnc.html',upstream),{method:'HEAD',timeout:1500},res=>{res.resume();resolve({configured:true,reachable:res.statusCode===200});});req.once('error',()=>resolve({configured:true,reachable:false}));req.once('timeout',()=>req.destroy());req.end();});}
 http(req:IncomingMessage,res:ServerResponse,url:URL){
  if(!this.upstream){res.writeHead(503,{'Content-Type':'text/plain; charset=utf-8'});res.end('远程桌面尚未启动。请在 Ubuntu 使用 sh start-desktop.sh。');return;}
  if(!['GET','HEAD'].includes(req.method||'')){res.writeHead(405);res.end();return;}
  const target=new URL(this.upstream);target.pathname=url.pathname.slice('/desktop'.length);target.search=url.search;
  const upstream=request(target,{method:req.method,headers:{accept:req.headers.accept||'*/*'},timeout:5000},response=>{
    const headers:Record<string,string>={};for(const key of ['content-type','content-length']){const value=response.headers[key];if(typeof value==='string')headers[key]=value;}
    const host=req.headers.host!;headers['Content-Security-Policy']=`default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://${host} wss://${host}; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'self'`;
    res.writeHead(response.statusCode||502,headers);response.pipe(res);
  });
  upstream.once('timeout',()=>upstream.destroy());upstream.once('error',()=>{this.fault();if(!res.headersSent)res.writeHead(502,{'Content-Type':'text/plain; charset=utf-8'});res.end('远程桌面暂不可用，请检查桌面启动日志并使用 sh start-desktop.sh 重启。');});res.once('close',()=>upstream.destroy());upstream.end();
 }
 upgrade(req:IncomingMessage,socket:Duplex,head:Buffer){
  if(!this.upstream){socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');return;}
  const headers:Record<string,string>={Connection:'Upgrade',Upgrade:'websocket'};
  for(const name of ['sec-websocket-key','sec-websocket-version','sec-websocket-protocol','origin']){const value=req.headers[name];if(typeof value==='string')headers[name]=value;}
  const upstream=request(new URL('/websockify',this.upstream),{headers,timeout:5000});
  upstream.once('upgrade',(response,remote,upstreamHead)=>{
    upstream.setTimeout(0);let handshake='HTTP/1.1 101 Switching Protocols\r\n';for(const name of ['upgrade','connection','sec-websocket-accept','sec-websocket-protocol']){const value=response.headers[name];if(typeof value==='string')handshake+=`${name}: ${value}\r\n`;}
    socket.write(handshake+'\r\n');if(upstreamHead.length)socket.write(upstreamHead);if(head.length)remote.write(head);socket.pipe(remote).pipe(socket);
    socket.once('end',()=>remote.destroy());remote.once('end',()=>socket.destroy());socket.once('close',()=>remote.destroy());remote.once('close',()=>socket.destroy());socket.on('error',()=>remote.destroy());remote.on('error',()=>socket.destroy());
  });
  upstream.once('response',response=>{response.resume();socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');});
  upstream.once('timeout',()=>upstream.destroy());upstream.once('error',()=>{this.fault();socket.destroy();});socket.once('error',()=>upstream.destroy());upstream.end();
 }
}
