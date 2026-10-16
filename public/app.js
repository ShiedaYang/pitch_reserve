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
function renderProviders(){for(const p of state.providers){
 let card=document.querySelector(`[data-provider-card="${p.id}"]`);
 if(!card){card=document.createElement('article');card.className='provider';card.dataset.providerCard=p.id;card.innerHTML=`<div class="provider-head"><strong>${providerNames[p.id]}</strong><span class="tag mode-tag"></span></div><p class="session-status"></p><div class="actions"></div><details class="credentials"><summary>账号密码自动登录${p.id==='playfootball'?' · 两个场地共用':''}</summary><form class="credential-form" data-provider="${p.id}"><label>账号 / 邮箱<input name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="320" required></label><label>密码<input name="password" type="password" autocomplete="current-password" maxlength="1024" required></label><div class="credential-actions"><button class="primary" type="submit">保存并自动登录</button><button type="button" data-action="forget-credentials" data-provider="${p.id}">清除账号密码</button></div><small>提交后使用 Windows 当前用户加密保存在本机；重启后可使用已保存账号登录。验证码请在官网完成。</small></form></details><p class="credential-status"></p><p class="login-result"></p>`;$('providers').append(card);}
 const tag=card.querySelector('.mode-tag');tag.textContent=modeNames[p.mode];tag.className='tag mode-tag'+(p.mode==='MANUAL_CONTROL'?' manual':'');
 card.querySelector('.session-status').textContent=sessionNames[p.session]+(p.busy?' · 正在处理':'');
 card.querySelector('.actions').innerHTML=`<button data-provider="${p.id}" data-action="login" ${pending.has(p.id)?'disabled':''}>手动接管</button><button data-provider="${p.id}" data-action="check" ${p.busy||pending.has(p.id)?'disabled':''}>检测会话</button><button data-provider="${p.id}" data-action="resume" ${p.busy||pending.has(p.id)||p.mode==='AUTOMATION'?'disabled':''}>恢复监测</button><button data-provider="${p.id}" data-action="pause" ${pending.has(p.id)||p.mode==='PAUSED'?'disabled':''}>暂停</button>`;
 card.querySelector('.credential-status').textContent=p.credentialError||(p.hasCredentials?(p.hasSavedCredentials?'已加密保存在本机 · 重启后可用':'当前账号仅在运行内存中')+(p.automaticLoginAllowed?' · 会话失效时尝试续登':' · 等待人工确认后重新登录'):'尚未保存账号');
 const form=card.querySelector('.credential-form');const username=form.elements.username;const password=form.elements.password;
 const saved=p.hasSavedCredentials && typeof p.savedUsername==='string'?p.savedUsername:'';
 if(form.dataset.savedUsername!==saved){if(!form.dataset.accountEdited)username.value=saved;form.dataset.savedUsername=saved;}
 password.placeholder=p.hasSavedCredentials?'••••••••（已保存，修改时输入新密码）':'请输入密码';
 let savedAccount=card.querySelector('.saved-account');if(!savedAccount){savedAccount=document.createElement('p');savedAccount.className='saved-account';card.querySelector('.credential-status').before(savedAccount);}
 savedAccount.hidden=!saved;savedAccount.textContent=saved?`已保存账号：${saved} · 密码：••••••••（已保存）`:'';
 card.querySelector('.login-result').textContent=p.session==='AUTHENTICATED'?'官网会话已确认登录。':p.loginResult?.message||'';
 card.querySelector('button[type=submit]').disabled=pending.has(p.id);
 let retry=card.querySelector('[data-action=retry-login]');if(!retry){retry=document.createElement('button');retry.type='button';retry.dataset.action='retry-login';retry.dataset.provider=p.id;card.querySelector('.credential-actions').append(retry);}retry.textContent=p.hasSavedCredentials?'使用已保存账号登录':'验证完成，继续登录';retry.hidden=!p.hasCredentials;retry.disabled=pending.has(p.id);
 if(p.id==='council'){
  let defaults=card.querySelector('.council-defaults');if(!defaults){defaults=document.createElement('details');defaults.className='council-defaults';defaults.innerHTML='<summary>场地表单默认选项</summary><p class="defaults-summary"></p><button type="button" data-action="prepare-council" data-provider="council">应用默认选项并进入日历</button><small>仅填写已保存选项；个人资料不完整时停下。不选择场次或提交预约。</small>';card.append(defaults);}
  const d=state.councilDefaults;defaults.querySelector('.defaults-summary').textContent=d?`${d.pitch} · ${d.openingHours} · 居民/本地队伍：${d.resident} · 更衣室：${d.changingRooms} · ${d.size} · ${d.teamCategory} · ${d.teamName}`:'尚未保存默认选项';defaults.querySelector('button').disabled=!d||p.busy||pending.has(p.id);
 }
}}
function render(){if(!state)return;
 renderProviders();
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
   const names={AVAILABLE:'18:00可选',BOOKED:'18:00不可订',UNAVAILABLE:'暂无可选时段',NEARBY:'仅附近场地',UNKNOWN:'未确认'};const available=o?.availability==='AVAILABLE';if(available)candidates++;
   const outside=c?.status==='OUTSIDE_RELEASE_WINDOW';const text=o?names[o.availability]:outside?'未放号':r.latest?.result.status==='LOGIN_REQUIRED'?'需要进入日历':'未确认';
   const contents=`${esc(text)}${available?`<strong class="slot-price">${esc(o.price||'价格待核实')}</strong><small>${o.duration?esc(o.duration)+'分钟':'租期结束时间待核实'}${r.provider==='ggcb'?' · 时长偏好待确认':''}</small><small>打开官网 ↗</small>`:outside?`<small>${esc(c.note.match(/预计(\d{4}-\d{2}-\d{2})/)?.[1]||'等待官网开放')}</small>`:''}`;
   const title=esc((o?.note||c?.note||'未检查')+(o?.priceNote?' · '+o.priceNote:'')+' · '+dateFmt(r.latest?.at));
   const stale=available && Date.now()-Date.parse(r.latest.at)>Math.max(state.policy.intervalMinutes*120000,1800000);
   return `<td>${available?`<a class="cell available slot-link" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer" data-slot data-resource="${r.id}" data-date="${d}" data-provider="${r.provider}" title="${title}">${contents}${stale?'<small>历史观察 · 需重新查验</small>':''}</a>`:`<span class="cell ${outside?'unreleased':(o?.availability||'UNKNOWN').toLowerCase()}" title="${title}">${contents}</span>`}</td>`;}).join('')}</tr>`);previousWeek=week;
 }
 $('calendar').innerHTML=rows.join('')||'<tr><td colspan="5">当前没有符合筛选的观察结果。未确认的日期仍需继续检查。</td></tr>';
 $('results-caption').textContent=`${state.policy.dateFrom} → ${state.policy.dateTo} · ${candidates}项可选观察 · 尚未保留库存`;
 $('events').innerHTML=state.events.map(e=>`<li><time>${dateFmt(e.at)}</time>${esc(e.message)}</li>`).join('');
}
async function refresh(){try{const response=await fetch('/api/state');if(!response.ok)throw new Error();state=await response.json();token=state.csrf;if(!initialized){$('date-from').value=state.policy.dateFrom;$('date-to').value=state.policy.dateTo;$('interval').value=state.policy.intervalMinutes;initialized=true;}render();$('connection').textContent='控制台已连接 · '+dateFmt(new Date().toISOString());}catch{$('connection').textContent='连接中断，监测可能已停止';}}
document.addEventListener('click',async e=>{
 const slot=e.target.closest('a[data-slot]');if(slot && !e.ctrlKey && !e.metaKey && !e.shiftKey){e.preventDefault();const id=slot.dataset.provider;if(pending.has(id))return;pending.add(id);message('正在打开对应官网并暂停该网站监测…');try{const result=await post('/api/slots/open',{resourceId:slot.dataset.resource,date:slot.dataset.date,start:'18:00'});message(result.message);}catch(error){message(error.message,true);}finally{pending.delete(id);await refresh();}return;}
 const button=e.target.closest('button[data-action]');if(!button)return;
 if(button.dataset.action==='prepare-council'){const id='council';if(pending.has(id))return;pending.add(id);renderProviders();message('正在官网应用已保存的默认选项…');try{const result=await post('/api/council/prepare');message(result.message);}catch(error){message(error.message,true);}finally{pending.delete(id);await refresh();}return;}
 if(button.dataset.action==='retry-login'){const id=button.dataset.provider;if(pending.has(id))return;pending.add(id);renderProviders();message('使用已保留的账号继续登录…');try{const result=await post(`/api/providers/${id}/retry-login`);message(result.message,result.kind==='FAILED');}catch(error){message(error.message,true);}finally{pending.delete(id);await refresh();}return;}
 if(button.dataset.action==='forget-credentials'){const id=button.dataset.provider;try{const result=await post(`/api/providers/${id}/forget-credentials`);const form=button.closest('.provider').querySelector('.credential-form');form.reset();delete form.dataset.accountEdited;delete form.dataset.savedUsername;message(result.message);await refresh();}catch(error){message(error.message,true);}return;}
 void action(button.dataset.provider,button.dataset.action,button.dataset.resource);
});
document.addEventListener('input',e=>{const form=e.target.closest('.credential-form');if(form && e.target.name==='username')form.dataset.accountEdited='true';});
document.addEventListener('submit',async e=>{const form=e.target.closest('.credential-form');if(!form)return;e.preventDefault();const id=form.dataset.provider;if(pending.has(id))return;const username=form.elements.username.value;const password=form.elements.password.value;form.elements.password.value='';pending.add(id);renderProviders();message('正在官网填写账号密码并登录…');try{const result=await post(`/api/providers/${id}/auto-login`,{username,password});if(form.elements.username.value===username)delete form.dataset.accountEdited;message(result.message,result.kind==='FAILED');}catch(error){message(error.message,true);}finally{pending.delete(id);await refresh();}});
$('available-only').addEventListener('change',render);
$('policy-form').addEventListener('submit',async e=>{e.preventDefault();try{await post('/api/policy',{dateFrom:$('date-from').value,dateTo:$('date-to').value,intervalMinutes:Number($('interval').value)});message('监测偏好已保存，后续检查使用新范围。');await refresh();}catch(e){message(e.message,true);}});
$('pause-all').addEventListener('click',async()=>{for(const p of state.providers)await action(p.id,'pause');});
$('scan-all').addEventListener('click',async()=>{for(const p of state.providers.filter(x=>x.mode==='AUTOMATION'&&!x.busy))await action(p.id,'scan');});
void refresh();setInterval(refresh,3000);
