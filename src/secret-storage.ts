import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile,stat,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {dpapi} from './dpapi.ts';

export type SecretEnvelope={version:1;protection:'DPAPI-CurrentUser';ciphertext:string}|{version:2;protection:'AES-256-GCM';iv:string;tag:string;ciphertext:string};
export class SecretStorage{
  root:string;platform:NodeJS.Platform;
  constructor(root:string,platform:NodeJS.Platform=process.platform){this.root=root;this.platform=platform;}
  private async key(){
    const supplied=process.env.PITCH_ENCRYPTION_KEY;
    if(supplied){const key=Buffer.from(supplied,'base64');if(key.length!==32||key.toString('base64')!==supplied)throw new Error('PITCH_ENCRYPTION_KEY 必须是32字节的Base64密钥');return key;}
    const folder=join(this.root,'secrets');await mkdir(folder,{recursive:true,mode:0o700});if(process.platform!=='win32')await chmod(folder,0o700);
    const path=join(folder,'master.key');try{await writeFile(path,randomBytes(32),{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    if(process.platform!=='win32'&&((await stat(path)).mode&0o077))throw new Error('本地加密密钥权限应为600');
    const key=await readFile(path);if(key.length!==32)throw new Error('本地加密密钥无效');return key;
  }
  async protect(plain:Buffer,purpose:string):Promise<SecretEnvelope>{
    if(this.platform==='win32')return {version:1,protection:'DPAPI-CurrentUser',ciphertext:(await dpapi('Protect',plain,purpose)).toString('base64')};
    const key=await this.key();try{const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from('pitch-reserve:v2:'+purpose));const encrypted=Buffer.concat([cipher.update(plain),cipher.final()]);return {version:2,protection:'AES-256-GCM',iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:encrypted.toString('base64')};}finally{key.fill(0);}
  }
  async unprotect(input:unknown,purpose:string):Promise<Buffer>{
    if(!input||typeof input!=='object')throw new Error('加密数据无效');const data=input as SecretEnvelope;
    if(typeof data.ciphertext!=='string'||data.ciphertext.length>32768)throw new Error('加密数据无效');
    if(data.version===1&&data.protection==='DPAPI-CurrentUser')return dpapi('Unprotect',Buffer.from(data.ciphertext,'base64'),purpose);
    if(data.version!==2||data.protection!=='AES-256-GCM'||typeof data.iv!=='string'||typeof data.tag!=='string')throw new Error('加密数据无效');
    const key=await this.key();try{const iv=Buffer.from(data.iv,'base64'),tag=Buffer.from(data.tag,'base64');if(iv.length!==12||tag.length!==16)throw new Error('加密数据无效');const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(Buffer.from('pitch-reserve:v2:'+purpose));decipher.setAuthTag(tag);return Buffer.concat([decipher.update(Buffer.from(data.ciphertext,'base64')),decipher.final()]);}finally{key.fill(0);}
  }
}
