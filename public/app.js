let state; let token; let pending = new Set(); let initialized = false;
const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, x => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const providerNames = {ggcb:'GGCB',council:'Tower Hamlets',playfootball:'PlayFootball'};
const modeNames = {AUTOMATION:'监测中',MANUAL_CONTROL:'你正在接管',PAUSED:'已暂停'};
const sessionNames = {UNKNOWN:'登录状态待确认',ANONYMOUS_READABLE:'公开日历可读取',AUTHENTICATED:'检测到已登录',LOGIN_REQUIRED:'需要登录'};
const resultNames = {OK:'已覆盖',PARTIAL:'部分覆盖',LOGIN_REQUIRED:'需登录',ERROR:'查询失败'};
const dateFmt = value => value ? new Date(value).toLocaleString('zh-CN',{timeZone:'Europe/London',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}) : '尚未检查';
function message(text,error=false){$('message').textContent=text;$('message').className=error?'error':'';}
async function post(path,body={}) {
 const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Console-Token':token},body:JSON.stringify(body)});
 const data=await response.json();if(!response.ok)throw new Error(data.error);return data;
}
async function action(id,kind,resourceId) {
 pending.add(id);render();message(kind==='login'?'正在暂停扫描并打开官网登录页面…':'正在处理…');
 try{await post(`/api/providers/${id}/${kind}`,{resourceId});message(kind==='login'?'请在弹出的专用 Edge 窗口登录，完成后点击“检测会话”，再恢复监测。':kind==='open'?'官网页面已打开，该网站已暂停自动操作。':'操作已完成');}
 catch(e){message(e.message,true);}finally{pending.delete(id);await refresh();}
}
function dates(){const out=[];const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());for(let d=state.policy.dateFrom>today?state.policy.dateFrom:today;d<=state.policy.dateTo;){const date=new Date(d+'T12:00:00Z');const day=date.getUTCDay();if(day>=1&&day<=4)out.push(d);date.setUTCDate(date.getUTCDate()+1);d=date.toISOString().slice(0,10);}return out;}
function render(){if(!state)return;
 $('providers').innerHTML=state.providers.map(p=>`<article class="provider"><div class="provider-head"><strong>${providerNames[p.id]}</strong><span class="tag ${p.mode==='MANUAL_CONTROL'?'manual':''}">${modeNames[p.mode]}</span></div><p>${sessionNames[p.session]}${p.busy?' · 正在处理':''}</p><div class="actions"><button data-provider="${p.id}" data-action="login" ${pending.has(p.id)?'disabled':''}>手动登录</button><button data-provider="${p.id}" data-action="check" ${p.busy||pending.has(p.id)?'disabled':''}>检测会话</button><button data-provider="${p.id}" data-action="resume" ${p.busy||pending.has(p.id)||p.mode==='AUTOMATION'?'disabled':''}>恢复监测</button><button data-provider="${p.id}" data-action="pause" ${pending.has(p.id)||p.mode==='PAUSED'?'disabled':''}>暂停</button></div></article>`).join('');
 $('resources').innerHTML=state.resources.map(r=>{
  const l=r.latest;const read=l?.result.coverage.filter(x=>x.status==='READ').length||0;const total=l?.result.coverage.length||dates().length;const p=state.providers.find(p=>p.id===r.provider);
  const awaitingCalendar=l?.result.status==='LOGIN_REQUIRED'&&p.session==='AUTHENTICATED';
  const summary=awaitingCalendar?'已检测到登录成功。请在官网核对资格和个人资料，停在Book pitch日历后继续验证。':l?.result.summary||'等待首次检查。可手动登录后恢复，或直接读取公开日历。';
  return `<article class="resource"><div class="resource-title"><h3>${r.name}</h3><span class="tag ${l?.result.status!=='OK'?'warn':''}">${awaitingCalendar?'等待日历':l?resultNames[l.result.status]:'等待检查'}</span></div><p class="format">${r.format}</p><div class="metric">${read}<small>/ ${total} 个目标日期</small></div><p class="note">${esc(summary)}</p>${l?.result.navigation?`<details><summary>日期导航验证</summary>${esc(l.result.navigation)}</details>`:''}<p class="time">上次检查 ${dateFmt(l?.at)}<br>${p.mode==='AUTOMATION'?'下次检查 '+dateFmt(p.nextScanAt):modeNames[p.mode]}</p><button data-provider="${r.provider}" data-action="open" data-resource="${r.id}" ${pending.has(r.provider)?'disabled':''}>打开官网并接管 ↗</button></article>`;
 }).join('');
 const rows=[];let previousWeek='';let candidates=0;
 for(const d of dates()){
  const cells=state.resources.map(r=>{const latest=r.latest;const o=latest?.result.observations.find(x=>x.date===d&&x.start==='18:00');const c=latest?.result.coverage.find(x=>x.date===d);return {r,o,c};});
  if($('available-only').checked&&!cells.some(x=>x.o?.availability==='AVAILABLE'))continue;
  const date=new Date(d+'T12:00:00Z');const weekday=date.getUTCDay();const monday=new Date(date);monday.setUTCDate(date.getUTCDate()-(weekday+6)%7);const week=monday.toISOString().slice(0,10);
  rows.push(`<tr class="${previousWeek!==week?'week-boundary':''}"><td>${d}<small>周${['日','一','二','三','四','五','六'][weekday]} · ${week.slice(5)}当周</small></td>${cells.map(({r,o,c})=>{
   const names={AVAILABLE:o?.duration==null?'18:00可选 · 租期待核实':'可订 · '+(o?.price||'价格待核实'),BOOKED:'18:00不可订',NEARBY:'仅附近场地',UNKNOWN:'未确认'};const available=o?.availability==='AVAILABLE';if(available)candidates++;
   return `<td><span class="cell ${(o?.availability||'UNKNOWN').toLowerCase()}" title="${esc((o?.note||c?.note||'未检查')+' · '+dateFmt(r.latest?.at))}">${o?esc(names[o.availability]):r.latest?.result.status==='LOGIN_REQUIRED'?'需要登录':'未确认'}${o?.duration?`<small>${o.duration}分钟${r.provider==='ggcb'?' · 时长偏好待确认':''}</small>`:''}</span></td>`;}).join('')}</tr>`);previousWeek=week;
 }
 $('calendar').innerHTML=rows.join('')||'<tr><td colspan="5">当前没有符合筛选的观察结果。未确认的日期仍需继续检查。</td></tr>';
 $('results-caption').textContent=`${state.policy.dateFrom} → ${state.policy.dateTo} · ${candidates}项可选观察 · 尚未保留库存`;
 $('events').innerHTML=state.events.map(e=>`<li><time>${dateFmt(e.at)}</time>${esc(e.message)}</li>`).join('');
}
async function refresh(){try{const response=await fetch('/api/state');if(!response.ok)throw new Error();state=await response.json();token=state.csrf;if(!initialized){$('date-from').value=state.policy.dateFrom;$('date-to').value=state.policy.dateTo;$('interval').value=state.policy.intervalMinutes;initialized=true;}render();$('connection').textContent='控制台已连接 · '+dateFmt(new Date().toISOString());}catch{$('connection').textContent='连接中断，监测可能已停止';}}
document.addEventListener('click',e=>{const button=e.target.closest('button[data-action]');if(button)void action(button.dataset.provider,button.dataset.action,button.dataset.resource);});
$('available-only').addEventListener('change',render);
$('policy-form').addEventListener('submit',async e=>{e.preventDefault();try{await post('/api/policy',{dateFrom:$('date-from').value,dateTo:$('date-to').value,intervalMinutes:Number($('interval').value)});message('监测偏好已保存，后续检查使用新范围。');await refresh();}catch(e){message(e.message,true);}});
$('pause-all').addEventListener('click',async()=>{for(const p of state.providers)await action(p.id,'pause');});
$('scan-all').addEventListener('click',async()=>{for(const p of state.providers.filter(x=>x.mode==='AUTOMATION'&&!x.busy))await action(p.id,'scan');});
void refresh();setInterval(refresh,3000);
