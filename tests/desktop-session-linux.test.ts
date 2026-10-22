import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer,createConnection} from 'node:net';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
async function port(){const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const n=(server.address() as {port:number}).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return n;}
async function reachable(port:number){return new Promise<boolean>(resolve=>{const socket=createConnection({port,host:'127.0.0.1'});socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));});}
test('Linux desktop orchestration starts isolated components and shuts them down when the console exits',{skip:process.platform!=='linux',timeout:30000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'pitch-desktop-'));const bin=join(root,'bin');mkdirSync(bin);const desktop=join(root,'desktop');mkdirSync(desktop);writeFileSync(join(desktop,'vnc.pass'),'fixture',{mode:0o600});const web=join(root,'web');mkdirSync(web);writeFileSync(join(web,'vnc.html'),'fixture');
 const program=`#!/usr/bin/env node
const fs=require('fs'),net=require('net'),path=require('path');const name=path.basename(process.argv[1]),args=process.argv.slice(2);if(name==='xauth'){fs.writeFileSync(args[1],'fixture');process.exit(0);}let server;if(name==='Xvfb')fs.writeFileSync(process.env.PITCH_DATA_DIR+'/display-ready','ready');if(name==='x11vnc')server=net.createServer(s=>s.end()).listen(Number(args[args.indexOf('-rfbport')+1]),'127.0.0.1');if(name==='websockify')server=net.createServer(s=>s.end()).listen(Number(args[2].split(':')[1]),'127.0.0.1');const timer=setInterval(()=>{},1000);process.on('SIGTERM',()=>{fs.appendFileSync(process.env.PITCH_DATA_DIR+'/exited',name+'\\n');clearInterval(timer);if(server)server.close(()=>process.exit(0));else process.exit(0);});
`;
 for(const name of ['xauth','Xvfb','openbox','x11vnc','websockify'])writeFileSync(join(bin,name),program,{mode:0o700});
 const api=await port(),vnc=await port(),ws=await port();const env={...process.env,PATH:bin+':'+process.env.PATH,PITCH_DATA_DIR:root,PITCH_DESKTOP_DISPLAY:':'+(300+process.pid%500),PITCH_VNC_PORT:String(vnc),PITCH_DESKTOP_PORT:String(ws),PITCH_NOVNC_DIR:web,PITCH_START_PAUSED:'1',PITCH_HEADLESS:'1',PITCH_HOST:'127.0.0.1',PITCH_PUBLIC_ORIGIN:'',PORT:String(api)};
 // WSLg mounts /tmp/.X11-unix read-only. Fake only that readiness probe;
 // component supervision, console startup, TCP ports and shutdown remain real.
 const entry=join(root,'launch.mjs');writeFileSync(entry,`import {runDesktop} from ${JSON.stringify(new URL('../src/desktop-session.ts',import.meta.url).href)};import {existsSync} from 'node:fs';try{await runDesktop(${JSON.stringify(resolve(import.meta.dirname,'..'))},[],process.env,async()=>existsSync(${JSON.stringify(join(root,'display-ready'))}));}catch(error){console.error(error.message);process.exitCode=1;}`);
 const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning',entry],{cwd:resolve(import.meta.dirname,'..'),env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
 try{let state:any;for(let n=0;n<100;n++){try{state=await (await fetch(`http://127.0.0.1:${api}/api/state`,{signal:AbortSignal.timeout(300)})).json();break;}catch{}if(child.exitCode!==null)break;await new Promise(resolve=>setTimeout(resolve,100));}assert.ok(state,output+(existsSync(join(root,'logs','desktop-session.log'))?readFileSync(join(root,'logs','desktop-session.log'),'utf8'):''));assert.equal(state.desktop.headless,false);assert.equal(state.desktop.displayAvailable,true);assert.equal(state.desktop.configured,true);assert.match(state.desktop.url,/^\/desktop\//);
 await fetch(`http://127.0.0.1:${api}/api/shutdown`,{method:'POST',headers:{'Content-Type':'application/json','X-Console-Token':state.csrf},body:'{}'});await exited;assert.equal(child.exitCode,0,output);assert.equal(await reachable(vnc),false);assert.equal(await reachable(ws),false);const names=readFileSync(join(root,'exited'),'utf8');for(const name of ['Xvfb','openbox','x11vnc','websockify'])assert.ok(names.includes(name),name);
 }finally{if(child.exitCode===null){child.kill('SIGTERM');await exited;}rmSync(root,{recursive:true,force:true});}
});
