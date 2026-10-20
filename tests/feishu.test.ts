import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FeishuClient,FeishuError,buildPitchMessage } from '../src/feishu-client.ts';
import { FeishuSettingsRepository,parseFeishuSettings } from '../src/feishu-settings.ts';
import type { FeishuSettings } from '../src/feishu-settings.ts';
import { FeishuIntegration } from '../src/feishu.ts';
import { Store } from '../src/store.ts';
import { resources } from '../src/domain.ts';
import type { Policy,ScanResult } from '../src/domain.ts';

const now=new Date('2026-10-19T11:00:00Z');
const policy:Policy={dateFrom:'2026-10-19',dateTo:'2026-12-16',timezone:'Europe/London',intervalMinutes:15,autoHold:false};
const config:FeishuSettings={appId:'cli_fixture',appSecret:'fixture-secret-never-return',enabled:true,recipients:[
  {name:'用户',type:'open_id',receiveId:'ou_fixture',enabled:true},{name:'球队群',type:'chat_id',receiveId:'oc_fixture',enabled:true}]};
const scan:ScanResult={status:'OK',summary:'fixture',coverage:[],observations:[{resourceId:resources[3].id,date:'2026-11-05',start:'18:00',duration:60,price:'£110.00',availability:'AVAILABLE',note:'fixture'}]};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
function setup(enabled=true){const store=new Store(':memory:');store.savePolicy(policy);store.saveScan(resources[3],scan,now);let stored=structuredClone({...config,enabled});
  const repository={load:async()=>stored,save:async(value:FeishuSettings)=>{stored=structuredClone(value);}};
  return {store,repository};}

test('Feishu accepts only explicit user/chat targets, preserves a saved secret only for the same app, and rejects duplicate recipients',()=>{
  assert.equal(parseFeishuSettings({...config,appSecret:''},config).appSecret,config.appSecret);
  assert.throws(()=>parseFeishuSettings({...config,appId:'cli_other',appSecret:''},config),/密钥/);
  assert.throws(()=>parseFeishuSettings({...config,recipients:[config.recipients[0],config.recipients[0]]}),/重复/);
  assert.throws(()=>parseFeishuSettings({...config,recipients:[{...config.recipients[0],type:'webhook'}]}));
  assert.throws(()=>parseFeishuSettings({...config,recipients:[]}));
});
test('message contains the correct date, weekday, London time, venue, price and clickable official link',()=>{
  const payload={...scan.observations[0],resourceName:'untrusted name',bookingUrl:'https://untrusted.example.invalid'};
  const message=buildPitchMessage(payload);
  assert.match(message.text,/2026-11-05（星期四）/);assert.match(message.text,/18:00–19:00（伦敦当地时间）/);
  assert.match(message.text,/Poplar.*普通7v7/);assert.match(message.text,/£110.00/);
  assert.deepEqual(message.post.zh_cn.content.at(-1),[{tag:'a',text:'点击链接查看',href:resources[3].url}]);
  assert.ok(!message.text.includes('untrusted'));assert.match(buildPitchMessage({...payload,price:null,duration:null}).text,/价格：待核实/);
  assert.throws(()=>buildPitchMessage({...payload,date:'2026-02-31'}));
});
test('credential validation does not send messages and cached tokens are reused for user and chat posts',async()=>{
  const calls:Array<{url:string;body:Record<string,unknown>}>=[];
  const client=new FeishuClient(config,{fetch:async(url,init)=>{calls.push({url,body:JSON.parse(init.body as string)});return url.includes('/auth/')?json({code:0,tenant_access_token:'fixture-token',expire:7200}):json({code:0,data:{message_id:'om_fixture'}});}});
  await client.validate();assert.equal(calls.length,1);assert.ok(calls[0].url.includes('/auth/'));
  await client.sendPost(config.recipients[0],{fixture:'post'},'12345678901234567890123456789012');
  await client.sendPost(config.recipients[1],{fixture:'post'},'22345678901234567890123456789012');
  assert.equal(calls.filter(row=>row.url.includes('/auth/')).length,1);assert.match(calls[1].url,/receive_id_type=open_id/);assert.match(calls[2].url,/receive_id_type=chat_id/);
  assert.equal(calls[1].body.msg_type,'post');assert.equal(typeof calls[1].body.content,'string');
});
test('authentication refresh preserves the message uuid and content; failures never expose arbitrary provider text',async()=>{
  let auth=0;let messages=0;const bodies:unknown[]=[];
  const client=new FeishuClient(config,{fetch:async(url,init)=>{
    if(url.includes('/auth/'))return json({code:0,tenant_access_token:'token-'+(++auth),expire:7200});
    messages++;bodies.push(JSON.parse(init.body as string));return messages===1?json({code:99991663,msg:config.appSecret},401):json({code:0,data:{message_id:'om_ok'}});
  }});
  assert.equal(await client.sendPost(config.recipients[0],{fixture:'body'},'12345678901234567890123456789012'),'om_ok');assert.equal(auth,2);assert.deepEqual(bodies[0],bodies[1]);
  const failing=new FeishuClient(config,{fetch:async url=>url.includes('/auth/')?json({code:0,tenant_access_token:'token',expire:7200}):json({code:230001,msg:config.appSecret},400)});
  await assert.rejects(failing.sendPost(config.recipients[0],{},'12345678901234567890123456789012'),error=>error instanceof FeishuError&&!error.uncertain&&!error.message.includes(config.appSecret));
});
test('an unacknowledged message is classified as uncertain, while a disabled integration performs no network calls',async()=>{
  const client=new FeishuClient(config,{fetch:async url=>{if(url.includes('/auth/'))return json({code:0,tenant_access_token:'token',expire:7200});throw new Error(config.appSecret);}});
  await assert.rejects(client.sendPost(config.recipients[0],{},'12345678901234567890123456789012'),error=>error instanceof FeishuError&&error.uncertain&&!error.message.includes(config.appSecret));
  const {store,repository}=setup(false);let calls=0;const integration=new FeishuIntegration(store,repository,{clock:()=>now,clientFactory:settings=>new FeishuClient(settings,{fetch:async()=>{calls++;throw new Error('not expected');}})});
  try{await integration.restore();await integration.tick();assert.equal(calls,0);assert.equal(store.notifications.list().items[0].attempts,0);
    const state=integration.state();assert.equal(state.hasSecret,true);assert.equal(state.enabled,false);assert.ok(!JSON.stringify(state).includes(config.appSecret));assert.ok(!('appSecret' in state));
  }finally{await integration.close();store.close();}
});
test('per-recipient receipts prevent repeat user sends when a group needs a retry, with stable uuid and frozen quote',async()=>{
  const {store,repository}=setup();let time=now;const messages:Array<{type:string;body:Record<string,unknown>}>=[];let groupAttempts=0;
  const integration=new FeishuIntegration(store,repository,{clock:()=>time,clientFactory:settings=>new FeishuClient(settings,{fetch:async(url,init)=>{
    if(url.includes('/auth/'))return json({code:0,tenant_access_token:'token',expire:7200});const type=new URL(url).searchParams.get('receive_id_type')!;messages.push({type,body:JSON.parse(init.body as string)});
    if(type==='chat_id'&&groupAttempts++===0)return json({code:1,msg:'fixture error'},500);return json({code:0,data:{message_id:'om_'+type}});
  }})});
  try{await integration.restore();await integration.tick();assert.equal(store.notifications.summary().FAILED,1);
    time=new Date(now.getTime()+31000);store.saveScan(resources[3],{...scan,observations:[{...scan.observations[0],price:'£125.00'}]},time);
    await integration.tick();assert.equal(store.notifications.summary().SENT,1);await integration.tick();
    assert.equal(messages.filter(row=>row.type==='open_id').length,1);const group=messages.filter(row=>row.type==='chat_id');assert.equal(group.length,2);assert.deepEqual(group[0].body,group[1].body);
    assert.match(group[1].body.content as string,/£110.00/);assert.equal(store.notifications.list().items[0].payload.price,'£110.00');
    assert.ok(integration.decorate(store.notifications.list().items)[0].deliveries.every(row=>row.status==='SENT'));
  }finally{await integration.close();store.close();}
});
test('an ambiguous delivery beyond the dedupe window is held for human reconciliation instead of blindly resent',async()=>{
  const {store,repository}=setup();let time=now;let calls=0;let fail=true;
  const integration=new FeishuIntegration(store,repository,{clock:()=>time,clientFactory:settings=>new FeishuClient(settings,{fetch:async url=>{
    if(url.includes('/auth/'))return json({code:0,tenant_access_token:'token',expire:7200});calls++;if(fail)throw new Error('fixture timeout');return json({code:0,data:{message_id:'om_ok'}});
  }})});
  try{await integration.restore();await integration.tick();assert.equal(calls,1);
    time=new Date(now.getTime()+56*60000);store.saveScan(resources[3],scan,time);await integration.tick();
    assert.equal(store.notifications.summary().REVIEW_REQUIRED,1);assert.equal(calls,1);
    const item=integration.decorate(store.notifications.list().items)[0];const delivery=item.deliveries[0];
    fail=false;await integration.reconcile({notificationId:item.id,targetKey:delivery.targetKey,decision:'retry'});await integration.tick();
    assert.equal(store.notifications.summary().SENT,1);assert.equal(calls,3);
  }finally{await integration.close();store.close();}
});
test('saving disabled configuration while sending stops remaining recipients without replaying already confirmed deliveries',async()=>{
  const {store,repository}=setup();let time=now;let release!:()=>void;let started!:()=>void;
  const entered=new Promise<void>(resolve=>{started=resolve;});const blocked=new Promise<void>(resolve=>{release=resolve;});const targets:string[]=[];
  const integration=new FeishuIntegration(store,repository,{clock:()=>time,clientFactory:settings=>new FeishuClient(settings,{fetch:async url=>{
    if(url.includes('/auth/'))return json({code:0,tenant_access_token:'token',expire:7200});targets.push(new URL(url).searchParams.get('receive_id_type')!);
    if(targets.length===1){started();await blocked;}return json({code:0,data:{message_id:'om_'+targets.length}});
  }})});
  try{await integration.restore();const job=integration.tick();await entered;await integration.save({...config,enabled:false});release();await job;assert.deepEqual(targets,['open_id']);
    await integration.save(config);time=new Date(now.getTime()+31000);await integration.tick();assert.deepEqual(targets,['open_id','chat_id']);assert.equal(store.notifications.summary().SENT,1);
  }finally{await integration.close();store.close();}
});
test('a human-confirmed delivery is recorded without making another message request',async()=>{
  const {store,repository}=setup();await repository.save({...config,recipients:[config.recipients[0]]});let time=now;let calls=0;
  const integration=new FeishuIntegration(store,repository,{clock:()=>time,clientFactory:settings=>new FeishuClient(settings,{fetch:async url=>{if(url.includes('/auth/'))return json({code:0,tenant_access_token:'token',expire:7200});calls++;throw new Error('fixture timeout');}})});
  try{await integration.restore();await integration.tick();time=new Date(now.getTime()+56*60000);store.saveScan(resources[3],scan,time);await integration.tick();
    const item=integration.decorate(store.notifications.list().items)[0];await integration.reconcile({notificationId:item.id,targetKey:item.deliveries[0].targetKey,decision:'delivered'});
    assert.equal(store.notifications.summary().SENT,1);assert.equal(integration.state().error,null);await integration.tick();assert.equal(calls,1);
  }finally{await integration.close();store.close();}
});
test('Feishu settings are encrypted at rest and restore the disabled recipients without exposing secret plaintext',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pitch-feishu-'));const repository=new FeishuSettingsRepository(dir);
  try{await repository.save({...config,enabled:false});assert.ok(!readFileSync(repository.path,'utf8').includes(config.appSecret));
    assert.deepEqual(await repository.load(),{...config,enabled:false});
  }finally{rmSync(dir,{recursive:true,force:true});}
});


test('manual delivery with automation disabled sends only the selected record and retains dedupe across repeats',async()=>{
  const {store,repository}=setup(false);store.saveScan(resources[0],{...scan,observations:[{...scan.observations[0],resourceId:resources[0].id,duration:55}]},now);
  const calls:string[]=[];const integration=new FeishuIntegration(store,repository,{clock:()=>now,clientFactory:settings=>new FeishuClient(settings,{fetch:async url=>{
    if(url.includes('/auth/'))return json({code:0,tenant_access_token:'token',expire:7200});calls.push(url);return json({code:0,data:{message_id:'om_'+calls.length}});
  }})});
  try{await integration.restore();const item=store.notifications.list().items.find(row=>row.payload.resourceId===resources[3].id)!;
    assert.equal((await integration.sendManual({notificationId:item.id})).sent,1);assert.equal(calls.length,2);
    assert.equal(store.notifications.summary().PENDING,1);assert.equal(store.notifications.summary().SENT,1);assert.equal(integration.state().enabled,false);
    await assert.rejects(integration.sendManual({notificationId:item.id}),/已处理/);await assert.rejects(integration.sendManual({notificationId:'missing'}),/已处理/);
    await integration.tick();assert.equal(calls.length,2);
  }finally{await integration.close();store.close();}
});

test('manual retries bypass the automatic delay but skip confirmed recipients and reject concurrent senders',async()=>{
  const {store,repository}=setup(false);const targets:string[]=[];let groupCalls=0;let release!:()=>void;let entered!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{entered=resolve;});
  const integration=new FeishuIntegration(store,repository,{clock:()=>now,clientFactory:settings=>new FeishuClient(settings,{fetch:async url=>{
    if(url.includes('/auth/'))return json({code:0,tenant_access_token:'token',expire:7200});const type=new URL(url).searchParams.get('receive_id_type')!;targets.push(type);
    if(type==='chat_id'&&groupCalls++===0)return json({code:230001},400);
    if(type==='chat_id'){entered();await blocked;}return json({code:0,data:{message_id:'om_'+type}});
  }})});
  try{await integration.restore();const id=store.notifications.list().items[0].id;
    assert.equal((await integration.sendManual({notificationId:id})).failed,1);assert.equal(store.notifications.summary().FAILED,1);
    const retry=integration.sendManual({notificationId:id});await started;
    await assert.rejects(integration.sendManual({notificationId:id}),/正在处理/);await integration.tick();release();
    assert.equal((await retry).sent,1);assert.deepEqual(targets,['open_id','chat_id','chat_id']);assert.equal(integration.state().enabled,false);
  }finally{release?.();await integration.close();store.close();}
});

test('manual delivery refuses stale, withdrawn, expired and review-required records without making network requests',async()=>{
  for(const reason of ['stale','withdrawn','expired','review']){
    const {store,repository}=setup(false);let time=now;let calls=0;
    const integration=new FeishuIntegration(store,repository,{clock:()=>time,clientFactory:settings=>new FeishuClient(settings,{fetch:async()=>{calls++;throw new Error('unexpected');}})});
    try{await integration.restore();const id=store.notifications.list().items[0].id;
      if(reason==='stale')time=new Date(now.getTime()+31*60000);
      if(reason==='withdrawn')store.saveScan(resources[3],{...scan,observations:[{...scan.observations[0],availability:'UNAVAILABLE'}]},new Date(now.getTime()+1000));
      if(reason==='expired')time=new Date('2026-11-06T11:00:00Z');
      if(reason==='review')store.db.prepare("UPDATE notifications SET status='REVIEW_REQUIRED' WHERE id=?").run(id);
      await assert.rejects(integration.sendManual({notificationId:id}),/已处理/);assert.equal(calls,0);
    }finally{await integration.close();store.close();}
  }
});


test('cross-app Open ID rejection names the actual configuration problem without exposing provider response text',async()=>{
  let calls=0;const client=new FeishuClient(config,{fetch:async url=>{
    if(url.includes('/auth/'))return json({code:0,tenant_access_token:'fixture-token',expire:7200});
    calls++;return json({code:99992361,msg:'open_id cross app '+config.appSecret},400);
  }});
  await assert.rejects(client.sendPost(config.recipients[0],{fixture:'post'},'12345678901234567890123456789012'),error=>{
    assert.ok(error instanceof FeishuError);assert.equal(error.code,99992361);assert.equal(error.status,400);assert.equal(error.uncertain,false);
    assert.match(error.message,/Open ID.*不属于当前应用/);assert.match(error.message,/重新获取/);assert.ok(!error.message.includes(config.appSecret));return true;
  });assert.equal(calls,1);
});


test('historical recipient failures remain visible but cannot masquerade as a fresh credential or recipient check',async()=>{
  const {store,repository}=setup(false);let calls=0;
  const integration=new FeishuIntegration(store,repository,{clock:()=>now,clientFactory:settings=>new FeishuClient(settings,{fetch:async url=>{
    if(url.includes('/auth/'))return json({code:0,tenant_access_token:'fixture-token',expire:7200});calls++;return json({code:99992361,msg:config.appSecret},400);
  }})});
  try{await integration.restore();await integration.sendManual({notificationId:store.notifications.list().items[0].id});
    // Old persisted diagnostics must be readable after an upgrade, too.
    store.db.prepare("UPDATE feishu_deliveries SET last_error='飞书请求未成功（HTTP 400，错误码 99992361），请检查应用权限与收件人可见范围'").run();
    const item=integration.decorate(store.notifications.list().items)[0];assert.match(item.lastError!,/Open ID.*不属于当前应用/);
    const validation=await integration.validate();assert.equal(validation.credentialsValid,true);assert.equal(validation.recipientDeliveryVerified,false);assert.match(validation.warning!,/历史/);assert.equal(integration.state().validatedAt,now.toISOString());assert.equal(calls,1);
    await integration.save({...config,enabled:false,recipients:[{...config.recipients[0],receiveId:'ou_corrected'}]});
    const corrected=await integration.validate();assert.equal(corrected.warning,null);assert.equal(integration.state().validatedAt,now.toISOString());assert.equal(calls,1);
  }finally{await integration.close();store.close();}
});
