import {spawn} from 'node:child_process';
// Secrets travel through stdin/stdout pipes, never command arguments or logs.
// DPAPI CurrentUser binds ciphertext to the Windows account. No key file exists.
export async function dpapi(operation:'Protect'|'Unprotect',input:Buffer,provider:string):Promise<Buffer> {
  if(process.platform!=='win32')throw new Error('本地凭据加密需要 Windows');
  const script=`$ErrorActionPreference='Stop'; try { Add-Type -AssemblyName System.Security; $inputBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $entropy=[Text.Encoding]::UTF8.GetBytes('pitch-reserve:v1:${provider}'); $result=[Security.Cryptography.ProtectedData]::${operation}($inputBytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result)); } catch { exit 1 }`;
  return new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    const chunks:Buffer[]=[];let size=0;
    const fail=()=>reject(new Error('本地凭据加密存储不可用，请重新保存账号'));
    const timer=setTimeout(()=>{child.kill();fail();},15000);
    child.on('error',()=>{clearTimeout(timer);fail();});
    child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>32768){child.kill();fail();}else chunks.push(chunk);});
    child.stderr.resume();child.stdin.on('error',()=>{});
    child.on('close',code=>{clearTimeout(timer);if(code!==0){fail();return;}const encoded=Buffer.concat(chunks).toString('ascii').trim();if(!encoded || !/^[A-Za-z0-9+/=]+$/.test(encoded)){fail();return;}resolve(Buffer.from(encoded,'base64'));});
    child.stdin.end(input.toString('base64'));
  });
}
