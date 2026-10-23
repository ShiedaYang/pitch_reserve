import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {ProviderSession} from '../src/browser.ts';
import {resources} from '../src/domain.ts';

test('restart keeps fresh profile cookies instead of overwriting them with an older session snapshot',async t=>{
 const root=mkdtempSync(join(tmpdir(),'pitch-pf-cookies-'));const session=new ProviderSession('playfootball',root);
 const persisted=[{name:'account_session',value:'fresh-profile',domain:'.playfootball.net',path:'/',expires:Date.now()/1000+3600,httpOnly:true,secure:true,sameSite:'Lax'}];let restored:any[]=[];
 mkdirSync(join(root,'sessions'),{recursive:true});writeFileSync(join(root,'sessions/playfootball.json'),JSON.stringify({cookies:[{...persisted[0],value:'old-snapshot'},{...persisted[0],name:'expired_session',expires:1},{...persisted[0],name:'cf_clearance',value:'old-verification'}]}));
 const context={cookies:async()=>persisted,addCookies:async(cookies:any[])=>{restored=cookies;},setDefaultTimeout(){},setDefaultNavigationTimeout(){},on(){}};
 session.trackManualActivity=async()=>{};t.mock.method(chromium,'launchPersistentContext',async()=>context);
 try{await session.getContext();assert.deepEqual(restored,[],'old cookies must not overwrite native profile state or restore expired/challenge cookies');}finally{rmSync(root,{recursive:true,force:true});}
});

test('manual verification recovery reuses the verified PlayFootball calendar without a new navigation',async()=>{
 const session=new ProviderSession('playfootball','.local/test-unused');const resource=resources[2];let navigations=0;
 const page={isClosed:()=>false,url:()=>resource.url,goto:async()=>{navigations++;},locator:()=>({count:async()=>1})};
 session.pages.set(resource.id,page as any);session.manualPage=page as any;session.mode='MANUAL_CONTROL';session.needsHumanVerification=true;session.lastManualActivityAt=Date.now()-61000;
 session.check=async()=>{session.needsHumanVerification=false;session.status='ANONYMOUS_READABLE';return session.status;};session.getContext=async()=>({} as any);session.saveSession=async()=>{};
 assert.equal(await session.resumeAfterInactivity(),true);assert.equal(await session.page(resource),page);assert.equal(navigations,0,'do not immediately reload the calendar the user just verified');
});

test('failed session restoration closes the newly launched browser and releases its profile',async t=>{
 const root=mkdtempSync(join(tmpdir(),'pitch-session-corrupt-'));const session=new ProviderSession('playfootball',root);let closed=0;
 mkdirSync(join(root,'sessions'));writeFileSync(join(root,'sessions/playfootball.json'),'{broken');
 const context={setDefaultTimeout(){},setDefaultNavigationTimeout(){},close:async()=>{closed++;}};
 session.trackManualActivity=async()=>{};t.mock.method(chromium,'launchPersistentContext',async()=>context);
 try{await assert.rejects(session.getContext());assert.equal(closed,1);assert.equal(session.context,undefined);assert.equal(session.opening,undefined);}
 finally{rmSync(root,{recursive:true,force:true});}
});
