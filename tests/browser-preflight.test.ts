import {test} from 'node:test';
import assert from 'node:assert/strict';
import {preflightBrowser} from '../src/browser-preflight.ts';
import {diagnoseError} from '../src/activity-log.ts';

test('missing Linux headless shell explains versioned installation and per-user cache once',async()=>{
 let attempts=0;await assert.rejects(preflightBrowser(async()=>{attempts++;throw new Error("Executable doesn't exist at /home/example/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell");},'linux',{PITCH_HEADLESS:'1'}),error=>error instanceof Error&&/npx playwright install --with-deps chromium/.test(error.message)&&/同一用户/.test(error.message)&&!/\/home\/example/.test(error.message));assert.equal(attempts,1);
});
test('Windows browser, custom executable, missing libraries and GUI faults get appropriate guidance',async()=>{
 const missing=async()=>{throw new Error("Executable doesn't exist at fixture");};
 await assert.rejects(preflightBrowser(missing,'win32',{}),/npx playwright install msedge/);
 await assert.rejects(preflightBrowser(missing,'linux',{PITCH_BROWSER_EXECUTABLE:'/missing/chrome'}),/PITCH_BROWSER_EXECUTABLE/);
 await assert.rejects(preflightBrowser(async()=>{throw new Error('Host system is missing dependencies');},'linux',{}),/npx playwright install-deps chromium/);
 await assert.rejects(preflightBrowser(async()=>{throw new Error('fixture private content');},'linux',{}),error=>error instanceof Error&&/DISPLAY/.test(error.message)&&!error.message.includes('fixture private content'));
});
test('healthy startup prepares the same scanner context once and explicit paused startup skips it',async()=>{
 let attempts=0;const prepare=async()=>{attempts++;};await preflightBrowser(prepare,'linux',{});assert.equal(attempts,1);await preflightBrowser(prepare,'linux',{PITCH_START_PAUSED:'1'});assert.equal(attempts,1);
});

test('Linux startup retains an actionable sandbox diagnosis without printing private launch data',async()=>{
 await assert.rejects(preflightBrowser(async()=>{throw new Error('Browser logs: No usable sandbox! AppArmor denies user namespaces. password=fixture-secret /home/private-user/profile https://private.example/?token=private');},'linux',{}),error=>error instanceof Error&&/SANDBOX_UNAVAILABLE/.test(error.message)&&diagnoseError(error).code==='SANDBOX_UNAVAILABLE'&&!/fixture-secret|private-user|private\.example/.test(error.message));
});

test('Linux startup distinguishes display, permissions and profile ownership failures',async()=>{
 for(const [message,code] of [['Missing X server or $DISPLAY','DISPLAY_UNAVAILABLE'],['EACCES: permission denied /home/private-user/profile','BROWSER_PERMISSION'],['Failed to create a ProcessSingleton for your profile directory','PROFILE_IN_USE']]){
  await assert.rejects(preflightBrowser(async()=>{throw new Error(message);},'linux',{}),error=>error instanceof Error&&error.message.includes(code)&&!error.message.includes('private-user'));
 }
});
