import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { initialPolicy, normalizeScanResult, resolvePolicy, resources } from './domain.ts';
import type { Policy, Resource, ScanResult } from './domain.ts';
import {parseCouncilDefaults} from './council-defaults.ts';
import { NotificationQueue } from './notifications.ts';
import {IncidentLog} from './incidents.ts';

export class Store {
  db: DatabaseSync;
  notifications: NotificationQueue;
  incidents:IncidentLog;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true }); this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scans (id INTEGER PRIMARY KEY, resource TEXT NOT NULL, at TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at TEXT NOT NULL, message TEXT NOT NULL);`);
    this.notifications=new NotificationQueue(this.db);
    this.incidents=new IncidentLog(this.db);
    // Seed the existing latest inventory once as well: upgrading must not omit already observed availability.
    this.db.exec('BEGIN IMMEDIATE');
    try{for(const resource of resources){const latest=this.latest(resource.id);if(latest)this.notifications.observe(resource,latest.result,this.policy(),latest.at);}this.db.exec('COMMIT');}
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  policy(now = new Date()): Policy {
    const row = this.db.prepare('SELECT value FROM config WHERE key=?').get('policy') as { value: string } | undefined;
    if (!row) return this.savePolicy(initialPolicy(now), now);
    const stored: Policy = JSON.parse(row.value);
    // Upgrade the old frozen date range once, preserving the monitoring interval.
    if (!Object.hasOwn(stored, 'lookahead')) return this.savePolicy({ ...stored, lookahead: '2m' }, now);
    return resolvePolicy(stored, now);
  }
  savePolicy(policy: Policy, now = new Date()): Policy {
    const safe = resolvePolicy({ ...policy, lookahead: policy.lookahead ?? null, autoHold: false }, now);
    this.db.prepare('INSERT OR REPLACE INTO config VALUES (?,?)').run('policy', JSON.stringify(safe)); return safe;
  }
  councilDefaults() {const row=this.db.prepare('SELECT value FROM config WHERE key=?').get('council-defaults') as {value:string}|undefined;return row?parseCouncilDefaults(JSON.parse(row.value)):null;}
  saveCouncilDefaults(input:unknown){const defaults=parseCouncilDefaults(input);this.db.prepare('INSERT OR REPLACE INTO config VALUES (?,?)').run('council-defaults',JSON.stringify(defaults));return defaults;}
  saveScan(resource: Resource, result: ScanResult, now=new Date()) {
    const normalized=normalizeScanResult(result);this.db.exec('BEGIN IMMEDIATE');
    try{
      this.db.prepare('INSERT INTO scans (resource,at,result) VALUES (?,?,?)').run(resource.id,now.toISOString(),JSON.stringify(normalized));
      this.notifications.observe(resource,normalized,this.policy(),now.toISOString(),now);
      this.db.exec('DELETE FROM scans WHERE id NOT IN (SELECT id FROM scans ORDER BY id DESC LIMIT 400)');
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  latest(resourceId: string): { at: string; result: ScanResult } | null {
    const row = this.db.prepare('SELECT at,result FROM scans WHERE resource=? ORDER BY id DESC LIMIT 1').get(resourceId) as { at: string; result: string } | undefined;
    return row ? { at: row.at, result: normalizeScanResult(JSON.parse(row.result)) } : null;
  }
  event(message: string) {
    this.db.prepare('INSERT INTO events (at,message) VALUES (?,?)').run(new Date().toISOString(), message);
    this.db.exec('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 100)');
  }
  events() { return this.db.prepare('SELECT at,message FROM events ORDER BY id DESC LIMIT 20').all(); }
  close() { this.db.close(); }
}
