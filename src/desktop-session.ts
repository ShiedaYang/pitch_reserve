import {spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {existsSync,mkdirSync,statSync,chmodSync,appendFileSync,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createConnection} from 'node:net';
import {safeLogText} from './activity-log.ts';

export function desktopSettings(root:string,env:NodeJS.ProcessEnv=process.env){
 const number=(key:string,fallback:number,min:number,max:number)=>{const n=Number(env[key]||fallback);if(!Number.isInteger(n)||n<min||n>max)throw new Error(`${key} is invalid`);return n;};
 const display=env.PITCH_DESKTOP_DISPLAY||':99';if(!/^:\d{1,3}$/.test(display))throw new Error('PITCH_DESKTOP_DISPLAY must be :0 through :999');
 const data=resolve(env.PITCH_DATA_DIR||join(root,'.local'));
 const vncPort=number('PITCH_VNC_PORT',5901,1024,65535),webPort=number('PITCH_DESKTOP_PORT',6080,1024,65535);
 if(vncPort===webPort)throw new Error('Desktop ports must be different');
 return {display,data,vncPort,webPort,password:join(data,'desktop','vnc.pass'),authority:join(data,'desktop','Xauthority'),web:env.PITCH_NOVNC_DIR||'/usr/share/novnc'};
}
function listening(options:{port:number;host:string}|{path:string}){return new Promise<boolean>(resolve=>{const socket=createConnection(options);socket.setTimeout(500);socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.once('timeout',()=>{socket.destroy();resolve(false);});});}
async function waitFor(check:()=>Promise<boolean>,alive:()=>boolean){for(let n=0;n<60;n++){if(!alive())throw new Error('Desktop component stopped during startup; check desktop-session.log');if(await check())return;await new Promise(resolve=>setTimeout(resolve,250));}throw new Error('Desktop component startup timed out; check desktop-session.log');}

export async function runDesktop(root:string,args:string[],env:NodeJS.ProcessEnv=process.env,displayReady=(display:string)=>listening({path:`/tmp/.X11-unix/X${display.slice(1)}`})){
 if(process.platform!=='linux')throw new Error('start-desktop.sh is for Linux. On Windows use start.ps1 and the local browser.');
 const config=desktopSettings(root,env);const folder=join(config.data,'desktop');mkdirSync(folder,{recursive:true,mode:0o700});chmodSync(folder,0o700);
 if(!existsSync(config.password))throw new Error(`VNC password is missing. Run: mkdir -p "${folder}" && x11vnc -storepasswd "${config.password}"`);
 if(statSync(config.password).mode&0o077)throw new Error('VNC password permissions are too broad. Run chmod 600 on the vnc.pass file.');
 if(!existsSync(join(config.web,'vnc.html')))throw new Error('noVNC is missing. Install: sudo apt-get install xvfb x11vnc openbox novnc websockify xauth');
 if(await listening({port:config.vncPort,host:'127.0.0.1'})||await listening({port:config.webPort,host:'127.0.0.1'})||existsSync(`/tmp/.X${config.display.slice(1)}-lock`))throw new Error('Desktop display or port is already in use. Stop the existing desktop session first.');
 const logs=join(config.data,'logs');mkdirSync(logs,{recursive:true,mode:0o700});const log=join(logs,'desktop-session.log');
 if(existsSync(log)&&statSync(log).size>2*1024*1024)renameSync(log,log+'.1');
 const record=(name:string,message:string)=>{try{appendFileSync(log,`${new Date().toISOString()} ${name}: ${safeLogText(message)}\n`,{mode:0o600});}catch{/* Console still reports component failures. */}};
 const children:ChildProcess[]=[];let stopping=false;let app:ChildProcess|undefined;let failure:Error|undefined;
 const launch=(name:string,command:string,argv:string[],childEnv:NodeJS.ProcessEnv)=>{
  const child=spawn(command,argv,{cwd:root,env:childEnv,stdio:['ignore','pipe','pipe']});children.push(child);
  for(const stream of [child.stdout,child.stderr])stream?.on('data',data=>{record(name,String(data));if(child===app)process.stdout.write(data);});
  child.on('error',()=>{failure=new Error(`${name} could not start. Check installed packages and desktop-session.log.`);record(name,'Launch failed');});
  child.on('exit',(code,signal)=>{record(name,`Exited code=${code} signal=${signal}`);if(!stopping&&child!==app)failure=new Error(`${name} stopped unexpectedly. Check desktop-session.log.`);});
  return child;
 };
 const alive=(child:ChildProcess)=>!failure&&child.exitCode===null&&child.signalCode===null;
 let stopJob:Promise<void>|undefined;
 const stop=()=>stopJob??=(async()=>{
  stopping=true;
  if(app&&app.exitCode===null&&app.signalCode===null){await new Promise<void>(resolve=>{const timer=setTimeout(resolve,35000);app!.once('exit',()=>{clearTimeout(timer);resolve();});app!.kill('SIGTERM');});}
  for(const child of children.toReversed())if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
  await new Promise(resolve=>setTimeout(resolve,500));
  for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
 })();
 const signal=()=>{void stop();};process.once('SIGINT',signal);process.once('SIGTERM',signal);
 try{
  const childEnv={...env,DISPLAY:config.display,XAUTHORITY:config.authority};
  const auth=launch('xauth','xauth',['-f',config.authority,'add',config.display,'.',randomBytes(16).toString('hex')],childEnv);
  await new Promise<void>((resolve,reject)=>{auth.once('error',()=>reject(new Error('xauth is missing. Install the desktop packages first.')));auth.once('exit',code=>code===0?resolve():reject(new Error('Could not create Xauthority')));});
  // xauth is a one-shot utility, not a monitored desktop component.
  failure=undefined;chmodSync(config.authority,0o600);
  const xvfb=launch('Xvfb','Xvfb',[config.display,'-screen','0','1440x1000x24','-auth',config.authority,'-nolisten','tcp'],childEnv);
  await waitFor(()=>displayReady(config.display),()=>alive(xvfb));
  launch('openbox','openbox',[],childEnv);
  const vnc=launch('x11vnc','x11vnc',['-display',config.display,'-auth',config.authority,'-rfbauth',config.password,'-localhost','-rfbport',String(config.vncPort),'-forever','-shared','-noxdamage'],childEnv);
  await waitFor(()=>listening({port:config.vncPort,host:'127.0.0.1'}),()=>alive(vnc));
  const web=launch('websockify','websockify',['--web',config.web,`127.0.0.1:${config.webPort}`,`127.0.0.1:${config.vncPort}`],childEnv);
  await waitFor(()=>listening({port:config.webPort,host:'127.0.0.1'}),()=>alive(web));
  console.log('Remote browser enabled through the console /desktop/ route. VNC and noVNC listen on loopback only.');
  app=launch('console',process.execPath,['--disable-warning=ExperimentalWarning','scripts/start-server.ts',...args],{...childEnv,PITCH_HEADLESS:'0',PITCH_DESKTOP_UPSTREAM:`http://127.0.0.1:${config.webPort}`});
  while(!stopping&&alive(app))await new Promise(resolve=>setTimeout(resolve,500));
  if(failure)throw failure;if(app.exitCode||app.signalCode&&!stopping)throw new Error('Console stopped with an error. Check runtime logs.');
 }finally{await stop();process.removeListener('SIGINT',signal);process.removeListener('SIGTERM',signal);}
}
