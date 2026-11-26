import {fork,execFile} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {request} from 'node:http';
import {mkdirSync,appendFileSync,existsSync,statSync,renameSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {MemoryGuard,processSnapshot,descendants,memorySample,currentMemoryGroup,killOwnedProcesses} from './runtime-memory.ts';
import type {OwnedProcess,MemorySample} from './runtime-memory.ts';

interface Endpoint {host:string;port:number;hostHeader:string;}
export interface RuntimeEvent {at:string;code:string;usedMiB?:number;highMiB?:number;pressureFull?:number;}
interface Options {
 entry:string;cwd:string;env?:NodeJS.ProcessEnv;intervalMs?:number;healthTimeoutMs?:number;unresponsiveMs?:number;
 startupTimeoutMs?:number;restartDelayMs?:number;stopTimeoutMs?:number;sampleEveryMs?:number;
 sample?:()=>Promise<MemorySample|undefined>;onEvent?:(event:RuntimeEvent)=>void;
}
function health(endpoint:Endpoint,pid:number,timeout:number):Promise<unknown[]>{
 return new Promise((resolve,reject)=>{
  const req=request({host:endpoint.host,port:endpoint.port,path:'/api/health',headers:{Host:endpoint.hostHeader},agent:false},res=>{
   res.once('error',reject);res.once('aborted',()=>reject(new Error('Health response aborted')));
   let body='';res.setEncoding('utf8');res.on('data',chunk=>{body+=chunk;if(body.length>4096)req.destroy(new Error('Invalid health response'));});
   res.once('end',()=>{try{const data=JSON.parse(body);if(res.statusCode!==200||data.ok!==true||data.pid!==pid)throw new Error();resolve(Array.isArray(data.providers)?data.providers:[]);}catch{reject(new Error('Health check failed'));}});
  });
  const timer=setTimeout(()=>req.destroy(new Error('Health check timed out')),timeout);
  req.once('close',()=>clearTimeout(timer));req.once('error',reject);req.end();
 });
}
function notifyWatchdog(env:NodeJS.ProcessEnv){
 if(process.platform==='linux'&&env.NOTIFY_SOCKET)execFile('systemd-notify',['WATCHDOG=1'],{env,timeout:2000},()=>{});
}
export async function supervise(options:Options):Promise<number>{
 const env=options.env??process.env,interval=options.intervalMs??10000,stopTimeout=options.stopTimeoutMs??15000;
 const group=currentMemoryGroup();let stopping=false;let child:ChildProcess|undefined;let checkpoint:unknown[]=[];let reason='';let wake=new AbortController();
 const data=resolve(env.PITCH_DATA_DIR||join(options.cwd,'.local')),checkpointPath=join(data,'runtime-checkpoint.json'),instance=randomUUID();let saved='',cleanExit=false;
 try{if(statSync(checkpointPath).size<=16384){const previous=JSON.parse(readFileSync(checkpointPath,'utf8'));if(Array.isArray(previous.providers)){checkpoint=previous.providers;reason='UNCLEAN_EXIT';}}}catch{/* Missing or invalid checkpoints use ordinary startup. */}
 const saveCheckpoint=()=>{
  const providers=JSON.stringify(checkpoint);if(providers===saved)return;
  const temporary=checkpointPath+'.'+instance+'.tmp';
  try{mkdirSync(data,{recursive:true,mode:0o700});writeFileSync(temporary,JSON.stringify({instance,providers:checkpoint}),{mode:0o600});renameSync(temporary,checkpointPath);saved=providers;}catch{log('CHECKPOINT_SAVE_FAILED');}finally{try{rmSync(temporary,{force:true});}catch{}}
 };
 const log=(code:string,sample?:MemorySample)=>{
  const event:RuntimeEvent={at:new Date().toISOString(),code,...(sample?{usedMiB:Math.round(sample.used/1024**2),highMiB:Math.round(sample.high/1024**2),pressureFull:sample.full}:{})};
  if(options.onEvent){options.onEvent(event);return;}
  console.error(`Runtime protection: ${code}`);
  try{const folder=join(resolve(env.PITCH_DATA_DIR||join(options.cwd,'.local')),'logs');mkdirSync(folder,{recursive:true,mode:0o700});const path=join(folder,'supervisor.log');if(existsSync(path)&&statSync(path).size>2*1024**2)renameSync(path,path+'.1');appendFileSync(path,JSON.stringify(event)+'\n',{mode:0o600});}catch{/* stderr remains available. */}
 };
 const stop=()=>{stopping=true;wake.abort();};process.once('SIGTERM',stop);process.once('SIGINT',stop);
 const restarts:number[]=[];
 try{while(!stopping){
  wake=new AbortController();const guard=new MemoryGuard();let endpoint:Endpoint|undefined,ended=false,exitCode:number|null=null,ready=false,fatal=false,owned:OwnedProcess[]=[];let rootStart:string|undefined,sampleFailed=false;
  const started=performance.now();let lastHealthy=started,lastSample=-Infinity;
  child=fork(options.entry,[],{cwd:options.cwd,env:{...env,PITCH_RECOVERY_STATE:JSON.stringify(checkpoint),PITCH_RECOVERY_REASON:reason},execArgv:['--disable-warning=ExperimentalWarning'],stdio:['ignore','inherit','inherit','ipc'],windowsHide:true});
  const runtime=child;
  runtime.once('error',()=>{ended=true;exitCode=1;wake.abort();});runtime.once('exit',code=>{ended=true;exitCode=code;wake.abort();});
  runtime.on('message',(message:any)=>{
   if(message?.type==='ready'&&typeof message.host==='string'&&Number.isInteger(message.port)&&message.port>0&&message.port<=65535&&typeof message.hostHeader==='string'){endpoint=message;wake.abort();}
   if(message?.type==='reclaimed')guard.reclaimed();
   if(message?.type==='reclaim-failed')fatal=true;
   if(message?.type==='stopping'&&!recovery){requestedStop=true;wake.abort();}
  });
  let recovery='';let requestedStop=false;
  while(!stopping&&!ended&&!requestedStop){
   if(wake.signal.aborted)wake=new AbortController();
   if(endpoint)try{checkpoint=await health(endpoint,runtime.pid!,options.healthTimeoutMs??5000);ready=true;lastHealthy=performance.now();saveCheckpoint();notifyWatchdog(env);}catch{}
   if(stopping||ended||requestedStop)break;
   const now=performance.now();
   if(fatal||guard.stalled(now)){recovery='BROWSER_RECYCLE_STALLED';break;}
   if(!ready&&now-started>=(options.startupTimeoutMs??90000)){recovery='STARTUP_UNRESPONSIVE';break;}
   if(ready&&now-lastHealthy>=(options.unresponsiveMs??90000)){recovery='HTTP_UNRESPONSIVE';break;}
   if(ready&&now-lastSample>=(options.sampleEveryMs??30000)){
    lastSample=now;
    let sample:MemorySample|undefined;
    try{
     const rows=await processSnapshot(),root=rows.find(row=>row.pid===runtime.pid&&row.ppid===process.pid);
     const snapshot=root&&(!rootStart||root.start===rootStart)?descendants(rows,runtime.pid!):[];
     if(root&&!ended)rootStart??=root.start;
     owned=[...new Map([...owned,...snapshot].map(row=>[row.pid,row])).values()].filter(row=>rows.some(current=>current.pid===row.pid&&current.start===row.start));
     sample=options.sample?await options.sample():memorySample(owned,group);
     sampleFailed=false;
    }catch{if(!sampleFailed)log('MEMORY_SAMPLE_FAILED');sampleFailed=true;sample=memorySample(owned,group);}
    if(sample){const action=guard.observe(sample,now);if(action==='restart'){recovery='MEMORY_PRESSURE_PERSISTED';log(recovery,sample);break;}if(action==='reclaim'&&runtime.connected){log('MEMORY_RECLAIM_REQUEST',sample);try{runtime.send({type:'reclaim',sample},()=>{});}catch{}}}
   }
   await delay(interval,undefined,{signal:wake.signal}).catch(()=>{});
  }
  // Capture descendants before asking the root to exit; a dead root cannot own new PIDs.
  try{const rows=await processSnapshot();const root=rows.find(row=>row.pid===runtime.pid&&row.ppid===process.pid);const fresh=!ended&&root&&(!rootStart||root.start===rootStart)?descendants(rows,runtime.pid!):[];owned=[...new Map([...owned,...fresh].map(row=>[row.pid,row])).values()];}catch{}
  if(recovery)log(recovery);
  if(!ended&&runtime.connected)try{runtime.send({type:'shutdown'},()=>{});}catch{}
  const deadline=performance.now()+stopTimeout;
  while(!ended&&performance.now()<deadline)await delay(Math.min(50,stopTimeout));
  if(!ended&&process.platform==='win32')await new Promise<void>(resolve=>execFile('taskkill.exe',['/PID',String(runtime.pid),'/T','/F'],{windowsHide:true,timeout:10000},()=>resolve()));
  const cleaned=await killOwnedProcesses(runtime.pid!,owned).catch(()=>false);
  if(!ended){runtime.kill('SIGKILL');await Promise.race([new Promise<void>(resolve=>runtime.once('exit',()=>resolve())),delay(5000)]);}
  if(runtime.connected)runtime.disconnect();runtime.removeAllListeners();child=undefined;
  if(cleaned===false){log('OWNED_CLEANUP_FAILED');return 1;}
  if(stopping||requestedStop){cleanExit=true;return 0;}
  if(!recovery&&exitCode===0){cleanExit=true;return 0;}
  if(!ready&&!endpoint&&!recovery)return exitCode||1;
  const now=performance.now();while(restarts.length&&now-restarts[0]>300000)restarts.shift();
  if(restarts.length>=3){log('RESTART_LIMIT_REACHED');return 1;}
  restarts.push(now);reason=recovery||'PROCESS_EXIT';log('RUNTIME_RESTART');wake=new AbortController();await delay(options.restartDelayMs??30000,undefined,{signal:wake.signal}).catch(()=>{});
 }
 cleanExit=true;return 0;
 }finally{process.off('SIGTERM',stop);process.off('SIGINT',stop);if(child?.connected)child.disconnect();if(cleanExit)try{if(JSON.parse(readFileSync(checkpointPath,'utf8')).instance===instance)rmSync(checkpointPath);}catch{}}
}
