import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProviderSession} from '../src/browser.ts';
import {Monitor} from '../src/monitor.ts';
import {Store} from '../src/store.ts';
import type {BrowserContext} from 'playwright';

test('an interrupted session save leaves the previous login snapshot intact',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pitch-session-save-'));const session=new ProviderSession('ggcb',root);
 try{await mkdir(join(root,'sessions'));const path=join(root,'sessions','ggcb.json');await writeFile(path,'{"cookies":[]}');
  session.context={storageState:async(options:{path:string})=>{await writeFile(options.path,'incomplete');throw new Error('interrupted');}} as unknown as BrowserContext;
  await assert.rejects(session.saveSession());assert.equal(await readFile(path,'utf8'),'{"cookies":[]}');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('memory reclamation closes a real owned browser without reopening it and keeps its persistent login',{timeout:30000},async t=>{
 const before=process.env.PITCH_HEADLESS;process.env.PITCH_HEADLESS='1';t.after(()=>{if(before===undefined)delete process.env.PITCH_HEADLESS;else process.env.PITCH_HEADLESS=before;});
 const root=await mkdtemp(join(tmpdir(),'pitch-reclaim-'));const session=new ProviderSession('ggcb',root);
 try{const context=await session.getContext();await context.addCookies([{name:'reclaim_fixture',value:'kept',url:'https://ggcb.co.uk/'}]);const start=Date.now();
  assert.equal(await session.recycleBrowser(),true);assert.equal(session.context,undefined);assert.equal(context.browser()?.isConnected(),false);assert.equal(session.mode,'AUTOMATION');assert.ok(session.nextScanAt>=start+300000);
  const restored=await session.getContext();assert.equal((await restored.cookies('https://ggcb.co.uk/')).find(c=>c.name==='reclaim_fixture')?.value,'kept');
 }finally{session.mode='PAUSED';await session.close();await rm(root,{recursive:true,force:true});}
});

test('manual verification is excluded; a busy automatic scan can be cancelled and a newer user pause is preserved',async()=>{
 const session=new ProviderSession('playfootball','.local/test-unused');let closed=0;let release!:()=>void;
 session.saveSession=async()=>{};session.context={close:async()=>{closed++;release?.();}} as unknown as BrowserContext;
 session.mode='MANUAL_CONTROL';assert.equal(await session.recycleBrowser(),false);assert.equal(closed,0);
 session.mode='AUTOMATION';session.needsHumanVerification=true;assert.equal(await session.recycleBrowser(),false);session.needsHumanVerification=false;
 const job=session.exclusive(()=>new Promise<void>(resolve=>release=resolve));await Promise.resolve();
 const reclaim=session.recycleBrowser();session.mode='PAUSED';assert.equal(await reclaim,true);await job;assert.equal(session.mode,'PAUSED');assert.equal(closed,1);
});

test('monitor reclaims one provider at a time, rotates fairly, and retains website cooldown and explicit pause',async()=>{
 const store=new Store(':memory:');const monitor=new Monitor(store,'.local/test-unused');const calls:string[]=[];
 try{for(const session of monitor.sessions.values()){session.context={} as BrowserContext;session.recycleBrowser=async()=>{calls.push(session.id);return true;};}
  monitor.sessions.get('council')!.mode='MANUAL_CONTROL';
  assert.equal(await monitor.reclaimMemory(),true);assert.equal(await monitor.reclaimMemory(),true);assert.deepEqual(calls,['ggcb','playfootball']);
  const pf=monitor.sessions.get('playfootball')!;pf.mode='PAUSED';pf.cooldownUntil=Date.now()+3600000;
  const checkpoint=monitor.recoveryState();const recovered=new Monitor(store,'.local/test-unused');recovered.restoreRuntimeState(checkpoint);
  assert.equal(recovered.sessions.get('playfootball')!.mode,'PAUSED');assert.equal(recovered.sessions.get('playfootball')!.cooldownUntil,pf.cooldownUntil);
 }finally{store.close();}
});

test('recovery checkpoints distinguish an internal reclamation pause from a newer user pause',async()=>{
 const store=new Store(':memory:');const monitor=new Monitor(store,'.local/test-unused'),session=monitor.sessions.get('ggcb')!;
 let release!:()=>void;const closed=new Promise<void>(resolve=>release=resolve);session.saveSession=async()=>{};session.context={close:()=>closed} as unknown as BrowserContext;
 const reclaim=monitor.reclaimMemory();try{await new Promise(resolve=>setImmediate(resolve));
  assert.equal(monitor.recoveryState()[0].mode,'AUTOMATION');session.mode='PAUSED';assert.equal(monitor.recoveryState()[0].mode,'PAUSED');release();await reclaim;
 }finally{release();await reclaim;store.close();}
});

test('date rollover, immediate scans and recovery do not bypass the browser reclamation rest',async()=>{
 const store=new Store(':memory:');const monitor=new Monitor(store,'.local/test-unused'),session=monitor.sessions.get('ggcb')!;
 try{for(const other of monitor.sessions.values())other.mode='PAUSED';session.mode='AUTOMATION';session.memoryRestUntil=Date.now()+300000;
  (monitor as any).lastWindow='previous-day';let scans=0;session.page=async()=>{scans++;throw new Error('must not open');};
  await monitor.tick();await monitor.action('ggcb','scan');await monitor.scan('ggcb');assert.equal(scans,0);assert.equal(session.nextScanAt,session.memoryRestUntil);
  const recovered=new Monitor(store,'.local/test-unused');recovered.restoreRuntimeState(monitor.recoveryState());assert.equal(recovered.sessions.get('ggcb')!.scanNotBefore,session.memoryRestUntil);
 }finally{store.close();}
});
