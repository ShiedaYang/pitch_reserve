import test from 'node:test';
import assert from 'node:assert/strict';
import { initialPolicy, lookaheadEnd, resolvePolicy } from '../src/domain.ts';
import { Store } from '../src/store.ts';
import { Monitor } from '../src/monitor.ts';

test('lookahead uses calendar months, clamps month end and crosses years',()=>{
  assert.equal(lookaheadEnd('2027-01-31','1m'),'2027-02-28');
  assert.equal(lookaheadEnd('2028-01-31','1m'),'2028-02-29');
  assert.equal(lookaheadEnd('2026-11-30','3m'),'2027-02-28');
  assert.equal(lookaheadEnd('2026-05-31','2m'),'2026-07-31');
  assert.equal(lookaheadEnd('2026-12-28','7d'),'2027-01-04');
  assert.equal(lookaheadEnd('2026-12-28','14d'),'2027-01-11');
});
test('default and resolved ranges roll at London midnight including DST',()=>{
  const policy=initialPolicy(new Date('2026-10-20T22:59:00Z'));
  assert.equal(policy.lookahead,'2m');assert.equal(policy.dateFrom,'2026-10-21');assert.equal(policy.dateTo,'2026-12-21');
  const rolled=resolvePolicy(policy,new Date('2026-10-20T23:01:00Z'));
  assert.equal(rolled.dateFrom,'2026-10-22');assert.equal(rolled.dateTo,'2026-12-22');
  assert.equal(initialPolicy(new Date('2026-12-31T23:01:00Z')).dateFrom,'2027-01-01');
  assert.equal(initialPolicy(new Date('2027-01-01T00:01:00Z')).dateFrom,'2027-01-02');
});
test('legacy frozen preferences migrate to rolling two months and keep interval',()=>{
  const store=new Store(':memory:');try{
    store.db.prepare('INSERT OR REPLACE INTO config VALUES (?,?)').run('policy',JSON.stringify({dateFrom:'2020-01-01',dateTo:'2020-03-01',intervalMinutes:30,timezone:'Europe/London',autoHold:false}));
    const now=new Date('2026-10-20T12:00:00Z');const policy=store.policy(now);
    assert.equal(policy.lookahead,'2m');assert.equal(policy.dateFrom,'2026-10-21');assert.equal(policy.dateTo,'2026-12-21');assert.equal(policy.intervalMinutes,30);
    store.savePolicy({...policy,lookahead:'14d'},now);
    const next=store.policy(new Date('2026-10-21T12:00:00Z'));
    assert.equal(next.dateFrom,'2026-10-22');assert.equal(next.dateTo,'2026-11-05');assert.equal(next.lookahead,'14d');assert.equal(next.autoHold,false);
  }finally{store.close();}
});
test('midnight rolling schedules automatic providers immediately and preserves explicit pause',async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-20T22:59:00Z')});
  const store=new Store(':memory:');const monitor=new Monitor(store,'.local/test-unused');
  try{
    store.savePolicy(initialPolicy());const calls:string[]=[];
    monitor.scan=async id=>{calls.push(id);monitor.sessions.get(id)!.nextScanAt=Date.now()+3600000;};
    for(const s of monitor.sessions.values()){s.mode='PAUSED';s.nextScanAt=Date.now()+3600000;}
    monitor.sessions.get('ggcb')!.mode='AUTOMATION';
    await monitor.tick();assert.deepEqual(calls,[]);
    t.mock.timers.tick(120000);await monitor.tick();assert.deepEqual(calls,['ggcb']);
    assert.equal(monitor.state().policy.dateFrom,'2026-10-22');assert.equal(monitor.state().today,'2026-10-21');
    assert.equal(monitor.sessions.get('council')!.mode,'PAUSED');await monitor.tick();assert.deepEqual(calls,['ggcb']);
  }finally{await monitor.close();store.close();}
});
