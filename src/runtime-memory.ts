import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readdirSync,readFileSync} from 'node:fs';
import {totalmem,freemem} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';

const execute=promisify(execFile);
export interface OwnedProcess {pid:number;ppid:number;rss:number;start:string;}
export interface MemorySample {used:number;high:number;total:number;available:number;full:number;}
export function descendants(rows:OwnedProcess[],root:number){
 const ids=new Set([root]);let changed=true;
 while(changed){changed=false;for(const row of rows)if(ids.has(row.ppid)&&!ids.has(row.pid)){ids.add(row.pid);changed=true;}}
 return rows.filter(row=>ids.has(row.pid));
}
export async function processSnapshot():Promise<OwnedProcess[]>{
 if(process.platform==='win32'){
  // One bounded snapshot per memory check; no command lines or account data.
  const command="@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,CreationDate | Where-Object {$_.CreationDate} | ForEach-Object {@{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;rss=[double]$_.WorkingSetSize;start=$_.CreationDate.ToUniversalTime().Ticks.ToString()}}) | ConvertTo-Json -Compress";
  const {stdout}=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:5000,maxBuffer:4*1024*1024});
  const rows=JSON.parse(stdout);return Array.isArray(rows)?rows:rows?[rows]:[];
 }
 const rows:OwnedProcess[]=[];
 for(const name of readdirSync('/proc'))if(/^\d+$/.test(name))try{
  const stat=readFileSync(`/proc/${name}/stat`,'utf8');const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
  rows.push({pid:Number(name),ppid:Number(fields[1]),start:fields[19],rss:0});
  const rss=/^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${name}/status`,'utf8'));rows.at(-1)!.rss=Number(rss?.[1]??0)*1024;
 }catch{/* Processes may exit between the two reads. */}
 return rows;
}
export function parsePressure(text:string){return Number(/^full\s+avg10=([\d.]+)/m.exec(text)?.[1]??0);}
export function memorySample(owned:OwnedProcess[],group?:string):MemorySample{
 const total=totalmem();let available=freemem();
 if(process.platform==='linux')try{available=Number(/^MemAvailable:\s+(\d+)/m.exec(readFileSync('/proc/meminfo','utf8'))?.[1]??available/1024)*1024;}catch{}
 if(process.platform==='linux'&&group)try{
  const high=Number(readFileSync(group+'/memory.high','utf8'));const used=Number(readFileSync(group+'/memory.current','utf8'));
  if(Number.isFinite(high)&&high>0)return {used,high,total,available,full:parsePressure(readFileSync(group+'/memory.pressure','utf8'))};
 }catch{/* Unisolated launches still use the owned-process budget below. */}
 return {used:owned.reduce((sum,row)=>sum+row.rss,0),high:Math.min(total*.7,3*1024**3),total,available,full:0};
}
export function currentMemoryGroup(){
 if(process.platform!=='linux')return;
 try{const path=/^0::(.+)$/m.exec(readFileSync('/proc/self/cgroup','utf8'))?.[1];if(path)return '/sys/fs/cgroup'+path;}catch{}
}
export class MemoryGuard {
 private samples=0;private criticalSince?:number;private pendingAt?:number;private lastReclaim=-Infinity;
 stalled(now:number){return this.pendingAt!==undefined&&now-this.pendingAt>=30000;}
 reclaimed(){this.pendingAt=undefined;}
 observe(sample:MemorySample,now:number):'reclaim'|'restart'|undefined{
  const pressured=sample.used>=sample.high*.85||sample.full>=10||sample.available<sample.total*.1;
  const critical=sample.used>=sample.high||sample.full>=50;
  if(critical)this.criticalSince??=now;else this.criticalSince=undefined;
  if(this.stalled(now)||this.criticalSince!==undefined&&now-this.criticalSince>=180000)return 'restart';
  this.samples=pressured?this.samples+1:0;
  if(this.samples>=2&&this.pendingAt===undefined&&now-this.lastReclaim>=60000){this.lastReclaim=now;this.pendingAt=now;return 'reclaim';}
 }
}

// PID plus creation identity prevents a stale snapshot from selecting a reused PID.
export async function killOwnedProcesses(root:number,known:OwnedProcess[]){
 if(!known.length)return;
 const current=await processSnapshot();const identities=new Map(known.map(row=>[row.pid,row.start]));
 const owned=current.filter(row=>identities.get(row.pid)===row.start);
 if(!owned.length)return;
 if(process.platform==='win32'){
  if(owned.some(row=>row.pid===root))await execute('taskkill.exe',['/PID',String(root),'/T','/F'],{windowsHide:true,timeout:10000}).catch(()=>{});
  const remaining=await processSnapshot();
  for(const row of remaining)if(row.pid!==root&&identities.get(row.pid)===row.start)await execute('taskkill.exe',['/PID',String(row.pid),'/F'],{windowsHide:true,timeout:3000}).catch(()=>{});
 }else{
  for(const row of owned.toReversed())try{process.kill(row.pid,'SIGKILL');}catch{/* Already exited. */}
  for(let attempt=0;attempt<30;attempt++){
   const alive=owned.some(row=>{try{const stat=readFileSync(`/proc/${row.pid}/stat`,'utf8');const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');return fields[19]===row.start&&fields[0]!=='Z';}catch{return false;}});
   if(!alive)return true;await delay(100);
  }
  return false;
 }
 return !(await processSnapshot()).some(row=>identities.get(row.pid)===row.start);
}
