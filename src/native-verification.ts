import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {chromium} from 'playwright';
import {browserOptions} from './runtime-config.ts';
import type {ProviderId} from './domain.ts';

export function verificationBrowser(platform=process.platform,env=process.env){
  if(platform!=='win32'&&!env.DISPLAY)throw new Error('普通浏览器验证需要图形桌面；请先配置 Linux 远程桌面和 DISPLAY。');
  if(env.PITCH_BROWSER_EXECUTABLE)return env.PITCH_BROWSER_EXECUTABLE;
  const channel=browserOptions(platform,env).channel;
  if(platform==='win32'&&channel!=='chromium'){
    const suffix=channel==='chrome'?'Google/Chrome/Application/chrome.exe':'Microsoft/Edge/Application/msedge.exe';
    const executable=[env['ProgramFiles(x86)'],env.ProgramFiles,env.LOCALAPPDATA].filter(Boolean).map(root=>join(root!,suffix)).find(existsSync);
    if(executable)return executable;
  }
  if(platform==='linux'&&(channel==='chrome'||channel==='msedge')){
    const paths=channel==='chrome'?['/opt/google/chrome/chrome','/usr/bin/google-chrome','/usr/bin/google-chrome-stable']:['/opt/microsoft/msedge/msedge','/usr/bin/microsoft-edge','/usr/bin/microsoft-edge-stable'];
    const executable=paths.find(existsSync);if(executable)return executable;
  }
  if((!channel||channel==='chromium')&&existsSync(chromium.executablePath()))return chromium.executablePath();
  throw new Error('普通浏览器未找到，请配置 PITCH_BROWSER_EXECUTABLE 为 Edge、Chrome 或 Chromium 的可执行文件。');
}

// No automation/debugging connection is attached during the human-owned phase.
// The marker survives service restarts; we never kill a PID read from disk.
export class NativeVerification {
  path:string;
  constructor(root:string,id:ProviderId){this.path=join(root,'native-verification',`${id}.json`);}
  get pending(){return existsSync(this.path);}
  get active(){
    if(!this.pending)return false;
    try{const {pid}=JSON.parse(readFileSync(this.path,'utf8'));if(!Number.isInteger(pid)||pid<=0)return false;process.kill(pid,0);return true;}
    catch(error){return (error as NodeJS.ErrnoException).code==='EPERM';}
  }
  clear(){rmSync(this.path,{force:true});}
  async open(profile:string,url:string){
    if(this.active)throw new Error('请先关闭普通浏览器验证窗口，再操作此网站。');
    const executable=verificationBrowser();mkdirSync(dirname(this.path),{recursive:true,mode:0o700});
    const child=spawn(executable,[`--user-data-dir=${profile}`,'--disable-background-mode','--new-window',url],{stdio:'ignore',detached:true,windowsHide:false});
    await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(new Error('普通浏览器启动失败，请检查浏览器路径和图形桌面。')));});
    try{writeFileSync(this.path,JSON.stringify({pid:child.pid}),{mode:0o600});}catch{child.kill();throw new Error('普通浏览器状态无法保存，请检查数据目录权限。');}child.unref();
  }
}
