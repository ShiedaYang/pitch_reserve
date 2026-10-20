import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { dispatchNotifications } from '../src/notifications.ts';
import { resources, targetDates } from '../src/domain.ts';
import type { Availability, Policy, ScanResult } from '../src/domain.ts';

const policy:Policy={dateFrom:'2026-10-19',dateTo:'2026-12-16',timezone:'Europe/London',intervalMinutes:15,autoHold:false};
const now=new Date('2026-10-19T11:00:00Z');
const later=(seconds:number)=>new Date(now.getTime()+seconds*1000);
const scan=(availability:Availability='AVAILABLE',price:string|null='£110.00',date='2026-11-05',resource=resources[3]):ScanResult=>({
  status:'OK',summary:'fixture',coverage:[{date,status:'READ',note:'fixture'}],observations:[{resourceId:resource.id,date,start:'18:00',duration:60,
  availability,price,note:'fixture',bookingUrl:'https://untrusted.example.invalid/checkout'}]});
function setup(){const store=new Store(':memory:');store.savePolicy(policy);return store;}

test('available observations enqueue once, update unsent prices, and use the fixed official URL',()=>{
  const store=setup();try{
    store.saveScan(resources[3],scan(),now);const first=store.notifications.list().items[0];
    store.saveScan(resources[3],scan('AVAILABLE',null),later(10));
    const items=store.notifications.list().items;assert.equal(items.length,1);assert.equal(items[0].id,first.id);
    assert.equal(items[0].payload.price,null);assert.equal(items[0].payload.bookingUrl,resources[3].url);
    assert.equal(items[0].status,'PENDING');assert.equal(items[0].attempts,0);assert.equal(items[0].sentAt,null);
  }finally{store.close();}
});
test('errors, unknowns and missing rows preserve the episode; explicit disappearance then reappearance creates a new one',()=>{
  const store=setup();try{
    store.saveScan(resources[3],scan('BOOKED'),now);store.saveScan(resources[3],scan(),later(1));
    assert.equal(store.notifications.list().items[0].occurrence,1);
    store.saveScan(resources[3],scan('UNKNOWN'),later(2));
    store.saveScan(resources[3],{status:'ERROR',summary:'fixture',observations:[],coverage:[]},later(3));
    store.saveScan(resources[3],scan(),later(4));assert.equal(store.notifications.list().items.length,1);
    store.saveScan(resources[3],scan('UNAVAILABLE'),later(5));assert.equal(store.notifications.list().items[0].status,'CANCELLED');
    store.saveScan(resources[3],scan(),later(6));const items=store.notifications.list().items;
    assert.equal(items.length,2);assert.equal(items[0].occurrence,2);assert.equal(items[0].status,'PENDING');assert.equal(items[1].status,'CANCELLED');
  }finally{store.close();}
});
test('scan and outbox persistence are atomic when notification insertion fails',()=>{
  const store=setup();try{
    store.db.exec("CREATE TRIGGER reject_fixture BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    assert.throws(()=>store.saveScan(resources[3],scan(),now),/fixture failure/);
    assert.equal(store.latest(resources[3].id),null);assert.equal(store.notifications.list().items.length,0);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM notification_slots').get() as {count:number}).count,0);
    store.db.exec('DROP TRIGGER reject_fixture');store.saveScan(resources[3],scan(),later(1));
    assert.equal(store.notifications.list().items.length,1);
  }finally{store.close();}
});
test('outbox and dedupe survive process-style restart and scan-history pruning',()=>{
  const dir=mkdtempSync(join(tmpdir(),'pitch-notification-'));const path=join(dir,'test.sqlite');let store=new Store(path);
  try{
    store.savePolicy(policy);store.saveScan(resources[3],scan(),now);const id=store.notifications.list().items[0].id;store.close();
    store=new Store(path);assert.equal(store.notifications.list().items[0].id,id);assert.equal(store.notifications.list().items.length,1);
    store.db.exec('DELETE FROM scans');store.saveScan(resources[3],scan(),later(5));
    assert.equal(store.notifications.list().items.length,1);assert.equal(store.notifications.list().items[0].id,id);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('leases prevent simultaneous claims, recover after crashes and reject late acknowledgements',()=>{
  const store=setup();try{
    store.saveScan(resources[3],scan(),now);const first=store.notifications.claim(policy,now,1000)!;
    assert.ok(first);assert.equal(store.notifications.claim(policy,later(.5)),null);
    const second=store.notifications.claim(policy,later(2))!;assert.equal(second.notification.id,first.notification.id);
    assert.equal(second.notification.attempts,2);assert.notEqual(second.leaseToken,first.leaseToken);
    assert.equal(store.notifications.complete(first.notification.id,first.leaseToken,'late',later(2)),false);
    assert.equal(store.notifications.complete(second.notification.id,second.leaseToken,'receipt',later(2)),true);
    assert.equal(store.notifications.claim(policy,later(3)),null);
    store.saveScan(resources[3],scan('AVAILABLE','£125.00'),later(4));
    assert.equal(store.notifications.list().items[0].payload.price,'£110.00');
    store.saveScan(resources[3],scan('BOOKED'),later(5));store.saveScan(resources[3],scan(),later(6));
    assert.equal(store.notifications.summary().SENT,1);assert.equal(store.notifications.summary().PENDING,1);
  }finally{store.close();}
});
test('the sender seam retries using the same idempotency key and stores no arbitrary channel error',async()=>{
  const store=setup();try{
    store.saveScan(resources[3],scan(),now);const keys:string[]=[];
    assert.deepEqual(await dispatchNotifications(store.notifications,policy,{send:async(_item,context)=>{keys.push(context.idempotencyKey);throw new Error('fixture-secret-token');}},{now:()=>now}),{sent:0,failed:1});
    assert.equal(store.notifications.summary().FAILED,1);assert.ok(!JSON.stringify(store.notifications.list()).includes('fixture-secret-token'));
    assert.equal(store.notifications.claim(policy,later(1)),null);
    assert.deepEqual(await dispatchNotifications(store.notifications,policy,{send:async(_item,context)=>{keys.push(context.idempotencyKey);return {receiptId:'fixture-receipt'};}},{now:()=>later(31)}),{sent:1,failed:0});
    assert.equal(keys[0],keys[1]);assert.equal(store.notifications.summary().SENT,1);assert.equal(store.notifications.list().items[0].attempts,2);
  }finally{store.close();}
});
test('unconfirmed old inventory waits for a fresh scan; expired, withdrawn and out-of-range items cannot be delivered',()=>{
  const store=setup();try{
    store.saveScan(resources[3],scan(),now);assert.equal(store.notifications.claim(policy,later(3600)),null);
    store.saveScan(resources[3],scan(),later(3601));assert.ok(store.notifications.claim(policy,later(3602)));
    store.notifications.expire({...policy,dateTo:'2026-10-22'},later(3603));assert.equal(store.notifications.summary().CANCELLED,1);
    store.saveScan(resources[2],scan('AVAILABLE','£90','2026-10-22',resources[2]),later(1));
    store.notifications.expire(policy,new Date('2026-10-22T17:00:00Z'));assert.equal(store.notifications.summary().EXPIRED,1);
    assert.equal(store.notifications.claim(policy,new Date('2026-10-22T17:00:01Z')),null);
  }finally{store.close();}
});
test('only target weekdays, time, date range and resource identity enter the outbox',()=>{
  const store=setup();try{
    const result=scan();result.observations=[
      {...result.observations[0],start:'18:30'}, {...result.observations[0],date:'2026-11-07'},
      {...result.observations[0],date:'2027-01-04'}, {...result.observations[0],resourceId:'other-resource'}];
    store.saveScan(resources[3],result,now);assert.equal(store.notifications.list().items.length,0);
  }finally{store.close();}
});
test('temporarily shrinking and restoring the policy does not create duplicate availability notifications',()=>{
  const store=setup();try{
    store.saveScan(resources[3],scan(),now);const first=store.notifications.list().items[0];
    const shortPolicy={...policy,dateTo:'2026-10-22'};
    store.savePolicy(shortPolicy);store.notifications.expire(shortPolicy,later(1));
    assert.equal(store.notifications.list().items[0].status,'CANCELLED');
    store.savePolicy(policy);store.saveScan(resources[3],scan(),later(2));
    assert.equal(store.notifications.list().items.length,1);assert.equal(store.notifications.list().items[0].id,first.id);
    assert.equal(store.notifications.list().items[0].status,'PENDING');
    const job=store.notifications.claim(policy,later(3))!;assert.equal(store.notifications.complete(job.notification.id,job.leaseToken,'fixture',later(3)),true);
    store.savePolicy(shortPolicy);store.notifications.expire(shortPolicy,later(4));
    store.savePolicy(policy);store.saveScan(resources[3],scan(),later(5));
    assert.equal(store.notifications.list().items.length,1);assert.equal(store.notifications.list().items[0].status,'SENT');
    assert.equal(store.notifications.claim(policy,later(6)),null);
  }finally{store.close();}
});
test('legacy nearby-only observations are read as unavailable without retaining an alternative quote',()=>{
  const store=setup();try{
    const legacy=JSON.parse(JSON.stringify(scan()));legacy.observations[0].availability='NEARBY';
    store.db.prepare('INSERT INTO scans(resource,at,result) VALUES(?,?,?)').run(resources[3].id,now.toISOString(),JSON.stringify(legacy));
    const item=store.latest(resources[3].id)!.result.observations[0];
    assert.equal(item.availability,'UNAVAILABLE');assert.equal(item.price,null);assert.equal(item.duration,null);
  }finally{store.close();}
});
test('notification pagination covers the complete retained history without gaps or repeated IDs',()=>{
  const store=setup();try{
    const dates=targetDates(policy,'2026-10-19',now);
    for(const resource of resources.slice(0,2))store.saveScan(resource,{status:'OK',summary:'fixture',coverage:[],observations:dates.map(date=>scan('AVAILABLE',null,date,resource).observations[0])},now);
    const ids:string[]=[];let before:number|undefined;
    do{const page=store.notifications.list({limit:10,before});ids.push(...page.items.map(item=>item.id));before=page.nextCursor??undefined;}while(before);
    assert.equal(ids.length,dates.length*2);assert.equal(new Set(ids).size,ids.length);
    assert.throws(()=>store.notifications.list({limit:101}));assert.throws(()=>store.notifications.list({before:NaN}));
  }finally{store.close();}
});
