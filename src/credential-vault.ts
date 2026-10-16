import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseCredentials} from './auth.ts';
import type {Credentials} from './auth.ts';
import type {ProviderId} from './domain.ts';

// Secrets travel through stdin/stdout pipes, never command arguments or logs.
// DPAPI CurrentUser binds ciphertext to the Windows account. No key file exists.
async function dpapi(operation:'Protect'|'Unprotect',input:Buffer,provider:ProviderId):Promise<Buffer> {
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

export class CredentialVault {
  folder:string;
  #pending=new Map<ProviderId,Promise<unknown>>();
  constructor(root:string){this.folder=join(root,'credentials');}
  private queue<T>(provider:ProviderId,fn:()=>Promise<T>):Promise<T> {
    const job=(this.#pending.get(provider)||Promise.resolve()).catch(()=>{}).then(fn);
    this.#pending.set(provider,job);return job;
  }
  save(provider:ProviderId,credentials:Credentials) {
    return this.queue(provider,async()=>{
      const plaintext=Buffer.from(JSON.stringify(credentials),'utf8');let encrypted:Buffer;
      try{encrypted=await dpapi('Protect',plaintext,provider);}finally{plaintext.fill(0);}
      await mkdir(this.folder,{recursive:true});
      const temporary=join(this.folder,`${provider}.${randomUUID()}.tmp`);
      try{await writeFile(temporary,JSON.stringify({version:1,protection:'DPAPI-CurrentUser',ciphertext:encrypted.toString('base64')}),{mode:0o600});await rename(temporary,join(this.folder,`${provider}.json`));}
      finally{await rm(temporary,{force:true});}
    });
  }
  load(provider:ProviderId):Promise<Credentials|undefined> {
    return this.queue(provider,async()=>{
      let raw:string;
      try{raw=await readFile(join(this.folder,`${provider}.json`),'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw new Error('本地凭据无法读取，请重新保存账号');}
      try {
        const data=JSON.parse(raw);if(data.version!==1 || data.protection!=='DPAPI-CurrentUser' || typeof data.ciphertext!=='string' || data.ciphertext.length>32768)throw new Error();
        const plaintext=await dpapi('Unprotect',Buffer.from(data.ciphertext,'base64'),provider);
        try{return parseCredentials(JSON.parse(plaintext.toString('utf8')));}finally{plaintext.fill(0);}
      }catch{throw new Error('本地凭据无法解密，请重新保存账号');}
    });
  }
  remove(provider:ProviderId){return this.queue(provider,()=>rm(join(this.folder,`${provider}.json`),{force:true}));}
}
