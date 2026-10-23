import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {request} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

test('shared LAN launcher advertises addresses, keeps API guards, and stops with a custom data directory',{timeout:45000},async()=>{
 const probe=createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=(probe.address() as {port:number}).port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
 const root=await mkdtemp(join(tmpdir(),'pitch-startup-'));const cwd=resolve(import.meta.dirname,'..');
 const env={...process.env,PORT:String(port),PITCH_DATA_DIR:root,PITCH_START_PAUSED:'1',PITCH_HOST:'127.0.0.1',PITCH_PUBLIC_ORIGIN:'',PITCH_LAN_CIDRS:''};
 const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','scripts/start-server.ts','--lan'],{cwd,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
 let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
 try{
  const base=`http://127.0.0.1:${port}`;let ready=false;
  for(let i=0;i<100;i++){try{if((await fetch(base+'/api/state',{signal:AbortSignal.timeout(300)})).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(ready,true,output);const metadata=JSON.parse(await readFile(join(root,'server.json'),'utf8'));assert.equal(metadata.host,'0.0.0.0');assert.equal(metadata.port,port);assert.ok(Array.isArray(metadata.lanUrls));assert.match(output,/Pitch console:/);assert.match(output,/Access: local machine/);
  assert.equal((await fetch(base+'/api/state',{headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await fetch(base+'/api/events?level=INVALID')).status,400);
  const logs=await (await fetch(base+'/api/events?provider=system')).json();assert.ok(logs.items.some((row:{code:string})=>row.code==='STARTUP_READY'));
  assert.equal((await fetch(base+'/desktop/vnc.html')).status,503);
  for(const origin of [undefined,'https://evil.example']){
   const status=await new Promise<number|undefined>((resolve,reject)=>{const req=request(base+'/desktop/websockify',{headers:{Connection:'Upgrade',Upgrade:'websocket',...(origin?{Origin:origin}:{})}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});assert.equal(status,403);
  }
  const rejectedHost=await new Promise<number|undefined>((resolve,reject)=>{const req=request(base+'/api/state',{headers:{Host:`evil.example:${port}`}},res=>{res.resume();resolve(res.statusCode);});req.once('error',reject);req.end();});assert.equal(rejectedHost,403);
  assert.equal((await fetch(base+'/api/providers/playfootball/verify-in-browser',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(base+'/api/activity',{method:'POST',headers:{'Content-Type':'application/json','X-Console-Token':'é'.repeat(64)},body:'{}'})).status,403);
  assert.equal((await fetch(base+'/api/state')).status,200,'malformed tokens must not crash the server');
  const malformedUpgrade=await new Promise<number|undefined>((resolve,reject)=>{const req=request({host:'127.0.0.1',port,path:'http://[',headers:{Connection:'Upgrade',Upgrade:'websocket',Origin:base}},res=>{res.resume();resolve(res.statusCode);});req.once('error',reject);req.end();});assert.equal(malformedUpgrade,403);
  assert.equal((await fetch(base+'/api/state')).status,200,'malformed WebSocket URLs must not crash the server');
  const stop=spawn(process.execPath,['--disable-warning=ExperimentalWarning','scripts/stop-server.ts'],{cwd,env,stdio:'ignore',windowsHide:true});assert.equal(await new Promise(resolve=>stop.once('exit',resolve)),0);await exited;assert.equal(child.exitCode,0);
 }finally{if(child.exitCode===null){child.kill('SIGTERM');await exited;}await rm(root,{recursive:true,force:true});}
});

test('a missing Playwright browser fails startup once with installation guidance instead of starting a retry loop',{timeout:20000},async()=>{
 const probe=createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=(probe.address() as {port:number}).port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
 const root=await mkdtemp(join(tmpdir(),'pitch-missing-browser-'));const cwd=resolve(import.meta.dirname,'..');
 const env={...process.env,PORT:String(port),PITCH_DATA_DIR:root,PITCH_START_PAUSED:'',PITCH_HOST:'127.0.0.1',PITCH_PUBLIC_ORIGIN:'',PITCH_LAN_CIDRS:'',PITCH_HEADLESS:'1',PITCH_BROWSER_CHANNEL:'chromium',PITCH_BROWSER_EXECUTABLE:'',PLAYWRIGHT_BROWSERS_PATH:join(root,'empty-browser-cache')};
 const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','scripts/start-server.ts'],{cwd,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
 let output='';let finish!:(result:'LISTENING'|'EXITED'|'TIMEOUT')=>void;const outcome=new Promise<'LISTENING'|'EXITED'|'TIMEOUT'>(resolve=>finish=resolve);
 const capture=(chunk:Buffer)=>{output+=chunk;if(output.includes('Pitch console:'))finish('LISTENING');};child.stdout.on('data',capture);child.stderr.on('data',capture);
 const exited=new Promise<void>(resolve=>child.once('exit',()=>{finish('EXITED');resolve();}));const timer=setTimeout(()=>finish('TIMEOUT'),10000);
 try{assert.equal(await outcome,'EXITED','missing browser must stop startup before scanners begin');assert.equal(child.exitCode,1);assert.match(output,/npx playwright install (?:--with-deps )?chromium/);assert.ok(!output.includes('ggcb-half:'));}
 finally{clearTimeout(timer);if(child.exitCode===null){child.kill('SIGTERM');await exited;}await rm(root,{recursive:true,force:true});}
});
