import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SecretStorage} from '../src/secret-storage.ts';
import {browserOptions,manualBrowserUrl} from '../src/runtime-config.ts';

test('Windows and Linux choose usable browser channels and display modes',()=>{
  assert.equal(browserOptions('win32',{}).channel,'msedge');assert.equal(browserOptions('win32',{}).headless,false);
  assert.equal(browserOptions('linux',{}).channel,undefined);assert.equal(browserOptions('linux',{}).headless,true);
  assert.equal(browserOptions('linux',{DISPLAY:':99'}).headless,false);assert.equal(browserOptions('linux',{PITCH_HEADLESS:'0'}).headless,false);
  assert.equal(browserOptions('win32',{PITCH_BROWSER_CHANNEL:'chromium',PITCH_HEADLESS:'1'}).channel,'chromium');
  assert.throws(()=>manualBrowserUrl({PITCH_MANUAL_BROWSER_URL:'javascript:alert(1)'}));assert.equal(manualBrowserUrl({PITCH_MANUAL_BROWSER_URL:'https://desktop.example.invalid/vnc.html'}),'https://desktop.example.invalid/vnc.html');
});
test('Linux encryption survives restart, rejects cross-account ciphertext and detects tampering',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pitch-linux-vault-'));
  try{const vault=new SecretStorage(root,'linux');const plain=Buffer.from('fixture password 中文');const [first,second]=await Promise.all([vault.protect(plain,'ggcb'),vault.protect(plain,'feishu')]);
    assert.equal((await new SecretStorage(root,'linux').unprotect(first,'ggcb')).toString(),plain.toString());assert.equal((await vault.unprotect(second,'feishu')).toString(),plain.toString());assert.ok(!JSON.stringify(first).includes('password'));
    await assert.rejects(vault.unprotect(first,'council'));await assert.rejects(vault.unprotect({...first,ciphertext:Buffer.from('tampered').toString('base64')},'ggcb'));
    assert.equal((await readFile(join(root,'secrets','master.key'))).length,32);if(process.platform!=='win32')assert.equal((await stat(join(root,'secrets','master.key'))).mode&0o077,0);
  }finally{await rm(root,{recursive:true,force:true});}
});
