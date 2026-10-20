import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.ts';
import {FeishuIntegration} from '../src/feishu.ts';
import {FeishuClient} from '../src/feishu-client.ts';
import {parseFeishuSettings} from '../src/feishu-settings.ts';
import type {FeishuSettings} from '../src/feishu-settings.ts';
import {resources} from '../src/domain.ts';

const settings:FeishuSettings={appId:'cli_fixture',appSecret:'fixture-secret',enabled:false,recipients:[{name:'球员',type:'open_id',receiveId:'ou_player',enabled:true}],adminEnabled:true,adminRecipients:[{name:'管理员',type:'chat_id',receiveId:'oc_admin',enabled:true}]};
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
test('administrator settings validate independently and incidents dedupe until recovery',()=>{
  assert.throws(()=>parseFeishuSettings({...settings,adminRecipients:[]}),/管理员/);assert.throws(()=>parseFeishuSettings({...settings,adminRecipients:[{...settings.adminRecipients![0],receiveId:'ou_wrong'}]}));
  const store=new Store(':memory:');try{const id=store.incidents.report('playfootball','HUMAN_VERIFICATION','请手动验证');assert.equal(store.incidents.report('playfootball','HUMAN_VERIFICATION','请手动验证'),id);store.incidents.resolve('playfootball');assert.notEqual(store.incidents.report('playfootball','HUMAN_VERIFICATION','请手动验证'),id);assert.equal(store.incidents.list().length,2);}finally{store.close();}
});
test('administrator messages send independently, retain dedupe across restoration, and notify again only after recovery',async()=>{
  const store=new Store(':memory:');const sent:any[]=[];const repo={load:async()=>structuredClone(settings),save:async()=>{}};
  const factory=()=>new FeishuClient(settings,{fetch:async(url,init)=>{if(url.includes('/auth/'))return response({code:0,tenant_access_token:'fixture',expire:7200});sent.push(JSON.parse(String(init.body)));return response({code:0,data:{message_id:'om_'+sent.length}});}});
  const first=new FeishuIntegration(store,repo,{clientFactory:factory});
  try{await first.restore();store.incidents.report('playfootball','TIMEOUT','重新打开后仍超时，请手动接管');await first.tick();await first.tick();assert.equal(sent.length,1);assert.equal(sent[0].receive_id,'oc_admin');assert.match(sent[0].content,/PlayFootball/);assert.ok(!sent[0].content.includes(settings.appSecret));await first.close();
    const restored=new FeishuIntegration(store,repo,{clientFactory:factory});await restored.restore();await restored.tick();assert.equal(sent.length,1);store.incidents.resolve('playfootball');store.incidents.report('playfootball','TIMEOUT','重新打开后仍超时，请手动接管');await restored.tick();assert.equal(sent.length,2);await restored.close();
  }finally{await first.close();store.close();}
});
test('manual resend creates separate receipts, preserves the original sent item, and dedupes a repeated request',async()=>{
  const store=new Store(':memory:');const sent:any[]=[];const now=new Date('2026-10-20T11:00:00Z');const config={...settings,adminEnabled:false};const integration=new FeishuIntegration(store,{load:async()=>config,save:async()=>{}},{clock:()=>now,clientFactory:()=>new FeishuClient(config,{fetch:async(url,init)=>{if(url.includes('/auth/'))return response({code:0,tenant_access_token:'fixture',expire:7200});sent.push(JSON.parse(String(init.body)));return response({code:0,data:{message_id:'om_'+sent.length}});}})});
  try{store.savePolicy({dateFrom:'2026-10-20',dateTo:'2026-12-19',intervalMinutes:15,timezone:'Europe/London',autoHold:false});store.saveScan(resources[3],{status:'OK',summary:'fixture',coverage:[],observations:[{resourceId:resources[3].id,date:'2026-11-05',start:'18:00',duration:60,price:'£110',availability:'AVAILABLE',note:'fixture'}]},now);await integration.restore();const item=store.notifications.list().items[0];await integration.sendManual({notificationId:item.id});const original=store.notifications.list().items[0];const requestId=randomUUID();await integration.sendManual({notificationId:item.id,resend:true,requestId});await integration.sendManual({notificationId:item.id,resend:true,requestId});assert.equal(sent.length,2);assert.notEqual(sent[0].uuid,sent[1].uuid);assert.match(sent[1].content,/历史观察/);assert.deepEqual(store.notifications.list().items[0],original);assert.equal(integration.decorate([original])[0].resends.length,1);await integration.sendManual({notificationId:item.id,resend:true,requestId:randomUUID()});assert.equal(sent.length,3);
  }finally{await integration.close();store.close();}
});

test('an old ambiguous resend waits for explicit reconciliation while preserving its original receipt',async()=>{
  const store=new Store(':memory:');let now=new Date('2026-10-20T11:00:00Z');let failResend=false;const posts:any[]=[];
  const config={...settings,adminEnabled:false};const integration=new FeishuIntegration(store,{load:async()=>config,save:async()=>{}},{clock:()=>now,clientFactory:()=>new FeishuClient(config,{fetch:async(url,init)=>{if(url.includes('/auth/'))return response({code:0,tenant_access_token:'fixture',expire:7200});posts.push(JSON.parse(String(init.body)));if(failResend)throw new Error('fixture disconnected after request');return response({code:0,data:{message_id:'om_'+posts.length}});}})});
  try{store.savePolicy({dateFrom:'2026-10-20',dateTo:'2026-12-19',intervalMinutes:15,timezone:'Europe/London',autoHold:false});store.saveScan(resources[3],{status:'OK',summary:'fixture',coverage:[],observations:[{resourceId:resources[3].id,date:'2026-11-05',start:'18:00',duration:60,price:'£110',availability:'AVAILABLE',note:'fixture'}]},now);await integration.restore();const item=store.notifications.list().items[0];await integration.sendManual({notificationId:item.id});failResend=true;const requestId=randomUUID();assert.equal((await integration.sendManual({notificationId:item.id,resend:true,requestId})).failed,1);assert.equal(store.incidents.list(true)[0].provider,'feishu');now=new Date(now.getTime()+56*60000);await integration.sendManual({notificationId:item.id,resend:true,requestId});assert.equal(posts.length,2);const resend=integration.decorate([item])[0].resends[0] as any;assert.equal(resend.status,'REVIEW_REQUIRED');assert.equal(store.notifications.list().items[0].status,'SENT');await assert.rejects(integration.sendManual({notificationId:item.id,resend:true,requestId:randomUUID()}),/核对/);await integration.reconcile({notificationId:resend.id,targetKey:resend.deliveries[0].targetKey,decision:'retry'});failResend=false;await integration.sendManual({notificationId:item.id,resend:true,requestId});assert.equal(posts.length,3);assert.equal(posts[1].uuid,posts[2].uuid);assert.equal(integration.decorate([item])[0].resends.length,1);
  }finally{await integration.close();store.close();}
});
