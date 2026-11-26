import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {supervise} from '../src/supervisor.ts';

test('Linux systemd watchdog terminates a stalled service group while keeping its memory boundary',{skip:process.platform!=='linux',timeout:45000},async t=>{
 try{execFileSync('systemctl',['--user','show-environment'],{stdio:'ignore',timeout:3000});}catch{t.skip('A running user systemd manager is required');return;}
 const root=await mkdtemp(join(tmpdir(),'pitch-watchdog-unit-'));const unit=`pitch-watchdog-test-${process.pid}`;
 const main=join(root,'main.mjs'),app=join(root,'app.mjs');
 const control=(args:string[])=>execFileSync('systemctl',['--user',...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:5000});
 try{
  await writeFile(app,`import {createServer} from 'node:http';import {writeFileSync} from 'node:fs';import {spawn} from 'node:child_process';const owned=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync('pids',JSON.stringify([process.pid,owned.pid]));const providers=[{id:'playfootball',mode:'PAUSED',cooldownUntil:Date.now()+3600000}];const server=createServer((req,res)=>res.end(JSON.stringify({ok:true,pid:process.pid,providers})));server.listen(0,'127.0.0.1',()=>{process.send({type:'ready',host:'127.0.0.1',port:server.address().port,hostHeader:'localhost'});setTimeout(()=>{while(true){}},3000);});`);
  await writeFile(main,`import {supervise} from ${JSON.stringify(new URL('../src/supervisor.ts',import.meta.url).href)};process.exitCode=await supervise({entry:${JSON.stringify(app)},cwd:${JSON.stringify(root)},intervalMs:100,healthTimeoutMs:100,unresponsiveMs:30000,sample:async()=>undefined});`);
  execFileSync('systemd-run',['--user',`--unit=${unit}`,`--working-directory=${root}`,`--setenv=PITCH_DATA_DIR=${join(root,'data')}`,'--property=Type=exec','--property=MemoryHigh=192M','--property=MemoryMax=256M','--property=MemorySwapMax=0','--property=OOMPolicy=kill','--property=KillMode=mixed','--property=TimeoutStopSec=2s','--property=WatchdogSec=8s','--property=WatchdogSignal=SIGKILL','--property=NotifyAccess=all','--property=LimitCORE=0',process.execPath,'--disable-warning=ExperimentalWarning',main],{stdio:'ignore',timeout:5000});
  let pids:number[]=[];
  for(let n=0;n<100;n++){try{pids=JSON.parse(await readFile(join(root,'pids'),'utf8'));break;}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.equal(pids.length,2,'the fixture must start before testing watchdog expiry');
  const group=control(['show',unit,'-p','ControlGroup','--value']).trim();assert.ok(group);
  const folder='/sys/fs/cgroup'+group;
  assert.equal((await readFile(folder+'/memory.max','utf8')).trim(),String(256*1024**2));
  assert.equal((await readFile(folder+'/memory.swap.max','utf8')).trim(),'0');
  assert.equal((await readFile(folder+'/memory.oom.group','utf8')).trim(),'1');
  const first=Number(control(['show',unit,'-p','WatchdogTimestampMonotonic','--value']).trim());let heartbeat=first;
  for(let n=0;n<30;n++){await new Promise(r=>setTimeout(r,100));heartbeat=Number(control(['show',unit,'-p','WatchdogTimestampMonotonic','--value']).trim());if(heartbeat>first)break;}
  assert.ok(heartbeat>first,'healthy checks must actually refresh the systemd watchdog');
  let result='';for(let n=0;n<150;n++){result=control(['show',unit,'-p','Result','--value']).trim();if(result==='watchdog')break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(result,'watchdog');
  for(const pid of pids){let alive=true;for(let n=0;n<50;n++){let state='';try{state=await readFile(`/proc/${pid}/stat`,'utf8');}catch{}alive=!!state&&!state.slice(state.lastIndexOf(')')+2).startsWith('Z');if(!alive)break;await new Promise(r=>setTimeout(r,100));}assert.equal(alive,false,'the service must not leave a live owned child');}
  const probe=join(root,'restored.mjs');await writeFile(probe,`const state=JSON.parse(process.env.PITCH_RECOVERY_STATE||'[]')[0];process.exit(state?.mode==='PAUSED'&&state.cooldownUntil>Date.now()&&process.env.PITCH_RECOVERY_REASON==='UNCLEAN_EXIT'?0:1);`);
  assert.equal(await supervise({entry:probe,cwd:root,env:{...process.env,PITCH_DATA_DIR:join(root,'data'),NOTIFY_SOCKET:''},intervalMs:20,onEvent:()=>{},sample:async()=>undefined}),0,'a new supervisor must recover the checkpoint after the whole old unit was killed');
 }finally{try{control(['stop',unit]);}catch{}try{control(['reset-failed',unit]);}catch{}await rm(root,{recursive:true,force:true});}
});
