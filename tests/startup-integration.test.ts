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
  const rejectedHost=await new Promise<number|undefined>((resolve,reject)=>{const req=request(base+'/api/state',{headers:{Host:`evil.example:${port}`}},res=>{res.resume();resolve(res.statusCode);});req.once('error',reject);req.end();});assert.equal(rejectedHost,403);
  assert.equal((await fetch(base+'/api/providers/playfootball/verify-in-browser',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  const stop=spawn(process.execPath,['--disable-warning=ExperimentalWarning','scripts/stop-server.ts'],{cwd,env,stdio:'ignore',windowsHide:true});assert.equal(await new Promise(resolve=>stop.once('exit',resolve)),0);await exited;assert.equal(child.exitCode,0);
 }finally{if(child.exitCode===null){child.kill('SIGTERM');await exited;}await rm(root,{recursive:true,force:true});}
});
