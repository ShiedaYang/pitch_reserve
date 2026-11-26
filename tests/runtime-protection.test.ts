import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {MemoryGuard,descendants,parsePressure} from '../src/runtime-memory.ts';
import {supervise} from '../src/supervisor.ts';
const fixtureEnv=(root:string)=>({...process.env,PITCH_DATA_DIR:join(root,'data'),NOTIFY_SOCKET:''});

test('memory protection acts before the soft limit, waits between reclamations, and escalates a stuck reclamation',()=>{
 const guard=new MemoryGuard();const sample={used:88,high:100,total:1000,available:500,full:0};
 assert.equal(guard.observe(sample,0),undefined);assert.equal(guard.observe(sample,30000),'reclaim');
 guard.reclaimed();assert.equal(guard.observe(sample,45000),undefined);
 assert.equal(guard.observe({...sample,used:40},60000),undefined);
 assert.equal(guard.observe(sample,90000),undefined);assert.equal(guard.observe(sample,120000),'reclaim');
 assert.equal(guard.stalled(151000),true);
 const critical=new MemoryGuard();critical.observe({...sample,full:94},0);critical.reclaimed();
 assert.equal(critical.observe({...sample,full:94},181000),'restart');
 assert.equal(parsePressure('some avg10=100.00 avg60=100\nfull avg10=94.03 avg60=94\n'),94.03);
});

test('process ownership uses ancestry rather than executable names and excludes unrelated browsers',()=>{
 const rows=[{pid:10,ppid:1,rss:1,start:'a'},{pid:11,ppid:10,rss:2,start:'b'},{pid:12,ppid:11,rss:3,start:'c'},{pid:13,ppid:1,rss:4,start:'d'}];
 assert.deepEqual(descendants(rows,10).map(p=>p.pid).sort(),[10,11,12]);
});

test('independent supervisor restarts a truly blocked HTTP process and reaps only its owned descendants',{timeout:30000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'pitch-watchdog-'));const entry=join(root,'fixture.mjs');
 await writeFile(entry,`import {createServer} from 'node:http';import {spawn} from 'node:child_process';import {appendFileSync,existsSync,writeFileSync} from 'node:fs';
const recovered=existsSync('started');writeFileSync('started','yes');
if(recovered&&JSON.parse(process.env.PITCH_RECOVERY_STATE||'[]')[0]?.mode!=='PAUSED')process.exit(2);
const owned=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});appendFileSync('children',owned.pid+'\\n');
const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,pid:process.pid,providers:[{id:'ggcb',mode:'PAUSED',nextScanAt:123}]}));});
server.listen(0,'127.0.0.1',()=>{process.send({type:'ready',host:'127.0.0.1',port:server.address().port,hostHeader:'localhost'});setTimeout(()=>{if(!recovered){while(true){}}else{owned.kill();process.exit(0);}},recovered?500:250);});`);
 const events:string[]=[];
 const outsider=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
 try{
  const code=await supervise({entry,cwd:root,env:fixtureEnv(root),intervalMs:40,healthTimeoutMs:40,unresponsiveMs:200,startupTimeoutMs:2000,restartDelayMs:20,stopTimeoutMs:100,sample:async()=>undefined,onEvent:e=>events.push(e.code)});
  assert.equal(code,0);assert.equal(events.filter(code=>code==='HTTP_UNRESPONSIVE').length,1);
  assert.equal(outsider.exitCode,null);assert.doesNotThrow(()=>process.kill(outsider.pid!,0));
  const pids=(await readFile(join(root,'children'),'utf8')).trim().split('\n').map(Number);
  for(const pid of pids){let alive=true;for(let i=0;i<30;i++){try{process.kill(pid,0);}catch{alive=false;break;}await new Promise(r=>setTimeout(r,20));}assert.equal(alive,false,'an owned child was left behind');}
 }finally{outsider.kill();await rm(root,{recursive:true,force:true});}
});

test('an intentional shutdown with a stuck cleanup stops without restarting',{timeout:15000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'pitch-watchdog-stop-'));const entry=join(root,'fixture.mjs');
 try{await writeFile(entry,`import {createServer} from 'node:http';const server=createServer((req,res)=>res.end(JSON.stringify({ok:true,pid:process.pid})));server.listen(0,'127.0.0.1',()=>{process.send({type:'ready',host:'127.0.0.1',port:server.address().port,hostHeader:'localhost'});setTimeout(()=>process.send({type:'stopping'}),300);});`);
  const events:string[]=[];assert.equal(await supervise({entry,cwd:root,env:fixtureEnv(root),intervalMs:30,stopTimeoutMs:100,onEvent:e=>events.push(e.code),sample:async()=>undefined}),0);assert.ok(!events.includes('RUNTIME_RESTART'));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('startup errors exit once instead of being hidden in an automatic restart loop',{timeout:5000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'pitch-watchdog-start-'));const entry=join(root,'fixture.mjs');
 try{await writeFile(entry,'process.exit(1)');const events:string[]=[];assert.equal(await supervise({entry,cwd:root,env:fixtureEnv(root),intervalMs:20,onEvent:e=>events.push(e.code),sample:async()=>undefined}),1);assert.ok(!events.includes('RUNTIME_RESTART'));}
 finally{await rm(root,{recursive:true,force:true});}
});

test('a process that crashes immediately after listening is recovered even before its first health response',{timeout:15000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'pitch-watchdog-ready-'));const entry=join(root,'fixture.mjs');
 try{await writeFile(entry,`import {createServer} from 'node:http';import {existsSync,writeFileSync} from 'node:fs';if(existsSync('started'))process.exit(0);writeFileSync('started','yes');const server=createServer();server.listen(0,'127.0.0.1',()=>process.send({type:'ready',host:'127.0.0.1',port:server.address().port,hostHeader:'localhost'},()=>process.exit(1)));`);
  const events:string[]=[];assert.equal(await supervise({entry,cwd:root,env:fixtureEnv(root),intervalMs:20,healthTimeoutMs:40,restartDelayMs:10,onEvent:e=>events.push(e.code),sample:async()=>undefined}),0);assert.equal(events.filter(code=>code==='RUNTIME_RESTART').length,1);
 }finally{await rm(root,{recursive:true,force:true});}
});
