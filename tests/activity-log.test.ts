import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ActivityLog,diagnoseError,safeLogText} from '../src/activity-log.ts';
function database(){const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE events(id INTEGER PRIMARY KEY,at TEXT NOT NULL,message TEXT NOT NULL)');return db;}
test('activity migration preserves old messages and provides stable filtered history cursors',()=>{
 const db=database();try{db.exec("INSERT INTO events VALUES(1,'2026-10-20T12:00:00Z','Legacy message')");const log=new ActivityLog(db);assert.equal(log.list().items[0].stage,'LEGACY');
 for(let i=0;i<6;i++)log.record('scan '+i,{provider:i%2?'ggcb':'council',level:'ERROR',stage:'CALENDAR',runId:'scan-123',details:{readDays:i,reason:'Calendar failed'}});
 const page=log.list({provider:'ggcb',level:'ERROR',limit:2});assert.equal(page.items.length,2);assert.ok(page.nextCursor);const next=log.list({provider:'ggcb',level:'ERROR',limit:2,before:page.nextCursor!});assert.equal(next.items.length,1);assert.ok(next.items[0].id<page.items[1].id);assert.equal(next.nextCursor,null);assert.throws(()=>log.list({limit:0}));assert.throws(()=>log.list({provider:'unknown'}));
 }finally{db.close();}
});
test('activity files rotate by date, omit secrets, and database survives file failures',()=>{
 const root=mkdtempSync(join(tmpdir(),'pitch-log-')),db=database();try{writeFileSync(join(root,'runtime-2026-10-01.jsonl'),'old');writeFileSync(join(root,'keep.txt'),'keep');const log=new ActivityLog(db,root);
 log.record('password=fixture-secret cookie=fixture-cookie https://example.test/private?q=secret ou_privateid user@example.test /home/ubuntu/private',{provider:'playfootball',level:'WARN',details:{reason:'token=fixture-token',readDays:4,password:'must-not-log',rawError:'must-not-log'}},new Date('2026-10-20T12:00:00Z'));
 const file=readFileSync(join(root,'runtime-2026-10-20.jsonl'),'utf8');for(const secret of ['fixture-secret','fixture-cookie','fixture-token','example.test','ou_privateid','/home/ubuntu','must-not-log'])assert.ok(!file.includes(secret),secret);assert.equal(existsSync(join(root,'runtime-2026-10-01.jsonl')),false);assert.ok(existsSync(join(root,'keep.txt')));assert.equal(log.list().items[0].details.readDays,4);
 const blocked=join(root,'blocked');writeFileSync(blocked,'file');const broken=new ActivityLog(db,blocked);broken.record('Still stored');assert.ok(broken.fileError);assert.equal(broken.list().items[0].message,'Still stored');
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
test('activity retention is bounded and diagnosis never returns raw private error strings',()=>{
 const db=database();try{const log=new ActivityLog(db);db.exec('BEGIN');for(let n=0;n<5002;n++)log.record('check '+n);db.exec('COMMIT');assert.equal((db.prepare('SELECT COUNT(*) AS n FROM events').get() as {n:number}).n,5000);assert.equal(log.list().items[0].message,'check 5001');assert.equal(diagnoseError(new Error('Timeout password=private')).code,'TIMEOUT');assert.ok(!JSON.stringify(diagnoseError(new Error('arbitrary private value'))).includes('arbitrary private value'));assert.ok(!safeLogText('Authorization: Bearer abc-secret').includes('abc-secret'));}finally{db.close();}
});
