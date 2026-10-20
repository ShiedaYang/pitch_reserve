import {SecretStorage} from './secret-storage.ts';
import {mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseCredentials} from './auth.ts';
import type {Credentials} from './auth.ts';
import type {ProviderId} from './domain.ts';

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
      const plaintext=Buffer.from(JSON.stringify(credentials),'utf8');let encrypted;
      try{encrypted=await new SecretStorage(dirname(this.folder)).protect(plaintext,provider);}finally{plaintext.fill(0);}
      await mkdir(this.folder,{recursive:true,mode:0o700});
      const temporary=join(this.folder,`${provider}.${randomUUID()}.tmp`);
      try{await writeFile(temporary,JSON.stringify(encrypted),{mode:0o600});await rename(temporary,join(this.folder,`${provider}.json`));}
      finally{await rm(temporary,{force:true});}
    });
  }
  load(provider:ProviderId):Promise<Credentials|undefined> {
    return this.queue(provider,async()=>{
      let raw:string;
      try{raw=await readFile(join(this.folder,`${provider}.json`),'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw new Error('本地凭据无法读取，请重新保存账号');}
      try {
        const plaintext=await new SecretStorage(dirname(this.folder)).unprotect(JSON.parse(raw),provider);
        try{return parseCredentials(JSON.parse(plaintext.toString('utf8')));}finally{plaintext.fill(0);}
      }catch{throw new Error('本地凭据无法解密，请重新保存账号');}
    });
  }
  remove(provider:ProviderId){return this.queue(provider,()=>rm(join(this.folder,`${provider}.json`),{force:true}));}
}
