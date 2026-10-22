import {test} from 'node:test';
import assert from 'node:assert/strict';
import {preflightBrowser} from '../src/browser-preflight.ts';

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
