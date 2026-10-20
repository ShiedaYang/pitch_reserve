import { createServer } from 'node:http';
import {networkAccess} from './network-access.ts';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname,resolve } from 'node:path';
import { Store } from './store.ts';
import { Monitor } from './monitor.ts';
import { initialPolicy, lookaheads, providerIds } from './domain.ts';
import type { Lookahead, ProviderId } from './domain.ts';
import type { NotificationStatus } from './notifications.ts';
import { FeishuIntegration } from './feishu.ts';
import { FeishuSettingsRepository } from './feishu-settings.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const local = resolve(process.env.PITCH_DATA_DIR||join(root, '.local')); mkdirSync(local, { recursive: true,mode:0o700 });
const store = new Store(join(local, 'monitor.sqlite')); const monitor = new Monitor(store, local,true);
await monitor.restoreCredentials();
const feishu=new FeishuIntegration(store,new FeishuSettingsRepository(local));await feishu.restore();
function consoleState(){const state=monitor.state();return {...state,feishu:feishu.state(),notifications:{...state.notifications,items:feishu.decorate(state.notifications.items),deliveryConfigured:feishu.state().configured}};}
const network=networkAccess();const {port,origin}=network;
const allowedHosts=network.hosts,allowedOrigins=network.origins;
const token = randomBytes(32).toString('hex');
function validToken(input: unknown) { return typeof input === 'string' && input.length === token.length && timingSafeEqual(Buffer.from(input), Buffer.from(token)); }
const staticFiles: Record<string, [string, string]> = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const json = (code: number, data: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  if (!network.allows(req.socket.remoteAddress)) { json(403, {error:'????????????????'}); return; }
  if (!allowedHosts.has(req.headers.host??'') || (req.headers.origin && !allowedOrigins.has(req.headers.origin)) || req.headers['sec-fetch-site'] === 'cross-site') { json(403, { error: '仅接受已配置控制台来源的请求' }); return; }
  try {
    const url = new URL(req.url || '/', origin);
    if (req.method === 'GET' && staticFiles[url.pathname]) {
      const [file, type] = staticFiles[url.pathname]; res.writeHead(200, { 'Content-Type': type }); res.end(readFileSync(join(root, 'public', file))); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') { json(200, { ...consoleState(), csrf: token }); return; }
    if(req.method==='GET' && url.pathname==='/api/feishu/settings'){json(200,feishu.state());return;}
    if(req.method==='GET' && url.pathname==='/api/notifications'){
      const before=url.searchParams.get('before');const limit=url.searchParams.get('limit');const status=url.searchParams.get('status');
      try{store.notifications.expire(store.policy());const page=store.notifications.list({before:before===null?undefined:Number(before),limit:limit===null?undefined:Number(limit),status:status===null?undefined:status as NotificationStatus});json(200,{...page,items:feishu.decorate(page.items),summary:store.notifications.summary(),deliveryConfigured:feishu.state().configured});}
      catch{json(400,{error:'通知查询参数无效'});}return;
    }
    if (req.method !== 'POST') { json(404, { error: '接口不存在' }); return; }
    if (!validToken(req.headers['x-console-token']) || req.headers['content-type'] !== 'application/json') { json(403, { error: '请刷新控制台后再操作' }); return; }
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 32768) { json(413, { error: '请求过大' }); return; } }
    const body = JSON.parse(raw || '{}');
    if(url.pathname==='/api/activity'){for(const session of monitor.sessions.values())session.recordManualActivity();json(200,{ok:true});return;}
    if(url.pathname==='/api/feishu/settings'){json(200,{settings:await feishu.save(body),message:'飞书配置已加密保存。'});return;}
    if(url.pathname==='/api/feishu/validate'){json(200,await feishu.validate());return;}
    if(url.pathname==='/api/feishu/reconcile'){json(200,await feishu.reconcile(body));return;}
    if(url.pathname==='/api/feishu/send'){json(200,await feishu.sendManual(body));return;}
    if(url.pathname==='/api/council/defaults'){json(200,{defaults:store.saveCouncilDefaults(body)});return;}
    if(url.pathname==='/api/council/prepare'){json(200,await monitor.prepareCouncil());return;}
    const authMatch=url.pathname.match(/^\/api\/providers\/(ggcb|council|playfootball)\/(auto-login|retry-login|forget-credentials)$/);
    if(authMatch) {
      const id=authMatch[1] as ProviderId;
      if(authMatch[2]==='forget-credentials') {await monitor.sessions.get(id)!.forgetCredentials();json(200,{message:'已清除本机保存及内存中的账号密码；现有网站会话仍保留。'});}
      else json(200,await monitor.automaticLogin(id,body,authMatch[2]==='retry-login'));
      return;
    }
    if(url.pathname==='/api/slots/open') {json(200,await monitor.openSlot(body.resourceId,body.date,body.start));return;}
    const inspectMatch = url.pathname.match(/^\/api\/providers\/(ggcb|council|playfootball)\/inspect$/);
    if (inspectMatch) { json(200, await monitor.sessions.get(inspectMatch[1] as ProviderId)!.inspect()); return; }
    if (url.pathname === '/api/shutdown') { json(200, { ok: true }); void shutdown(); return; }
    if (url.pathname === '/api/policy') {
      const { intervalMinutes } = body; const lookahead = body.lookahead ?? '2m';
      if (!lookaheads.includes(lookahead as Lookahead) || !Number.isInteger(intervalMinutes) || intervalMinutes < 10 || intervalMinutes > 120 || ('autoHold' in body && body.autoHold !== false)) { json(400, { error: '请选择有效查询时长及10–120分钟检查间隔；当前只支持只读监测' }); return; }
      const policy = store.savePolicy({ ...initialPolicy(), lookahead, intervalMinutes });
      store.event('已更新滚动查询时长与检查间隔'); json(200, { ok: true, policy }); return;
    }
    const match = url.pathname.match(/^\/api\/providers\/([^/]+)\/(login|open|check|resume|pause|scan|restart|verify-in-browser)$/);
    if (match && providerIds.includes(match[1] as ProviderId)) { const result=await monitor.action(match[1] as ProviderId, match[2], body.resourceId); json(200, { ok: true,...(result??{}) }); return; }
    json(404, { error: '接口不存在；自动锁位未实现' });
  } catch (error) {
    const message = error instanceof Error && /^(?:普通浏览器|请先关闭普通浏览器|飞书|Council默认选项|请先登录Council|未能确认官网开放时段|官网(?:场地|队伍)选项结构|本地凭据保存失败|请输入(?:有效账号和密码|账号和密码)|该网站正在处理上一项操作|该网站浏览器正在重启|浏览器重启失败|场馆不存在|场馆或场次不存在|不支持的操作|已暂停，等待人工接管|页面仍显示登录表单|该场次观察已更新)/.test(error.message) ? error.message : '操作失败，请检查浏览器是否可打开，或稍后重试';
    json(400, { error: message });
  }
});
server.listen(port, network.host, () => {
  writeFileSync(join(local, 'server.json'), JSON.stringify({ pid: process.pid, url: origin,port,host:network.host,localUrl:network.localUrl,lanUrls:network.lanUrls,allowedSubnets:network.allowedSubnets }));
  store.event('控制台启动：只读监测，自动锁位关闭'); console.log(`Pitch console: ${network.localUrl}`);
  for(const url of network.lanUrls)console.log(`LAN access: ${url}`);
  console.log(network.host==='127.0.0.1'?'Access: local machine only':`Access: local machine + ${network.allowedSubnets.join(', ')||'no allowed LAN subnets (check network interfaces)'}`);
  if (process.env.PITCH_START_PAUSED === '1') for (const s of monitor.sessions.values()) s.mode = 'PAUSED';
  monitor.start();
  feishu.start();
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
async function shutdown() { server.close(); await Promise.all([feishu.close(),monitor.close()]); store.close(); process.exit(0); }
process.on('SIGINT', () => { void shutdown(); }); process.on('SIGTERM', () => { void shutdown(); });
