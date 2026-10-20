import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeVerification,verificationBrowser} from '../src/native-verification.ts';
import {ProviderSession} from '../src/browser.ts';
import {resources} from '../src/domain.ts';

test('ordinary browser verification requires a graphical Linux desktop and accepts configured browser paths',()=>{
 assert.throws(()=>verificationBrowser('linux',{}),/图形桌面/);
 assert.equal(verificationBrowser('linux',{DISPLAY:':1',PITCH_BROWSER_EXECUTABLE:'/usr/bin/chromium'}),'/usr/bin/chromium');
 assert.equal(verificationBrowser('win32',{PITCH_BROWSER_EXECUTABLE:'C:\\Browser\\msedge.exe'}),'C:\\Browser\\msedge.exe');
});
test('an ordinary verification window stays protected across service restart and shutdown',async()=>{
 const root=mkdtempSync(join(tmpdir(),'pitch-native-marker-'));const native=new NativeVerification(root,'playfootball');mkdirSync(join(root,'native-verification'));
 writeFileSync(native.path,JSON.stringify({pid:process.pid}));const session=new ProviderSession('playfootball',root);
 try{assert.equal(native.active,true);assert.equal(session.mode,'MANUAL_CONTROL');assert.equal(await session.resumeAfterInactivity(Date.now()+600000),false);await assert.rejects(session.getContext(),/请先关闭/);await session.close();assert.equal(native.active,true);assert.equal(native.pending,true);}
 finally{rmSync(root,{recursive:true,force:true});}
});
test('entering ordinary verification drains the owned browser and preserves saved account state',async t=>{
 const previous=process.env.PITCH_BROWSER_EXECUTABLE;process.env.PITCH_BROWSER_EXECUTABLE=process.execPath;const display=process.env.DISPLAY;process.env.DISPLAY=':fixture';t.after(()=>{if(previous===undefined)delete process.env.PITCH_BROWSER_EXECUTABLE;else process.env.PITCH_BROWSER_EXECUTABLE=previous;if(display===undefined)delete process.env.DISPLAY;else process.env.DISPLAY=display;});
 const session=new ProviderSession('playfootball','.local/test-unused');const order:string[]=[];
 session.saveSession=async()=>{order.push('save');};let close!:()=>void;session.job=new Promise<void>(resolve=>close=resolve);session.context={close:async()=>{order.push('close');close();}} as any;
 session.hasSavedCredentials=true;session.nativeVerification.open=async(profile,url)=>{order.push('open');assert.ok(profile.endsWith(join('profiles','playfootball')));assert.equal(url,resources[2].url);};
 await session.verifyInBrowser();assert.deepEqual(order,['save','close','open']);assert.equal(session.mode,'MANUAL_CONTROL');assert.equal(session.hasSavedCredentials,true);assert.equal(session.needsHumanVerification,true);assert.equal(session.context,undefined);assert.equal(session.job,undefined);
});
test('a closed ordinary window resumes into the same profile, while explicit pause still wins',async()=>{
 const session=new ProviderSession('playfootball','.local/test-unused');let pending=true,opened=0,navigations=0;
 Object.defineProperties(session.nativeVerification,{active:{get:()=>false},pending:{get:()=>pending}});session.nativeVerification.clear=()=>{pending=false;};
 const page={isClosed:()=>false,url:()=>resources[2].url,goto:async()=>{navigations++;},locator:()=>({first:()=>({waitFor:async()=>{}})})};
 session.getContext=async()=>{opened++;return {newPage:async()=>page} as any;};session.saveSession=async()=>{};session.check=async()=>{session.needsHumanVerification=false;return session.status='ANONYMOUS_READABLE';};
 session.mode='PAUSED';assert.equal(await session.resumeAfterInactivity(),false);assert.equal(opened,0);
 session.mode='MANUAL_CONTROL';session.needsHumanVerification=true;session.lastManualActivityAt=Date.now()-61000;
 assert.equal(await session.resumeAfterInactivity(),true);assert.equal(session.mode,'AUTOMATION');assert.equal(pending,false);assert.equal(navigations,1);assert.equal(await session.page(resources[2]),page);assert.equal(navigations,1);
});
