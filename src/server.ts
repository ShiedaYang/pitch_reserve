import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { Store } from './store.ts';
import { Monitor } from './monitor.ts';
import { providerIds } from './domain.ts';
import type { ProviderId } from './domain.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const local = join(root, '.local'); mkdirSync(local, { recursive: true });
const store = new Store(join(local, 'monitor.sqlite')); const monitor = new Monitor(store, local);
const port = Number(process.env.PORT || 4318); const origin = `http://127.0.0.1:${port}`;
const token = randomBytes(32).toString('hex');
function validToken(input: unknown) { return typeof input === 'string' && input.length === token.length && timingSafeEqual(Buffer.from(input), Buffer.from(token)); }
const staticFiles: Record<string, [string, string]> = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const json = (code: number, data: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') { json(403, { error: '仅接受本地控制台请求' }); return; }
  try {
    const url = new URL(req.url || '/', origin);
    if (req.method === 'GET' && staticFiles[url.pathname]) {
      const [file, type] = staticFiles[url.pathname]; res.writeHead(200, { 'Content-Type': type }); res.end(readFileSync(join(root, 'public', file))); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') { json(200, { ...monitor.state(), csrf: token }); return; }
    if (req.method !== 'POST') { json(404, { error: '接口不存在' }); return; }
    if (!validToken(req.headers['x-console-token']) || req.headers['content-type'] !== 'application/json') { json(403, { error: '请刷新控制台后再操作' }); return; }
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 4096) { json(413, { error: '请求过大' }); return; } }
    const body = JSON.parse(raw || '{}');
    const inspectMatch = url.pathname.match(/^\/api\/providers\/(ggcb|council|playfootball)\/inspect$/);
    if (inspectMatch) { json(200, await monitor.sessions.get(inspectMatch[1] as ProviderId)!.inspect()); return; }
    if (url.pathname === '/api/shutdown') { json(200, { ok: true }); void shutdown(); return; }
    if (url.pathname === '/api/policy') {
      const { dateFrom, dateTo, intervalMinutes } = body;
      const validDate = (d: unknown): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T12:00:00Z`)) && new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) === d;
      if (!validDate(dateFrom) || !validDate(dateTo) || dateFrom > dateTo || (Date.parse(dateTo) - Date.parse(dateFrom)) > 93 * 86400000 || !Number.isInteger(intervalMinutes) || intervalMinutes < 10 || intervalMinutes > 120 || ('autoHold' in body && body.autoHold !== false)) { json(400, { error: '请输入有效日期（最多93天）及10–120分钟检查间隔；当前只支持只读监测' }); return; }
      store.savePolicy({ dateFrom, dateTo, intervalMinutes, timezone: 'Europe/London', autoHold: false });
      store.event('已更新监测范围与检查间隔'); json(200, { ok: true }); return;
    }
    const match = url.pathname.match(/^\/api\/providers\/([^/]+)\/(login|open|check|resume|pause|scan)$/);
    if (match && providerIds.includes(match[1] as ProviderId)) { await monitor.action(match[1] as ProviderId, match[2], body.resourceId); json(200, { ok: true }); return; }
    json(404, { error: '接口不存在；自动锁位未实现' });
  } catch (error) {
    const message = error instanceof Error && /请|该网站|场馆|不支持|已暂停|页面仍/.test(error.message) ? error.message : '操作失败，请检查浏览器是否可打开，或稍后重试';
    json(400, { error: message });
  }
});
server.listen(port, '127.0.0.1', () => {
  writeFileSync(join(local, 'server.json'), JSON.stringify({ pid: process.pid, url: origin }));
  store.event('控制台启动：只读监测，自动锁位关闭'); console.log(`Pitch console: ${origin}`);
  if (process.env.PITCH_START_PAUSED === '1') for (const s of monitor.sessions.values()) s.mode = 'PAUSED';
  monitor.start();
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
async function shutdown() { server.close(); await monitor.close(); store.close(); process.exit(0); }
process.on('SIGINT', () => { void shutdown(); }); process.on('SIGTERM', () => { void shutdown(); });
