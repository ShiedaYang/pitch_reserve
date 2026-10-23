let state; let token; let pending = new Set(); let policyDirty = false; let policyRevision = 0; let policySaving = false; let scanning = false;
const restartingProviders=new Set();
let manualSending=null;const resendRequests=new Map();
let notificationBefore=null;let notificationPage=null;let notificationLoading=false;
let activityBefore=null,activityPage=null,activityLoading=false,activityError='';
let feishuDirty=false,feishuRevision=0,feishuSnapshot='',feishuSubmitting=false,feishuOperation='',feishuFeedback=null;
const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, x => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const providerNames = {ggcb:'GGCB',council:'Tower Hamlets',playfootball:'PlayFootball'};
const modeNames = {AUTOMATION:'监测中',MANUAL_CONTROL:'你正在接管',PAUSED:'已暂停'};
const sessionNames = {UNKNOWN:'登录状态待确认',ANONYMOUS_READABLE:'公开日历可读取',AUTHENTICATED:'检测到已登录',LOGIN_REQUIRED:'需要登录'};
const resultNames = {OK:'已覆盖',PARTIAL:'部分覆盖',LOGIN_REQUIRED:'需登录',ERROR:'查询失败'};
const dateFmt = value => value ? new Date(value).toLocaleString('zh-CN',{timeZone:'Europe/London',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}) : '尚未检查';
const externalIcon = '<svg class="external-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M9 3h4v4M13 3L7 9M6 3H3v10h10v-3"/></svg>';
const renderedMarkup = new WeakMap();
function setMarkup(element,html){if(renderedMarkup.get(element)!==html){element.innerHTML=html;renderedMarkup.set(element,html);}}
function setHTML(id,html){setMarkup($(id),html);}
function setView(name,focus=false){
 const tab=$('tab-'+name);if(!tab)return;
 for(const button of document.querySelectorAll('[role=tab]')){const active=button===tab;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;$(button.getAttribute('aria-controls')).hidden=!active;}
 document.title='Pitch Reserve · '+tab.textContent;
 if(location.hash!=='#'+name)history.replaceState(null,'','#'+name);
 if(focus)tab.focus();
 if(name==='activity'&&state)void loadActivity(activityBefore);
}
function isStale(resource){return Date.now()-Date.parse(resource.latest?.at)>Math.max(state.policy.intervalMinutes*120000,1800000);}
function message(text,error=false){$('message').textContent=text;$('message').className=error?'error':'';}
async function post(path,body={}) {
 const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Console-Token':token},body:JSON.stringify(body)});
 const data=await response.json();if(!response.ok)throw new Error(data.error);return data;
}
async function action(id,kind,resourceId) {
 if(pending.has(id)&&kind!=='pause')return;pending.add(id);if(kind==='restart')restartingProviders.add(id);render();message(kind==='restart'?'正在关闭并重启该网站的浏览器…':kind==='login'?'正在暂停扫描并打开官网登录页面…':'正在处理…');
 try{const result=await post(`/api/providers/${id}/${kind}`,{resourceId});message(result.message||(kind==='login'?(state.providers.find(p=>p.id===id)?.headless?'当前为无界面模式，请先按部署说明配置远程图形浏览器，再完成官网验证。':'请在专用浏览器完成验证；远程部署可使用“打开远程浏览器”。1分钟无操作后自动检测并恢复。'):kind==='open'?'官网页面已打开，该网站已暂停自动操作。':'操作已完成'));}
 catch(e){message(e.message,true);}finally{pending.delete(id);restartingProviders.delete(id);await refresh();}
}
function londonToday(){return state.today||new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
function policyEnd(today,lookahead){const d=new Date(today+'T12:00:00Z');if(lookahead==='7d'||lookahead==='14d')d.setUTCDate(d.getUTCDate()+(lookahead==='7d'?7:14));else{const day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+Number(lookahead[0]));const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,last));}return d.toISOString().slice(0,10);}
function renderPolicy(){if(!policyDirty&&!policySaving){$('lookahead').value=state.policy.lookahead||'2m';$('interval').value=state.policy.intervalMinutes;}const start=new Date(londonToday()+'T12:00:00Z');start.setUTCDate(start.getUTCDate()+1);const from=start.toISOString().slice(0,10);$('date-from').value=from;$('date-to').value=policyEnd(from,$('lookahead').value);$('policy-range-help').textContent='从伦敦明天开始，日期每日自动顺延，无需重新保存。'+(policyDirty?'查询时长或间隔已更改，保存后生效。':'');}
function dates(){const out=[];const today=londonToday();for(let d=state.policy.dateFrom>today?state.policy.dateFrom:today;d<=state.policy.dateTo;){const date=new Date(d+'T12:00:00Z');const day=date.getUTCDay();if(day>=1&&day<=4)out.push(d);date.setUTCDate(date.getUTCDate()+1);d=date.toISOString().slice(0,10);}return out;}
function renderProviders(){for(const p of state.providers){
 const restarting=p.restarting||restartingProviders.has(p.id);
 const nativeActive=!!p.nativeVerificationActive;
 let card=document.querySelector(`[data-provider-card="${p.id}"]`);
 if(!card){card=document.createElement('article');card.className='provider';card.dataset.providerCard=p.id;card.innerHTML=`<div class="provider-head"><strong>${providerNames[p.id]}</strong><span class="tag mode-tag"></span></div><p class="session-status"></p><div class="actions"></div><details class="credentials"><summary>账号密码自动登录${p.id==='playfootball'?' · 两个场地共用':''}</summary><form class="credential-form" data-provider="${p.id}"><label>账号 / 邮箱<input name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="320" required></label><label>密码<input name="password" type="password" autocomplete="current-password" maxlength="1024" required></label><div class="credential-actions"><button class="primary" type="submit">保存并自动登录</button><button type="button" data-action="forget-credentials" data-provider="${p.id}">清除账号密码</button></div><small>提交后按当前系统加密保存在服务端；重启后可使用已保存账号登录。验证码请在官网完成。</small></form></details><p class="credential-status"></p><p class="login-result"></p>`;$('providers').append(card);}
 const tag=card.querySelector('.mode-tag');tag.textContent=restarting?'重启中':modeNames[p.mode];tag.className='tag mode-tag'+(p.mode==='MANUAL_CONTROL'?' manual':'');
 card.querySelector('.session-status').textContent=restarting?'正在关闭原浏览器进程并重新打开…':p.attention?.message||(sessionNames[p.session]+(p.busy?' · 正在处理':p.mode==='MANUAL_CONTROL'?' · 无操作1分钟后自动检测并恢复':''));
 setMarkup(card.querySelector('.actions'),`<button data-provider="${p.id}" data-action="login" ${pending.has(p.id)||restarting||nativeActive?'disabled':''}>手动接管</button><button data-provider="${p.id}" data-action="check" ${p.busy||pending.has(p.id)||nativeActive?'disabled':''}>检测会话</button><button data-provider="${p.id}" data-action="resume" ${p.busy||pending.has(p.id)||nativeActive||p.mode==='AUTOMATION'?'disabled':''}>恢复监测</button><button data-provider="${p.id}" data-action="restart" ${pending.has(p.id)||p.restarting||nativeActive?'disabled':''} title="关闭此网站的浏览器进程后重新打开；保留已保存账号">${restarting?'正在重启…':'重启浏览器'}</button>${p.id==='playfootball'?`<button data-provider="${p.id}" data-action="verify-in-browser" ${pending.has(p.id)||restarting||nativeActive?'disabled':''} title="使用同一专用会话手动验证；完成后关闭该窗口，自动接回监测">${nativeActive?'普通浏览器验证中':'普通浏览器验证'}</button>`:''}<button data-provider="${p.id}" data-action="pause" ${pending.has(p.id)||p.mode==='PAUSED'?'disabled':''}>暂停</button>${p.manualBrowserUrl?`<a class="button-link" href="${esc(p.manualBrowserUrl)}" target="_blank" rel="noopener noreferrer">打开远程浏览器 ${externalIcon}</a>`:''}`);
 let environment=card.querySelector('.manual-environment');if(!environment){environment=document.createElement('p');environment.className='credential-status manual-environment';card.querySelector('.actions').after(environment);}environment.hidden=!p.headless;environment.textContent=p.headless?'当前服务为无界面模式。人工验证需要配置有界面浏览器和远程桌面，详见 Linux 部署说明。':'';
 card.querySelector('.credential-status').textContent=p.credentialError||(p.hasCredentials?(p.hasSavedCredentials?'已加密保存在本机 · 重启后可用':'当前账号仅在运行内存中')+(p.automaticLoginAllowed?' · 会话失效时尝试续登':' · 等待人工确认后重新登录'):'尚未保存账号');
 const form=card.querySelector('.credential-form');const username=form.elements.username;const password=form.elements.password;
 const saved=p.hasSavedCredentials && typeof p.savedUsername==='string'?p.savedUsername:'';
 if(form.dataset.savedUsername!==saved){if(!form.dataset.accountEdited)username.value=saved;form.dataset.savedUsername=saved;}
 password.placeholder=p.hasSavedCredentials?'••••••••（已保存，修改时输入新密码）':'请输入密码';
 let savedAccount=card.querySelector('.saved-account');if(!savedAccount){savedAccount=document.createElement('p');savedAccount.className='saved-account';card.querySelector('.credential-status').before(savedAccount);}
 savedAccount.hidden=!saved;savedAccount.textContent=saved?`已保存账号：${saved} · 密码：••••••••（已保存）`:'';
 card.querySelector('.login-result').textContent=p.session==='AUTHENTICATED'?'官网会话已确认登录。':p.loginResult?.message||'';
 card.querySelector('button[type=submit]').disabled=pending.has(p.id)||nativeActive;
 let retry=card.querySelector('[data-action=retry-login]');if(!retry){retry=document.createElement('button');retry.type='button';retry.dataset.action='retry-login';retry.dataset.provider=p.id;card.querySelector('.credential-actions').append(retry);}retry.textContent=p.hasSavedCredentials?'使用已保存账号登录':'验证完成，继续登录';retry.hidden=!p.hasCredentials;retry.disabled=pending.has(p.id)||nativeActive;
 if(p.id==='council'){
  let defaults=card.querySelector('.council-defaults');if(!defaults){defaults=document.createElement('details');defaults.className='council-defaults';defaults.innerHTML='<summary>场地表单默认选项</summary><p class="defaults-summary"></p><button type="button" data-action="prepare-council" data-provider="council">应用默认选项并进入日历</button><small>仅填写已保存选项；个人资料不完整时停下。不选择场次或提交预约。</small>';card.append(defaults);}
  const d=state.councilDefaults;defaults.querySelector('.defaults-summary').textContent=d?`${d.pitch} · ${d.openingHours} · 居民/本地队伍：${d.resident} · 更衣室：${d.changingRooms} · ${d.size} · ${d.teamCategory} · ${d.teamName}`:'尚未保存默认选项';defaults.querySelector('button').disabled=!d||p.busy||pending.has(p.id);
 }
}}
function renderResources(){
 const attention=state.providers.filter(p=>p.attention&&p.mode==='MANUAL_CONTROL');$('monitor-alerts').hidden=!attention.length;setHTML('monitor-alerts',attention.map(p=>`<p><strong>${esc(providerNames[p.id])}：请手动接管</strong><span>${esc(p.attention.message)}</span><button class="text-button" data-go="accounts">查看账号与接管</button>${p.manualBrowserUrl?`<a href="${esc(p.manualBrowserUrl)}" target="_blank" rel="noopener noreferrer">打开远程浏览器 ${externalIcon}</a>`:''}${p.headless?'<small>服务器当前为无界面模式。人工验证需要有界面浏览器及远程桌面；请按 Linux 部署说明配置。</small>':''}</p>`).join(''));

 const paused=state.providers.filter(p=>p.mode!=='AUTOMATION').length;
 $('monitor-summary').textContent=`${state.resources.length} 个场地 · ${paused?paused+' 组账号已暂停或接管':'全部账号监测中'}`;
 setHTML('resources',state.resources.map(r=>{
  const l=r.latest;const read=l?.result.coverage.filter(x=>x.status==='READ').length||0;const total=l?.result.coverage.length||dates().length;const p=state.providers.find(p=>p.id===r.provider);
  const awaitingCalendar=l?.result.status==='LOGIN_REQUIRED'&&p.session==='AUTHENTICATED';
  const summary=awaitingCalendar?'已登录。系统会按保存的默认配置准备日历；需要补资料时会提示，1分钟无操作后自动重试。':l?.result.summary||'等待首次检查。可手动登录后恢复，或直接读取公开日历。';
  return `<article class="resource"><div><div class="resource-title"><h3>${esc(r.name)}</h3><span class="tag ${l?.result.status!=='OK'?'warn':''}">${awaitingCalendar?'等待日历':l?resultNames[l.result.status]:'等待检查'}</span></div><p class="format">${esc(r.format)}</p><p class="time">上次检查 ${dateFmt(l?.at)}</p></div><div><p class="coverage-count">已读取 ${read} / ${total} 个目标日期</p><p class="note">${esc(summary)}</p>${l?.result.navigation?`<details><summary>日期导航验证</summary>${esc(l.result.navigation)}</details>`:''}<p class="time">${p.mode==='AUTOMATION'?'下次检查 '+dateFmt(p.nextScanAt):modeNames[p.mode]}</p></div><a class="button-link" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">打开官网 ${externalIcon}</a></article>`;
 }).join(''));
}
function renderCalendar(){
 const targetDates=dates();const rows=[];const availableSlots=[];let previousWeek='';
 for(const d of targetDates){
  const cells=state.resources.map(r=>{const found=r.latest?.result.observations.find(x=>x.date===d&&x.start==='18:00');return {r,o:found?.availability==='NEARBY'?{...found,availability:'UNAVAILABLE',price:null,duration:null,note:'该场地该时段无可订场次'}:found,c:r.latest?.result.coverage.find(x=>x.date===d)};});
  for(const {r,o} of cells)if(o?.availability==='AVAILABLE')availableSlots.push({r,o});
  if($('available-only').checked&&!cells.some(x=>x.o?.availability==='AVAILABLE'))continue;
  const date=new Date(d+'T12:00:00Z');const weekday=date.getUTCDay();const monday=new Date(date);monday.setUTCDate(date.getUTCDate()-(weekday+6)%7);const week=monday.toISOString().slice(0,10);
  rows.push(`<tr class="${previousWeek!==week?'week-boundary':''}" data-date-row="${d}"><th scope="row"><span class="day">${d.slice(5).replace('-',' / ')} <span>周${['日','一','二','三','四','五','六'][weekday]}</span></span><small>${week.slice(5)} 当周</small></th>${cells.map(({r,o,c})=>{
   const names={AVAILABLE:'18:00 可订观察',BOOKED:'18:00 不可订',UNAVAILABLE:'暂无可选时段',UNKNOWN:'暂无信息'};const available=o?.availability==='AVAILABLE';
   const outside=c?.status==='OUTSIDE_RELEASE_WINDOW';const text=o?names[o.availability]:'暂无信息';
   const contents=`${esc(text)}${available?`<strong class="slot-price">${esc(o.price||'价格待核实')}</strong><small>${o.duration?esc(o.duration)+' 分钟':'结束时间待核实'}${r.provider==='ggcb'?' · 时长偏好待确认':''}</small><small>${dateFmt(r.latest.at)} 已查</small>${isStale(r)?'<small class="stale-note">历史观察 · 需重新查验</small>':''}<small><span class="slot-action">打开官网 ${externalIcon}</span></small>`:outside?`<small>${esc(c.note?.match(/预计(\d{4}-\d{2}-\d{2})/)?.[1]||'等待官网开放')}</small>`:''}`;
   const title=esc((o?.note||c?.note||'未检查')+(o?.priceNote?' · '+o.priceNote:'')+' · '+dateFmt(r.latest?.at));
   return `<td>${available?`<a class="cell available slot-link" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer" data-slot data-resource="${r.id}" data-date="${d}" data-provider="${r.provider}" title="${title}">${contents}</a>`:`<span class="cell ${outside?'unreleased':(o?.availability||'UNKNOWN').toLowerCase()}" title="${title}">${contents}</span>`}</td>`;
  }).join('')}</tr>`);previousWeek=week;
 }
 setHTML('calendar',rows.join(''));
 $('calendar-grid').hidden=rows.length===0;$('calendar-empty').hidden=rows.length!==0;
 if(!rows.length)setHTML('calendar-empty',$('available-only').checked?'当前没有可订观察，暂无信息的日期仍会继续检查。<button data-show-all>查看全部目标日期</button>':'当前范围内没有未来的周一至周四，请调整监测日期。<button data-go="settings">调整日期范围</button>');
 $('results-caption').textContent=`${targetDates[0]||state.policy.dateFrom} 至 ${state.policy.dateTo} · ${targetDates.length} 个日期 · ${availableSlots.length} 项可订观察`;
 setHTML('next-slots',availableSlots.length?`<span>近期可订观察</span>${availableSlots.slice(0,2).map(({r,o})=>`<a class="next-slot" data-slot data-resource="${r.id}" data-date="${o.date}" data-provider="${r.provider}" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${o.date.slice(5)} ${esc(r.name)}<strong>${esc(o.price||'价格待核实')}</strong>${isStale(r)?' <small>历史观察，需复核</small>':''}</a>`).join('')}${availableSlots.length>2?'<button class="text-button" data-filter-available>查看全部可订日期</button>':''}`:$('available-only').checked?'暂未发现可订观察。取消筛选可查看其他日期的监测状态。':'暂未发现可订观察。下表保留全部目标日期，暂无信息不代表售罄。');
}
function render(){if(!state)return;
 renderProviders();renderResources();renderCalendar();renderFeishu();
 const canScan=state.providers.some(p=>p.mode==='AUTOMATION'&&!p.busy&&!pending.has(p.id));
 $('scan-all').disabled=scanning||!canScan;
 $('scan-all').textContent=scanning?'正在检查…':'立即检查';
 $('scan-all').title=canScan?'检查当前允许自动监测的账号':'所有账号均在处理、暂停或接管中，请在“账号与接管”查看';
 renderActivity();renderDesktop();
}
function renderDesktop(){
 const d=state.desktop||{};const remote=d.url||state.providers.find(p=>p.manualBrowserUrl)?.manualBrowserUrl;
 $('desktop-status').textContent=d.headless?'当前运行在无界面模式，服务器不会显示浏览器窗口。':d.configured?'远程桌面已配置，官网浏览器运行在服务器虚拟桌面上。':'当前使用本机图形浏览器。';
 $('desktop-open').hidden=!remote;if(remote)$('desktop-open').href=remote;
 $('desktop-help').textContent=d.configured&&!d.headless?'打开远程浏览器后输入桌面密码。先在下方选择网站的“手动接管”；PlayFootball 验证循环时使用“普通浏览器验证”，验证完成后关闭该专用窗口。':'Ubuntu 无桌面环境请按部署说明安装桌面组件，再使用 sh start-desktop.sh 启动。该脚本会切换为有界面模式，并在此提供远程入口。Windows 本机可直接操作工具浏览器。';
}
const stageNames={STARTUP:'启动检查',SHUTDOWN:'服务停止',SCAN_START:'开始监测',SCAN_COMPLETE:'监测结果',OPEN_PAGE:'打开官网',CALENDAR:'读取日历',RETRY:'重试',RECOVERY:'恢复监测',LOGIN:'登录',SESSION:'会话检查',BROWSER:'浏览器',MANUAL_CONTROL:'人工接管',DELIVERY:'消息发送',REMOTE_DESKTOP:'远程桌面',CONSOLE_ACTION:'控制台操作',LEGACY:'历史操作',OPERATION:'操作'};
function renderActivity(){
 const data=activityPage||{items:state.events||[],nextCursor:null};
 $('event-summary').textContent=activityLoading?'正在读取…':`保留最近 ${state.logging?.retained||5000} 条 · 本页 ${data.items.length} 条`;
 $('event-error').hidden=!(activityError||state.logging?.fileError);$('event-error').textContent=activityError||state.logging?.fileError||'';
 $('event-page-label').textContent=activityBefore===null?'最新记录 · 自动更新':'更早的记录 · 已暂停翻页更新';
 $('event-latest').hidden=activityBefore===null;$('event-older').disabled=activityLoading||!data.nextCursor;
 $('event-level').disabled=$('event-provider').disabled=activityLoading;$('event-latest').disabled=activityLoading;
 const open=new Set([...$('events').querySelectorAll('details[open]')].map(el=>el.dataset.event));
 setHTML('events',data.items.map(e=>{const d=e.details||{},level=e.level||'INFO';const counts=[['readDays','已读日期'],['targetDays','目标日期'],['unknownDays','暂无信息'],['available','可订场次'],['priced','含价格观察'],['attempt','尝试次数'],['sent','发送成功'],['failed','发送失败']].filter(([key])=>d[key]!==undefined).map(([key,label])=>`${label} ${d[key]}`);if(d.durationMs!==undefined)counts.push(`耗时 ${(d.durationMs/1000).toFixed(1)} 秒`);return `<li><time datetime="${esc(e.at)}">${esc(new Date(e.at).toLocaleString('zh-CN',{timeZone:'Europe/London',hour12:false}))}</time><div class="event-body"><div class="event-meta"><span class="tag ${level==='ERROR'?'event-error':level==='WARN'?'warn':''}">${{INFO:'信息',WARN:'警告',ERROR:'错误'}[level]||esc(level)}</span><span>${esc(providerNames[e.provider]||{system:'控制台',feishu:'飞书通知'}[e.provider]||'控制台')} · ${esc(stageNames[e.stage]||e.stage||'操作')}</span>${e.resourceId?`<span>${esc(state.resources.find(r=>r.id===e.resourceId)?.name||e.resourceId)}</span>`:''}</div><p class="event-message">${esc(e.message)}</p>${d.reason?`<p>原因：${esc(d.reason)}</p>`:''}${d.remedy?`<p>处理建议：${esc(d.remedy)}</p>`:''}${counts.length?`<p class="event-counts">${esc(counts.join(' · '))}</p>`:''}${e.code||e.runId||d.navigation||d.nextRetryAt||d.action?`<details data-event="${esc(e.id)}"><summary>技术详情</summary><dl>${[['诊断代码',e.code],['异常类型',d.errorType],['代码位置',d.location],['检查编号',e.runId],['执行动作',d.action],['日期范围',d.dateFrom&&d.dateFrom+' 至 '+d.dateTo],['日期导航',d.navigation],['下次检测',d.nextRetryAt&&dateFmt(d.nextRetryAt)]].filter(([,value])=>value).map(([label,value])=>`<dt>${label}</dt><dd>${esc(value)}</dd>`).join('')}</dl></details>`:''}</div></li>`;}).join('')||'<li>当前筛选下没有运行记录。</li>');
 for(const el of $('events').querySelectorAll('details'))if(open.has(el.dataset.event))el.open=true;
}
async function loadActivity(before=null){
 if(activityLoading)return;activityLoading=true;renderActivity();
 const query=new URLSearchParams({limit:'50'});if(before!==null)query.set('before',before);if($('event-level').value)query.set('level',$('event-level').value);if($('event-provider').value)query.set('provider',$('event-provider').value);
 try{const response=await fetch('/api/events?'+query);if(!response.ok)throw new Error('运行记录读取失败，请稍后重试。');activityPage=await response.json();activityBefore=before;activityError='';}catch(error){activityError=error.message;}finally{activityLoading=false;renderActivity();}
}
function renderNotifications(){
 const data=notificationBefore===null?state.notifications:notificationPage;
 if(!data){$('notification-summary').textContent='等待服务提供通知记录。';setHTML('notification-list','<li class="notification-empty">通知列表暂不可用，请稍后刷新。</li>');return;}
 const counts=state.notifications?.summary||{};
 $('notification-channel-notice').textContent=state.feishu?.enabled?'飞书自动通知已启用。已送达的收件人不会重复推送；价格及库存请以官网为准。':state.feishu?.configured?'飞书配置已保存，自动通知当前关闭。通知记录持续保存，可在下方配置中启用自动发送，也可逐条手动发送。':'飞书尚未配置，当前不会发送消息。通知记录持续保存，请在下方展开飞书通知配置，添加用户或群组。';
 $('notification-summary').textContent=`待发送 ${counts.PENDING||0} · 发送中 ${counts.PROCESSING||0} · 待重试 ${counts.FAILED||0} · 需核对 ${counts.REVIEW_REQUIRED||0} · 已发送 ${counts.SENT||0} · 已取消/过期 ${(counts.CANCELLED||0)+(counts.EXPIRED||0)}`;
 $('notification-page-label').textContent=notificationBefore===null?`最近 ${data.items.length} 条记录`:'更早的记录';
 $('notification-latest').hidden=notificationBefore===null;$('notification-older').disabled=notificationLoading||!data.nextCursor;
 const labels={PENDING:'待发送',PROCESSING:'发送中',FAILED:'待重试',SENT:'已发送',CANCELLED:'已取消',EXPIRED:'已过期',REVIEW_REQUIRED:'需核对送达'};
 setHTML('notification-list',data.items.map(item=>{const p=item.payload;const url=state.resources.find(r=>r.id===p.resourceId)?.url;return `<li><div><strong>${esc(p.date)} ${esc(p.start)}　${esc(p.resourceName)}</strong><p>${esc(p.price||'价格待核实')} · ${p.duration?esc(p.duration)+' 分钟':'结束时间待核实'} · 第 ${item.occurrence} 次发现</p><small>首次发现 ${dateFmt(item.firstSeenAt)} · 最近确认 ${dateFmt(item.lastSeenAt)}${item.sentAt?' · 发送确认 '+dateFmt(item.sentAt):''}</small>${item.lastError?`<p class="notification-reason">${esc(item.lastError)}</p>`:''}${(item.resends||[]).map(resend=>`<div class="delivery-detail">重发 ${dateFmt(resend.createdAt)}：${labels[resend.status]||resend.status}${resend.error?` · ${esc(resend.error)}`:''}${resend.status==='REVIEW_REQUIRED'?(resend.deliveries||[]).filter(d=>d.status==='UNCERTAIN').map(d=>`<p>${esc(d.targetName)}：<button data-feishu-reconcile="delivered" data-notification="${esc(resend.id)}" data-target="${esc(d.targetKey)}">已核实送达</button><button data-feishu-reconcile="retry" data-notification="${esc(resend.id)}" data-target="${esc(d.targetKey)}">已核实未送达，允许重试</button></p>`).join(''):''}</div>`).join('')}${(item.deliveries||[]).map(delivery=>`<div class="delivery-detail">${esc(delivery.targetName)}：${delivery.status==='SENT'?'已确认送达':delivery.status==='UNCERTAIN'?'送达待确认':'等待发送'}${item.status==='REVIEW_REQUIRED'&&delivery.status==='UNCERTAIN'?`<div><button data-feishu-reconcile="delivered" data-notification="${esc(item.id)}" data-target="${esc(delivery.targetKey)}">已核实送达</button><button data-feishu-reconcile="retry" data-notification="${esc(item.id)}" data-target="${esc(delivery.targetKey)}">已核实未送达，允许重试</button></div>`:''}</div>`).join('')}</div><div class="notification-actions"><span class="tag ${['FAILED','REVIEW_REQUIRED'].includes(item.status)?'warn':''}">${labels[item.status]||'未知状态'}</span>${['PENDING','FAILED'].includes(item.status)?`<button data-feishu-send="${esc(item.id)}" ${manualSending||state.feishu?.busy||!state.feishu?.configured||feishuDirty||feishuSubmitting?'disabled':''} title="向已保存且勾选的收件人发送此条通知">${manualSending===item.id?'正在发送…':item.status==='FAILED'?'手动重试':'手动发送'}</button>`:''}${item.status==='SENT'?`<button data-feishu-resend="${esc(item.id)}" ${manualSending||state.feishu?.busy||!state.feishu?.configured||feishuDirty||feishuSubmitting?'disabled':''}>${manualSending===item.id?'正在重发…':'重新发送'}</button>`:''}${url?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">打开官网 ${externalIcon}</a>`:''}</div></li>`;}).join('')||'<li class="notification-empty">尚无通知。监测发现新的可订场次后，会自动记录在这里。</li>');
}
function addFeishuRecipient(value={name:'',type:'open_id',receiveId:'',enabled:true},target='feishu-recipients'){
 const row=document.createElement('div');row.className='recipient-row';
 row.innerHTML=`<label>备注名称<input data-recipient-name maxlength="80" value="${esc(value.name)}" placeholder="如：我的飞书 / 球队群"></label><label>收件人类型<select data-recipient-type>${[['open_id','用户 Open ID'],['user_id','用户 User ID'],['union_id','用户 Union ID'],['email','用户邮箱'],['chat_id','群组 Chat ID']].map(([type,label])=>`<option value="${type}" ${type===value.type?'selected':''}>${label}</option>`).join('')}</select></label><label>用户ID / 群组ID / 邮箱<input data-recipient-id maxlength="256" autocomplete="off" spellcheck="false" value="${esc(value.receiveId)}" required></label><div><label class="filter"><input data-recipient-enabled type="checkbox" ${value.enabled?'checked':''}>接收</label><button type="button" data-feishu-remove>移除</button></div>`;
 $(target).append(row);
}
function renderFeishu(){
 const config=state.feishu;if(!config){$('feishu-status').textContent='等待服务提供飞书配置。';return;}
 const snapshot=JSON.stringify([config.appId,config.hasSecret,config.enabled,config.recipients,config.adminEnabled,config.adminRecipients]);
 if(!feishuDirty&&snapshot!==feishuSnapshot){$('feishu-app-id').value=config.appId;$('feishu-enabled').checked=config.enabled;$('feishu-recipients').replaceChildren();for(const row of config.recipients)addFeishuRecipient(row);$('feishu-admin-enabled').checked=!!config.adminEnabled;$('feishu-admin-recipients').replaceChildren();for(const row of config.adminRecipients||[])addFeishuRecipient(row,'feishu-admin-recipients');feishuSnapshot=snapshot;}
 $('feishu-app-secret').placeholder=config.hasSecret?'••••••••（已保存；留空保持）':'填写应用密钥';
 $('feishu-status').textContent=(config.configured?'配置已保存':'尚未完成配置')+' · '+(config.enabled?'自动通知开启':'自动通知关闭')+(config.validatedAt?' · 凭据已验证':' · 尚未验证凭据')+(config.busy?' · 正在处理':'');
 const feedback=feishuFeedback||(config.error?{text:config.error,error:true}:null);const output=$('feishu-error');output.hidden=!feedback;output.textContent=feedback?.text||'';output.className=feedback?.error?'feishu-error':'feishu-feedback';
 $('feishu-save').disabled=feishuSubmitting;$('feishu-save').textContent=feishuSubmitting&&feishuOperation==='save'?'正在保存…':'保存飞书配置';
 $('feishu-validate').textContent=feishuSubmitting&&feishuOperation==='validate'?'正在验证…':'验证应用凭据';
 $('feishu-validate').disabled=feishuSubmitting||feishuDirty||!config.hasSecret;
 $('feishu-validate').title=feishuDirty?'请先保存配置，再验证':'只验证应用凭据，不发送消息';
 $('feishu-add-recipient').disabled=$('feishu-recipients').children.length>=10;$('feishu-add-admin').disabled=$('feishu-admin-recipients').children.length>=10;
 const notices=config.adminNotices||[];$('feishu-admin-status').textContent=(config.adminEnabled?'管理员通知已开启':'管理员通知关闭')+' · '+notices.filter(n=>!n.resolvedAt).length+' 项未恢复故障'+(config.adminError?' · '+config.adminError:'')+(notices.some(n=>n.status==='REVIEW_REQUIRED')?' · 部分管理员通知送达不确定，请在飞书核对，已停止自动重试':'');
 $('feishu-preview').textContent=config.preview||'保存配置后可预览消息格式。';
 renderNotifications();
}
async function loadNotificationPage(before){
 if(notificationLoading)return;notificationLoading=true;renderNotifications();
 try{const response=await fetch('/api/notifications?limit=50'+(before===null?'':'&before='+encodeURIComponent(before)));if(!response.ok)throw new Error('无法读取通知，请稍后重试');notificationPage=await response.json();notificationBefore=before;renderNotifications();}
 catch(error){message(error.message,true);}finally{notificationLoading=false;renderNotifications();}
}
async function refresh(){try{const response=await fetch('/api/state');if(!response.ok)throw new Error();state=await response.json();token=state.csrf;renderPolicy();if(notificationBefore!==null&&!notificationLoading&&!$('view-notifications').hidden)await loadNotificationPage(notificationBefore);if(!activityLoading&&activityBefore===null&&!$('view-activity').hidden)await loadActivity(null);render();$('connection').className='';$('connection').textContent='控制台已连接 · '+dateFmt(new Date().toISOString());}catch{$('connection').className='connection-error';$('connection').textContent='连接中断，当前显示上次读取的数据，请检查本地服务。';}}
document.addEventListener('click',async e=>{
 const navigation=e.target.closest('[data-view],[data-go]');if(navigation){setView(navigation.dataset.view||navigation.dataset.go,true);if(navigation.dataset.scroll)$(navigation.dataset.scroll)?.scrollIntoView({block:'start'});return;}
 const resendButton=e.target.closest('[data-feishu-resend]');if(resendButton){if(manualSending||feishuDirty||feishuSubmitting||state.feishu?.busy)return;const id=resendButton.dataset.feishuResend;manualSending=id;if(!resendRequests.has(id))resendRequests.set(id,crypto.randomUUID());renderNotifications();message('正在重新发送历史记录…');try{const result=await post('/api/feishu/send',{notificationId:id,resend:true,requestId:resendRequests.get(id)});if(result.sent)resendRequests.delete(id);message(result.message,!!result.failed);}catch(error){message(error.message,true);}finally{manualSending=null;await refresh();}return;}
 const sendButton=e.target.closest('[data-feishu-send]');if(sendButton){if(manualSending||feishuDirty||feishuSubmitting||state.feishu?.busy)return;manualSending=sendButton.dataset.feishuSend;renderNotifications();message('正在发送所选通知…');try{const result=await post('/api/feishu/send',{notificationId:manualSending});message(result.message,!!result.failed);}catch(error){message(error.message,true);}finally{manualSending=null;await refresh();}return;}
 const reconciliation=e.target.closest('[data-feishu-reconcile]');if(reconciliation){reconciliation.disabled=true;try{await post('/api/feishu/reconcile',{notificationId:reconciliation.dataset.notification,targetKey:reconciliation.dataset.target,decision:reconciliation.dataset.feishuReconcile});message('已保存人工核对结果；未送达的有效记录可手动重试，或由已启用的自动通知继续处理。');await refresh();}catch(error){message(error.message,true);reconciliation.disabled=false;}return;}
 if(e.target.closest('[data-show-all],[data-filter-available]')){$('available-only').checked=!!e.target.closest('[data-filter-available]');renderCalendar();$('available-only').focus();return;}
 const button=e.target.closest('button[data-action]');if(!button)return;
 if(button.dataset.action==='prepare-council'){const id='council';if(pending.has(id))return;pending.add(id);renderProviders();message('正在官网应用已保存的默认选项…');try{const result=await post('/api/council/prepare');message(result.message);}catch(error){message(error.message,true);}finally{pending.delete(id);await refresh();}return;}
 if(button.dataset.action==='retry-login'){const id=button.dataset.provider;if(pending.has(id))return;pending.add(id);renderProviders();message('使用已保留的账号继续登录…');try{const result=await post(`/api/providers/${id}/retry-login`);message(result.message,result.kind==='FAILED');}catch(error){message(error.message,true);}finally{pending.delete(id);await refresh();}return;}
 if(button.dataset.action==='forget-credentials'){const id=button.dataset.provider;try{const result=await post(`/api/providers/${id}/forget-credentials`);const form=button.closest('.provider').querySelector('.credential-form');form.reset();delete form.dataset.accountEdited;delete form.dataset.savedUsername;message(result.message);await refresh();}catch(error){message(error.message,true);}return;}
 void action(button.dataset.provider,button.dataset.action,button.dataset.resource);
});
document.addEventListener('input',e=>{const form=e.target.closest('.credential-form');if(form && e.target.name==='username')form.dataset.accountEdited='true';});
document.addEventListener('submit',async e=>{const form=e.target.closest('.credential-form');if(!form)return;e.preventDefault();const id=form.dataset.provider;if(pending.has(id))return;const username=form.elements.username.value;const password=form.elements.password.value;form.elements.password.value='';pending.add(id);renderProviders();message('正在官网填写账号密码并登录…');try{const result=await post(`/api/providers/${id}/auto-login`,{username,password});if(form.elements.username.value===username)delete form.dataset.accountEdited;message(result.message,result.kind==='FAILED');}catch(error){message(error.message,true);}finally{pending.delete(id);await refresh();}});
$('available-only').addEventListener('change',render);
$('event-level').addEventListener('change',()=>void loadActivity(null));$('event-provider').addEventListener('change',()=>void loadActivity(null));
$('event-latest').addEventListener('click',()=>void loadActivity(null));$('event-older').addEventListener('click',()=>{if(activityPage?.nextCursor)void loadActivity(activityPage.nextCursor);});
$('desktop-check').addEventListener('click',async()=>{const button=$('desktop-check');button.disabled=true;button.textContent='正在检查…';try{const response=await fetch('/api/desktop');if(!response.ok)throw new Error('连接检查失败，请稍后重试。');const d=await response.json();$('desktop-result').textContent=!d.configured?'远程桌面尚未配置。Ubuntu 请使用 sh start-desktop.sh 启动。':!d.reachable?'无法连接远程桌面。请检查服务器桌面进程日志。':d.headless?'桌面服务可连接，但浏览器仍为无界面模式；请使用 sh start-desktop.sh 重启。':'远程桌面服务可连接。打开后输入桌面密码；若画面无法连接，请检查反向代理的 WebSocket 配置。';}catch(error){$('desktop-result').textContent=error.message;}finally{$('desktop-result').hidden=false;button.disabled=false;button.textContent='检查远程桌面连接';}});
$('notification-latest').addEventListener('click',()=>{notificationBefore=null;notificationPage=null;renderNotifications();});
$('notification-older').addEventListener('click',()=>{const data=notificationBefore===null?state.notifications:notificationPage;if(data?.nextCursor)void loadNotificationPage(data.nextCursor);});
const feishuEdited=()=>{feishuDirty=true;feishuRevision++;feishuFeedback=null;renderFeishu();};
$('feishu-form').addEventListener('input',feishuEdited);$('feishu-form').addEventListener('change',feishuEdited);
$('feishu-add-recipient').addEventListener('click',()=>{addFeishuRecipient();feishuEdited();});
$('feishu-add-admin').addEventListener('click',()=>{addFeishuRecipient(undefined,'feishu-admin-recipients');feishuEdited();});
$('feishu-form').addEventListener('click',event=>{const button=event.target.closest('[data-feishu-remove]');if(button){button.closest('.recipient-row').remove();feishuEdited();}});
$('feishu-form').addEventListener('submit',async event=>{
 event.preventDefault();if(feishuSubmitting)return;const revision=feishuRevision;
 const body={appId:$('feishu-app-id').value,appSecret:$('feishu-app-secret').value,enabled:$('feishu-enabled').checked,recipients:[...$('feishu-recipients').children].map(row=>({name:row.querySelector('[data-recipient-name]').value,type:row.querySelector('[data-recipient-type]').value,receiveId:row.querySelector('[data-recipient-id]').value,enabled:row.querySelector('[data-recipient-enabled]').checked})),adminEnabled:$('feishu-admin-enabled').checked,adminRecipients:[...$('feishu-admin-recipients').children].map(row=>({name:row.querySelector('[data-recipient-name]').value,type:row.querySelector('[data-recipient-type]').value,receiveId:row.querySelector('[data-recipient-id]').value,enabled:row.querySelector('[data-recipient-enabled]').checked}))};
 $('feishu-app-secret').value='';feishuSubmitting=true;feishuOperation='save';renderFeishu();
 try{const result=await post('/api/feishu/settings',body);if(revision===feishuRevision){feishuDirty=false;feishuSnapshot='';}feishuFeedback={text:result.message,error:false};await refresh();}
 catch(error){feishuFeedback={text:error.message,error:true};}finally{feishuSubmitting=false;renderFeishu();}
});
$('feishu-validate').addEventListener('click',async()=>{if(feishuDirty||feishuSubmitting)return;feishuSubmitting=true;feishuOperation='validate';renderFeishu();try{const result=await post('/api/feishu/validate');feishuFeedback={text:result.message,error:false};await refresh();}catch(error){feishuFeedback={text:error.message,error:true};}finally{feishuSubmitting=false;renderFeishu();}});
$('policy-form').addEventListener('change',()=>{policyDirty=true;policyRevision++;renderPolicy();});
$('policy-form').addEventListener('submit',async e=>{e.preventDefault();if(policySaving)return;policySaving=true;const revision=policyRevision;$('policy-save').disabled=true;$('policy-save').textContent='正在保存…';try{await post('/api/policy',{lookahead:$('lookahead').value,intervalMinutes:Number($('interval').value)});if(revision===policyRevision)policyDirty=false;message('监测偏好已保存，日期每天自动顺延。');}catch(e){message(e.message,true);}finally{policySaving=false;$('policy-save').disabled=false;$('policy-save').textContent='保存偏好';await refresh();}});
$('pause-all').addEventListener('click',async()=>{for(const p of state.providers)await action(p.id,'pause');});
$('scan-all').addEventListener('click',async()=>{if(!state||scanning)return;scanning=true;render();try{for(const p of state.providers.filter(x=>x.mode==='AUTOMATION'&&!x.busy&&!pending.has(x.id)))await action(p.id,'scan');}finally{scanning=false;render();}});
document.querySelector('.tabs').addEventListener('keydown',event=>{
 const keys=['ArrowLeft','ArrowRight','Home','End'];if(!keys.includes(event.key))return;
 const tabs=[...document.querySelectorAll('[role=tab]')];const current=tabs.indexOf(event.target);if(current<0)return;
 event.preventDefault();const index=event.key==='Home'?0:event.key==='End'?tabs.length-1:(current+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;setView(tabs[index].dataset.view,true);
});
window.addEventListener('hashchange',()=>setView(location.hash.slice(1)||'calendar'));
setView(location.hash.slice(1)||'calendar');
void refresh();setInterval(refresh,3000);

// Report activity only, never field contents. Polling is not user activity.
let activityTimer,lastActivityReport=0;
const reportManualActivity=()=>{if(!token||!state?.providers.some(row=>row.mode==='MANUAL_CONTROL'))return;lastActivityReport=Date.now();void post('/api/activity').catch(()=>{});};
for(const kind of ['pointerdown','keydown','input','change','wheel','touchstart'])document.addEventListener(kind,event=>{if(!event.isTrusted||!state?.providers.some(row=>row.mode==='MANUAL_CONTROL'))return;clearTimeout(activityTimer);if(Date.now()-lastActivityReport>=5000)reportManualActivity();else activityTimer=setTimeout(reportManualActivity,5000-(Date.now()-lastActivityReport));},{capture:true,passive:true});
