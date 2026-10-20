import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {submitLogin,parseCredentials,authSignals} from '../src/auth.ts';
import {ProviderSession} from '../src/browser.ts';
import {providerIds,loginUrls} from '../src/domain.ts';
import {Monitor} from '../src/monitor.ts';
import {Store} from '../src/store.ts';

test('credentials validate without changing password whitespace',()=>{
  assert.deepEqual(parseCredentials({username:' name@example.invalid ',password:' spaced secret '}),{username:'name@example.invalid',password:' spaced secret '});
  assert.throws(()=>parseCredentials({username:'',password:'test'}),/请输入/);
});

test('PlayFootball opens its normal login panel and Council recognizes its protected wizard',async()=>{
  const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true,timeout:30000});
  try {
    const page=await browser.newPage();let posted=false;
    await page.route('**/*',route=>{if(route.request().method()==='POST'){posted=true;return route.fulfill({contentType:'text/html',body:'<a href="/logout">Log out</a>'});}return route.fulfill({contentType:'text/html',body:'<a role="button" href="#log-in-bar" onclick="event.preventDefault();document.getElementById(\'log-in-bar\').hidden=false">Account</a><div id="log-in-bar" hidden><form method="post"><input type="email" name="n_EmailAddress_em"><input type="password" name="Password"><button>Log In</button></form></div>'});});
    await page.goto(loginUrls.playfootball);
    const result=await submitLogin(page,'playfootball',{username:'fixture@example.invalid',password:'fixture-secret'},()=>{});assert.equal(result.kind,'AUTHENTICATED');assert.equal(posted,true);
    await page.goto('https://partners.playfootball.net/ControlPanel/Dashboard');await page.setContent('<h1>Looking for a pitch?</h1>');assert.equal((await authSignals(page,'playfootball')).authenticated,true);
    await page.unroute('**/*');await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<h1>Tower Hamlets - forms</h1><iframe src="/en/AchieveForms/"></iframe>'}));
    await page.route('**/en/AchieveForms/',route=>route.fulfill({contentType:'text/html',body:'<h1>Book a sports pitch</h1><select id="footbalPitch" hidden><option>Select…</option></select><input name="TH_borough" type="radio" hidden>'}));
    await page.goto('https://towerhamlets-self.achieveservice.com/en/service/Book_a_sports_pitch');
    assert.equal((await authSignals(page,'council')).authenticated,true);
    await page.frames()[1].evaluate(()=>document.body.hidden=true);assert.equal((await authSignals(page,'council')).authenticated,false);
  }finally{await browser.close();}
});

test('Council login follows its account-home redirect to the fixed booking entry without submitting details',async()=>{
  const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true,timeout:30000});
  try {
    const page=await browser.newPage();let posts=0;const host='https://towerhamlets-self.achieveservice.com';
    await page.route('**/*',route=>{
      const request=route.request();const path=new URL(request.url()).pathname;
      if(request.method()==='POST'){posts++;return route.fulfill({status:302,headers:{location:host+'/'},body:''});}
      if(path==='/')return route.fulfill({contentType:'text/html',body:'<h1>Tower Hamlets forms</h1>'});
      if(path==='/service/Book_a_sports_pitch')return route.fulfill({contentType:'text/html',body:'<h1>Book a sports pitch</h1><select id="footbalPitch"><option>Stepney Green</option></select><input type="radio" name="TH_borough">'});
      return route.fulfill({contentType:'text/html',body:'<form method="post"><input type="email" name="username"><input type="password"><button>Log in</button></form>'});
    });
    await page.goto(loginUrls.council);const result=await submitLogin(page,'council',{username:'fixture@example.invalid',password:'fixture-secret'},()=>{});assert.equal(result.kind,'AUTHENTICATED');assert.equal(posts,1);assert.equal(new URL(page.url()).pathname,'/service/Book_a_sports_pitch');
  }finally{await browser.close();}
});

test('three account groups submit only their login form and never expose unsaved credentials in state',async()=>{
  const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true,timeout:30000});
  const store=new Store(':memory:');const monitor=new Monitor(store,'.local/test-unused');
  const posts:Array<{provider:string;username:string;password:string}>=[];
  try {
    for(const provider of providerIds) {
      const context=await browser.newContext();
      await context.route('**/*',route=>{
        const request=route.request();
        if(request.method()==='POST') {
          const data=new URLSearchParams(request.postData()||'');posts.push({provider,username:data.get('username')||data.get('Email')||'',password:data.get('password')||''});
          return route.fulfill({contentType:'text/html',body:'<a href="/logout">Log out</a>'});
        }
        return route.fulfill({contentType:'text/html',body:`<form method="post" action="/session"><input name="${provider==='playfootball'?'Email':'username'}" type="${provider==='ggcb'?'text':'email'}" autocomplete="username"><input type="password" name="password" autocomplete="current-password"><button type="submit">${provider==='playfootball'?'Log In':'Log in'}</button></form><form><input name="reg_email" type="email"><button>Register</button></form>`});
      });
      const session=monitor.sessions.get(provider)!;session.context=context;session.saveSession=async()=>{};
      const result=await session.signIn({username:`${provider}@example.invalid`,password:`fixture-secret-${provider}`});
      assert.equal(result.kind,'AUTHENTICATED');assert.equal(session.hasCredentials,true);
    }
    assert.equal(posts.length,3);
    for(const post of posts){assert.equal(post.username,`${post.provider}@example.invalid`);assert.equal(post.password,`fixture-secret-${post.provider}`);}
    const serialized=JSON.stringify(monitor.state());assert.ok(!serialized.includes('fixture-secret'));assert.ok(!serialized.includes('@example.invalid'));
    await monitor.sessions.get('ggcb')!.forgetCredentials();assert.equal(monitor.sessions.get('ggcb')!.hasCredentials,false);assert.equal(monitor.sessions.get('council')!.hasCredentials,true);assert.equal(monitor.sessions.get('playfootball')!.hasCredentials,true);
    await monitor.sessions.get('playfootball')!.close();assert.equal(monitor.sessions.get('playfootball')!.hasCredentials,false);
  }finally{await browser.close();store.close();}
});

test('security verification pauses before filling and fill errors never return password contents',async()=>{
  const browser=await chromium.launch({channel:process.env.PITCH_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true,chromiumSandbox:true,timeout:30000});
  try {
    const page=await browser.newPage();let body='<h1>Performing security verification</h1><form><input name="username"><input type="password"><button>Log in</button></form>';
    await page.route('**/*',route=>route.fulfill({contentType:'text/html',body}));await page.goto(loginUrls.ggcb);
    const credentials={username:'test@example.invalid',password:'fixture-private-password'};
    const blocked=await submitLogin(page,'ggcb',credentials,()=>{});assert.equal(blocked.kind,'MANUAL_REQUIRED');assert.equal(await page.locator('input[type=password]').inputValue(),'');
    body='<form><input name="username" autocomplete="username"><input type="password" disabled><button>Log in</button></form>';await page.reload();page.setDefaultTimeout(100);
    const failure=await submitLogin(page,'ggcb',credentials,()=>{});assert.equal(failure.kind,'FAILED');assert.ok(!JSON.stringify(failure).includes(credentials.password));
    page.setDefaultTimeout(12000);
    body='<form><input name="username" autocomplete="username"><input type="password"><button>Log in</button></form>';await page.goto('https://untrusted.example.invalid/');
    const offsite=await submitLogin(page,'ggcb',credentials,()=>{});assert.equal(offsite.kind,'MANUAL_REQUIRED');assert.equal(await page.locator('input[name=username]').inputValue(),'');assert.equal(await page.locator('input[type=password]').inputValue(),'');
  }finally{await browser.close();}
});
