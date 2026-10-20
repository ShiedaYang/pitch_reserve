import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProviderSession,Interrupted} from '../src/browser.ts';
import {resources} from '../src/domain.ts';
import type {CredentialVault} from '../src/credential-vault.ts';
import type {BrowserContext} from 'playwright';

test('restart closes the owned browser before draining a scan, preserves cookies and credentials, and leaves another provider open',{timeout:30000},async t=>{
  const previousHeadless=process.env.PITCH_HEADLESS;process.env.PITCH_HEADLESS='1';t.after(()=>{if(previousHeadless===undefined)delete process.env.PITCH_HEADLESS;else process.env.PITCH_HEADLESS=previousHeadless;});const root=await mkdtemp(join(tmpdir(),'pitch-browser-restart-'));
  const vault={load:async()=>({username:'fixture@example.invalid',password:'fixture-not-returned'})} as unknown as CredentialVault;
  const session=new ProviderSession('ggcb',root,vault),other=new ProviderSession('playfootball',root);const get=session.getContext.bind(session);
  session.getContext=async()=>{const context=await get();await context.route('https://ggcb.co.uk/**',route=>route.fulfill({contentType:'text/html',body:'<a href="/logout">Log out</a><p>Readonly fixture</p>'}));return context;};
  try{await session.restoreCredentials();const old=await session.getContext();const browser=old.browser();const otherContext=await other.getContext();await old.addCookies([{name:'restart_fixture',value:'kept',url:'https://ggcb.co.uk/'}]);
    const closed=new Promise<void>(resolve=>old.once('close',()=>resolve()));session.job=closed;
    await session.restartBrowser(resources[0]);assert.equal(browser?.isConnected(),false);assert.notEqual(session.context,old);assert.equal(other.context,otherContext);assert.equal(otherContext.browser()?.isConnected(),true);assert.equal(session.hasCredentials,true);assert.equal(session.savedUsername,'fixture@example.invalid');assert.equal((await session.context!.cookies('https://ggcb.co.uk/')).find(cookie=>cookie.name==='restart_fixture')?.value,'kept');assert.equal(session.manualPage?.url(),resources[0].url);assert.equal(session.mode,'AUTOMATION');assert.equal(session.restarting,false);assert.equal(session.job,undefined);
    session.mode='PAUSED';await session.restartBrowser(resources[0]);assert.equal(session.mode,'PAUSED');assert.ok(session.context);assert.equal(session.hasCredentials,true);
  }finally{session.mode='PAUSED';other.mode='PAUSED';await session.close();await other.close();await rm(root,{recursive:true,force:true});}
});

test('a newer pause cancels restart and concurrent restart attempts cannot open duplicate browsers',async()=>{
  const session=new ProviderSession('council','.local/test-unused');let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let closed=0,opened=0;
  session.context={close:async()=>{closed++;}} as unknown as BrowserContext;session.saveSession=async()=>{await gate;};session.getContext=async()=>{opened++;throw new Error('must not open');};
  const restarting=session.restartBrowser(resources[1]);await assert.rejects(session.restartBrowser(resources[1]),/正在重启/);session.mode='PAUSED';release();await assert.rejects(restarting,Interrupted);assert.equal(closed,1);assert.equal(opened,0);assert.equal(session.mode,'PAUSED');assert.equal(session.restarting,false);assert.equal(session.job,undefined);
});

test('a failed close never launches another process against the same profile and returns a safe message',async()=>{
  const session=new ProviderSession('ggcb','.local/test-unused');let opened=0;session.saveSession=async()=>{};session.context={close:async()=>{throw new Error('fixture-private-details');}} as unknown as BrowserContext;session.getContext=async()=>{opened++;throw new Error('must not open');};
  await assert.rejects(session.restartBrowser(resources[0]),error=>error instanceof Error&&/重启失败/.test(error.message)&&!error.message.includes('fixture-private-details'));assert.equal(opened,0);assert.equal(session.mode,'MANUAL_CONTROL');assert.equal(session.restarting,false);
});
