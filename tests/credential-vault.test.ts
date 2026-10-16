import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CredentialVault} from '../src/credential-vault.ts';
import {ProviderSession} from '../src/browser.ts';
import {Monitor} from '../src/monitor.ts';
import {Store} from '../src/store.ts';

test('Windows encrypted credentials survive process-style restoration, stay isolated, and can be removed',{skip:process.platform!=='win32'},async()=>{
  const root=await mkdtemp(join(tmpdir(),'pitch-vault-'));const vault=new CredentialVault(root);
  const credentials={username:'fixture@example.invalid',password:' 中文 secret with spaces '};
  try {
    await vault.save('ggcb',credentials);await vault.save('council',{username:'other@example.invalid',password:'different fixture'});
    const raw=await readFile(join(root,'credentials','ggcb.json'),'utf8');assert.ok(!raw.includes(credentials.username));assert.ok(!raw.includes('secret'));assert.ok(!raw.includes('中文'));
    const restored=new ProviderSession('ggcb',root,new CredentialVault(root));await restored.restoreCredentials();assert.equal(restored.hasCredentials,true);assert.equal(restored.hasSavedCredentials,true);assert.equal(restored.savedUsername,credentials.username);
    const store=new Store(':memory:');try{const monitor=new Monitor(store,root,true);await monitor.restoreCredentials();const state=monitor.state();assert.equal(state.providers.find(provider=>provider.id==='ggcb')?.savedUsername,credentials.username);assert.equal(state.providers.find(provider=>provider.id==='council')?.savedUsername,'other@example.invalid');assert.ok(!JSON.stringify(state).includes(credentials.password));assert.ok(!JSON.stringify(state).includes('different fixture'));assert.ok(!state.providers.some(provider=>'password' in provider));}finally{store.close();}
    assert.deepEqual(await new CredentialVault(root).load('ggcb'),credentials);
    await restored.close();assert.equal(restored.hasCredentials,false);assert.deepEqual(await vault.load('ggcb'),credentials);
    const next=new ProviderSession('ggcb',root,new CredentialVault(root));await next.restoreCredentials();await next.forgetCredentials();assert.equal(next.savedUsername,undefined);assert.equal(await vault.load('ggcb'),undefined);assert.equal((await vault.load('council'))?.username,'other@example.invalid');
    // Ciphertext copied to another provider must not decrypt under its entropy.
    await writeFile(join(root,'credentials','playfootball.json'),raw);await assert.rejects(vault.load('playfootball'),/无法解密/);
    await writeFile(join(root,'credentials','council.json'),'corrupt');const broken=new ProviderSession('council',root,vault);await broken.restoreCredentials();assert.equal(broken.hasCredentials,false);assert.match(broken.credentialError||'',/重新保存/);
  }finally{await rm(root,{recursive:true,force:true});}
});
