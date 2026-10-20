import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {ProviderId} from './domain.ts';

export interface Incident {id:string;provider:ProviderId|'feishu';kind:string;message:string;openedAt:string;lastSeenAt:string;resolvedAt:string|null;}
export class IncidentLog{
  private db:DatabaseSync;
  constructor(db:DatabaseSync){this.db=db;db.exec(`CREATE TABLE IF NOT EXISTS monitor_incidents(id TEXT PRIMARY KEY,provider TEXT NOT NULL,kind TEXT NOT NULL,message TEXT NOT NULL,opened_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,resolved_at TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS incident_active ON monitor_incidents(provider,kind) WHERE resolved_at IS NULL;`);}
  report(provider:ProviderId|'feishu',kind:'TIMEOUT'|'HUMAN_VERIFICATION'|'SCAN_ERROR'|'DELIVERY_ERROR',message:string,now=new Date()){
    const existing=this.db.prepare('SELECT id FROM monitor_incidents WHERE provider=? AND kind=? AND resolved_at IS NULL').get(provider,kind) as {id:string}|undefined;
    if(existing){this.db.prepare('UPDATE monitor_incidents SET last_seen_at=? WHERE id=?').run(now.toISOString(),existing.id);return existing.id;}
    const id=randomUUID();this.db.prepare('INSERT INTO monitor_incidents VALUES(?,?,?,?,?,?,NULL)').run(id,provider,kind,message,now.toISOString(),now.toISOString());return id;
  }
  resolve(provider:ProviderId|'feishu',now=new Date()){this.db.prepare('UPDATE monitor_incidents SET resolved_at=? WHERE provider=? AND resolved_at IS NULL').run(now.toISOString(),provider);}
  list(activeOnly=false):Incident[]{return this.db.prepare(`SELECT id,provider,kind,message,opened_at AS openedAt,last_seen_at AS lastSeenAt,resolved_at AS resolvedAt FROM monitor_incidents ${activeOnly?'WHERE resolved_at IS NULL':''} ORDER BY opened_at DESC LIMIT 100`).all() as unknown as Incident[];}
}
