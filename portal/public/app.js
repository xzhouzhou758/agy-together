(()=>{
'use strict';

/* ============ 图标（内联 SVG，参考 Lucide，ISC 许可） ============ */
const ICONS={
  menu:'<path d="M4 7h16M4 12h16M4 17h16"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon:'<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  home:'<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  key:'<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  pot:'<path d="M2 12h20"/><path d="M20 12v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8"/><path d="m4 8 16-4"/><path d="m8.86 6.78-.45-1.81a2 2 0 0 1 1.45-2.43l1.94-.48a2 2 0 0 1 2.43 1.46l.45 1.8"/>',
  terminal:'<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  activity:'<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  user:'<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  users:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  plus:'<path d="M5 12h14"/><path d="M12 5v14"/>',
  x:'<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  check:'<path d="M20 6 9 17l-5-5"/>',
  copy:'<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  shield:'<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  lock:'<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  upload:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  chev:'<path d="m6 9 6 6 6-6"/>',
  sliders:'<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M2 14h4"/><path d="M10 8h4"/><path d="M18 16h4"/>',
  layers:'<path d="m12 2 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  ext:'<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  alert:'<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  refresh:'<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  arrow:'<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  trash:'<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  heart:'<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  logout:'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  wifi:'<path d="M12 20h.01"/><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M5 12.86a10 10 0 0 1 14 0"/><path d="M8.5 16.43a5 5 0 0 1 7 0"/>',
  chart:'<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  globe:'<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 0 20 15.3 15.3 0 0 1 0-20"/>',
  bell:'<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  search:'<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  info:'<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  download:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  play:'<path d="M6 4l14 8-14 8z"/>',
  spark:'<path d="M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9z"/><path d="M19 3v4M17 5h4"/>',
  window:'<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 9h20"/><path d="M6 6.5h.01M9 6.5h.01"/>',
  pen:'<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
};
const DISCORD='<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.32 4.37a19.8 19.8 0 0 0-4.89-1.52.07.07 0 0 0-.08.04c-.21.38-.44.87-.6 1.25a18.3 18.3 0 0 0-5.49 0 12.6 12.6 0 0 0-.62-1.25.08.08 0 0 0-.08-.04 19.7 19.7 0 0 0-4.88 1.52.07.07 0 0 0-.03.03C.53 9.05-.32 13.58.1 18.06a.08.08 0 0 0 .03.05 19.9 19.9 0 0 0 5.99 3.03.08.08 0 0 0 .09-.03c.46-.63.87-1.3 1.22-1.99a.08.08 0 0 0-.04-.1 13.1 13.1 0 0 1-1.87-.9.08.08 0 0 1-.01-.12l.37-.3a.07.07 0 0 1 .08-.01c3.93 1.8 8.18 1.8 12.06 0a.07.07 0 0 1 .08 0l.37.3a.08.08 0 0 1 0 .13c-.6.35-1.22.65-1.88.9a.08.08 0 0 0-.04.1c.36.7.77 1.36 1.23 1.99a.08.08 0 0 0 .08.03 19.8 19.8 0 0 0 6-3.03.08.08 0 0 0 .03-.05c.5-5.18-.84-9.68-3.55-13.66a.06.06 0 0 0-.03-.03ZM8.02 15.33c-1.18 0-2.16-1.08-2.16-2.42 0-1.33.96-2.42 2.16-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.34-.96 2.42-2.16 2.42Zm7.97 0c-1.18 0-2.15-1.08-2.15-2.42 0-1.33.95-2.42 2.15-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.34-.94 2.42-2.16 2.42Z"/></svg>';
const ic=n=>`<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]||''}</svg>`;

/* ============ 工具 ============ */
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>[...r.querySelectorAll(s)];
const POOL={private:'小锅饭',shared:'大锅饭'};
const poolTag=p=>`<span class="pool ${p}">${ic(p==='private'?'lock':'users')}${POOL[p]}</span>`;
const level=q=>q>=40?'':q>=15?'mid':'low';
const pad=n=>String(n).padStart(2,'0');
function hms(ts){const d=new Date(ts);return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;}
function mdhm(ts){const d=new Date(ts);return `${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;}
function ago(ts){if(!ts)return '—';const s=Math.max(0,(Date.now()-ts)/1000);if(s<60)return '刚刚';if(s<3600)return Math.floor(s/60)+' 分钟前';if(s<86400)return Math.floor(s/3600)+' 小时前';return Math.floor(s/86400)+' 天前';}
function until(iso){if(!iso)return '—';const s=(Date.parse(iso)-Date.now())/1000;if(!(s>0))return '0m';const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return d?`${d}d ${h}h`:h?`${h}h ${m}m`:`${m}m`;}
function tierName(t){if(!t)return '';const x=t.toLowerCase();return x.includes('ultra')?'Ultra':x.includes('pro')?'Pro':'Free';} // enterprise / standard 也算 Free
const ULTRA_GEM='<svg class="gem" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3h11l4.5 6-10 12L2 9z" fill="currentColor" opacity=".35"/><path d="M6.5 3h11l4.5 6-10 12L2 9zM2 9h20M9 3l3 6 3-6M12 21 9 9m6 0-3 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
function tierTag(t,extra=''){if(!t)return '';const k=t.toLowerCase();return `<span class="tier ${esc(k)}">${k==='ultra'?ULTRA_GEM:''}${esc(t)}${extra}</span>`;}
function fmtTok(n){return tk(n);}
const RESULT={ok:['good','成功'],quota:['warn','额度不足'],no_account:['warn','无可用账号'],no_model:['warn','模型不支持'],upstream:['bad','上游错误'],blocked:['bad','已拦截'],rate_limited:['warn','限流'],daily_limit:['warn','次数用完'],input_limit:['warn','输入过限'],client:['warn','请求错误']};
const ROT=[['cache','缓存优先','同一会话尽量留在同一个号上，号短暂不可用时临时借用别的号，恢复后回来'],['balance','平衡轮换','同一会话固定一个号，号不可用就换一个并固定下来'],['performance','性能优先','每次请求都换最久没用的号，不固定']];
const ERR={
  state:'登录已过期，请重试',denied:'已取消授权',not_in_guild:'不在指定的 Discord 服务器',missing_role:'缺少所需的身份组',disabled:'账号已停用',
  discord_not_configured:'登录尚未配置',bad_credentials:'用户名或密码错误',too_many_attempts:'尝试次数过多，请稍后再试',invalid_username:'用户名需 3–32 位字母、数字或 _ . -',weak_password:'密码至少 8 位',username_taken:'用户名已存在',discord_api:'Discord 暂时无法连接',invalid_url:'地址无效，需以 http:// 或 https:// 开头',invalid_key:'填 API Key',token:'Discord 授权失败',user:'无法读取 Discord 账号',code:'Discord 授权失败',
};

/* ============ 状态 ============ */
let cfg={},me=null,page='home';
let D={};               // 页面数据
let ui={admTab:(()=>{try{return localStorage.getItem('agy-admtab')||'ov'}catch(e){return 'ov'}})(),st:{view:'overview',range:'7d',scope:''},logView:'mine',addTab:'oauth',tr:{page:1,size:50,q:'',account:'',user:'',family:'',pool:'',err:false,auto:false}};
let flow=null;          // 添加凭证流程
let lastFocus=null;
/* 管理员切到普通用户视角看界面（只影响自己这个浏览器） */
const viewAsUser=()=>{try{return localStorage.getItem('agy-viewas')==='user';}catch(e){return false;}};
async function toggleViewAs(){
  try{viewAsUser()?localStorage.removeItem('agy-viewas'):localStorage.setItem('agy-viewas','user');}catch(e){}
  me=await api('GET','api/me');page='home';await load('home');
}
const viewAsBtn=()=>me?.realRole==='admin'?`<button class="btn sm ${me.role==='admin'?'ghost':'view-user'}" data-act="viewas" title="切换管理员 / 普通用户界面">${ic(me.role==='admin'?'shield':'user')}${me.role==='admin'?'管理员':'用户视角'}</button>`:'';

async function api(method,path,body,raw){
  const opt={method,headers:{},credentials:'same-origin'};
  if(method!=='GET')opt.headers['X-Portal-CSRF']='1';
  if(viewAsUser())opt.headers['X-View-As']='user';
  if(raw!==undefined){opt.body=raw;opt.headers['Content-Type']='application/octet-stream';}
  else if(body!==undefined){opt.body=JSON.stringify(body);opt.headers['Content-Type']='application/json';}
  const r=await fetch(path,opt);
  let d=null;try{d=await r.json();}catch(e){}
  if(r.status===401&&path!=='api/me'){me=null;render();}
  if(!r.ok){const e=new Error(d?.error||('http_'+r.status));e.code=d?.error;e.detail=d?.message;e.status=r.status;throw e;}
  return d;
}
const fail=e=>toast(errText(e),true);
function errText(e){
  const m={duplicate:'账号已存在',proxy_in_use:'出口已被占用',invalid_proxy:'代理地址无效',too_soon:'刷新太频繁',too_many_keys:'密钥数量已达上限',
    callback_rejected:'回调地址无效',state_mismatch:'回调地址与授权链接不匹配',invalid_callback:'回调地址无效',too_many_pending:'进行中的授权太多',
    cpa_unreachable:'后端暂时不可用',invalid_zip:'ZIP 无法读取',empty_zip:'ZIP 里没有 JSON',csrf:'请求被拒绝',forbidden:'没有权限',invalid_url:'链接需以 http:// 或 https:// 开头',invalid_shops:'链接太多',invalid_sf_key:'Key 格式不对',invalid_sf_base:'接口地址要像 https://api.siliconflow.cn',invalid_sf_rpm:'限速填 0 以上的整数',invalid_sf_models:'模型名称或类型不对',invalid_channel_id:'频道 ID 应为数字',invalid_public_key:'Public Key 应为 64 位十六进制',invalid_daily_hour:'日报时间无效',bad_token:'Bot Token 无效',endpoint_rejected:'Discord 没有接受这个地址，确认站点地址能从外网打开',no_public_url:'先在「Discord 登录」里填站点地址',bot_post_failed:'发送失败：确认机器人能在这个频道发言',discord_api:'Discord 暂时无法连接'};
  return m[e?.code]||m[e?.message]||ERR[e?.code]||ERR[e?.message]||'操作失败';
}

/* ============ 额度片段（圆环版，照 agy-me） ============ */
/* 重置时间已过的窗口按已恢复显示 */
const live=b=>b&&b.reset&&Date.parse(b.reset)<=Date.now()?{...b,frac:1,reset:null}:b;
const winP=b=>{b=live(b);return b?{p:Math.round(b.frac*100),r:short(b.reset)}:null;};
const TOKF=new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:1});
const tokS=n=>Number.isFinite(n)&&n>0?TOKF.format(n):'—';
const QIC={gemini:'icons/gemini.svg',claude:'icons/claude.svg'};
const lvq=p=>p>=40?'good':p>=15?'mid':'low';
function arcC(r,p){const t=`<circle class="tr" cx="22" cy="22" r="${r}"/>`;return p>0?t+`<circle class="${lvq(p)}" cx="22" cy="22" r="${r}" pathLength="100" stroke-dasharray="${p} 100"/>`:t;}
function qLine(lab,b){const x=winP(b);return `<div class="aq-ln"><span class="w">${lab}</span><b class="${x?lvq(x.p):'na'}" title="剩余额度">${x?`${x.p}<small>%</small>`:'—'}</b><span class="t" title="${lab} 重置时间">${x?'↻ '+esc(x.r||'—'):''}</span></div>`;}
/* 一个模型一格：外圈 5H，内圈 7D；f=null 是未开通 */
function gauge(name,icon,f,used){
  const img=`<img src="${QIC[icon]}" alt="">`;
  if(!f)return `<div class="aq-q off"><div class="aq-ring one"><svg aria-hidden="true" viewBox="0 0 44 44">${arcC(19,0)}</svg>${img}</div><div class="aq-qb"><div class="aq-qn">${name}</div><div class="aq-off">未开通配额</div></div></div>`;
  const ws=[f.h5,f.week].map(winP).filter(Boolean);
  return `<div class="aq-q"><div class="aq-ring ${ws.length>1?'':'one'}"><svg aria-hidden="true" viewBox="0 0 44 44">${(ws.length?ws:[{p:0}]).map((x,i)=>arcC(i?13.6:19,x.p)).join('')}</svg>${img}</div>
    <div class="aq-qb"><div class="aq-qn">${name}</div><div class="aq-windows">${qLine('5H',f.h5)}${qLine('7D',f.week)}</div>
    <div class="aq-ln usage"><span class="w">已用</span><span class="amounts" title="依次为 5H 和 7D 已用量">${tokS(used?.h5)} / ${tokS(used?.week)}</span></div></div></div>`;
}
/* 四格：Gemini 3.8、Claude 5.5（或 4.6）/ GPT、Gemini 4 Argon、Gemini 4 Carbon；已用量取门户自己记的 Token */
function quotaSlots(a){
  const q=a.quota,F=q.fams||{},u=a.tokens?.fam||{},none={h5:null,week:null};
  return [['Gemini 3.8','gemini',F.gemini||none,u.gemini],[`Claude ${q.claude55?'5.5':'4.6'} / GPT`,'claude',F.claude||none,u.claude],
    ['Gemini 4 Argon','gemini',F.argon||null,u.argon],['Gemini 4 Carbon','gemini',F.carbon||null,u.carbon]];
}
function quotaBlock(a,cls=''){
  const q=a.quota;
  if(a.forbidden)return `<div class="aq-ban"><div class="aq-ban-l"><span class="aq-ban-ico"><span class="aq-lock"></span></span><div class="aq-ban-txt"><span>账号访问受限 (HTTP 403)</span><span class="aq-ban-sub">查看上游返回的错误详情</span></div></div><button type="button" data-act="reason:${esc(a.id)}">查看原因</button></div>`;
  if(!q)return `<div class="aq-none">${a.quotaErr?'额度读取失败':'暂无模型额度遥测数据'}</div>`;
  return `<div class="aq-quota ${cls}">${quotaSlots(a).map(x=>gauge(...x)).join('')}</div>`;
}
/* 状态标签：不正常的点开看原因 */
function stInfo(a){
  if(a.problem)return ['bad',a.forbidden?'403 异常':a.problem.label];
  if(a.state==='error')return ['bad',a.forbidden?'403 异常':'报错'];
  if(a.state==='cooldown')return ['warn','冷却中'];
  if(a.state==='off')return ['off',a.asleep?'休眠中':'已停用'];
  if(a.forbidden)return ['bad','403 异常'];
  return ['','正常'];
}
function stTag(a){
  const [c,t]=stInfo(a),why=c&&c!=='off'||a.autoOff||a.action;
  const n=modelCds(a).length,cd=n&&!c?`<button type="button" class="aq-st warn" data-act="reason:${esc(a.id)}" title="查看原因">${n} 个模型冷却</button>`:'';
  return (why?`<button type="button" class="aq-st ${c}" data-act="reason:${esc(a.id)}" title="查看原因">${esc(t)}</button>`:`<span class="aq-st ${c}">${esc(t)}</span>`)+cd;
}
/* 档位徽章：发光胶囊 */
function gbTag(t){const n=tierName(t);if(!n)return '';const k=n.toLowerCase();return `<span class="gb ${esc(k)} sm"><span class="gb-aura"></span><span class="gb-pill"><span class="gb-beam"></span><span class="gb-t">${esc(n)}</span></span></span>`;}
function accState(a){
  if(a.state==='off')return a.asleep?['sleep','休眠中','闲置超过 1 小时自动关闭，下次请求会自动唤醒']:['','已停用'];
  if(a.state==='cooldown')return ['warn','冷却中',[a.detail||a.reason,a.retryAt?recover(a.retryAt):''].filter(Boolean).join(' · ')];
  if(a.state==='error')return ['bad','报错',a.detail||a.reason||''];
  return ['good','正常'];
}
/* 出错 / 冷却的细节：翻译后的原因、逐模型冷却、Google 给的验证 / 申诉链接 */
function recover(iso){const ms=Date.parse(iso)-Date.now();if(!(ms>0))return '即将恢复';const n=Math.max(1,Math.ceil(ms/6e4)),d=Math.floor(n/1440),h=Math.floor(n%1440/60),m=n%60;
  return (d?`${d} 天 ${h} 小时`:h?`${h} 小时${m?` ${m} 分钟`:''}`:`${m} 分钟`)+'后恢复';}
const ACT={verify:'去验证',appeal:'去申诉'};
const modelCds=a=>(a.cooldowns||[]).filter(c=>c.scope==='model'&&c.model);
function cdList(a){
  const L=modelCds(a);if(!L.length)return '';
  return `<ul class="cdl">${L.map(c=>`<li><b class="mono" title="${esc(c.model)}">${esc(c.model)}</b><span>${esc([c.text,c.status&&!String(c.text).includes(c.status)?c.status:''].filter(Boolean).join(' · '))}</span><i>${esc(recover(c.retryAt))}</i></li>`).join('')}</ul>`;
}
function fixBtns(a){
  if(!a.action?.url)return '';
  return `<span class="fix"><a class="btn sm primary" href="${esc(a.action.url)}" target="_blank" rel="noopener noreferrer">${ic('ext')}${ACT[a.action.kind]||ACT.verify}</a>${cfg.browserEnabled&&D.accounts?.some(x=>x.id===a.id)?`<button class="btn sm" data-act="bropen:${esc(a.id)}">${ic('window')}用内置浏览器打开</button>`:''}<button class="btn sm ghost icon" data-act="copyurl:${esc(a.id)}" aria-label="复制链接" title="复制链接">${ic('copy')}</button></span>`;
}
const fmtK=n=>{n=Number(n)||0;return n>=1e9?(n/1e9).toFixed(n>=1e10?0:1)+'B':n>=1e6?(n/1e6).toFixed(n>=1e7?0:1)+'M':n>=1e3?(n/1e3).toFixed(n>=1e4?0:1)+'K':String(n);};
function short(iso){if(!iso)return '';const ms=Date.parse(iso)-Date.now();if(!(ms>0))return 'now';const n=Math.ceil(ms/6e4),d=Math.floor(n/1440),h=Math.floor(n%1440/60),m=n%60;return d?`${d}d ${h}h`:h?`${h}h ${m}m`:`${m}m`;}
function dur(iso){if(!iso)return '';const ms=Date.parse(iso)-Date.now();if(!(ms>0))return '可刷新';const n=Math.max(1,Math.ceil(ms/6e4)),d=Math.floor(n/1440),h=Math.floor(n%1440/60),m=n%60;
  return (d?`${d} 天 ${h} 小时`:h?`${h} 小时 ${m} 分钟`:`${m} 分钟`)+'后刷新';}
const stateChip=a=>{const [k,t,r]=accState(a);return `<span class="chip ${k}"${r?` title="${esc(r)}"`:''}><span class="dot"></span>${t}</span>`;};

/* ============ 通用片段 ============ */
function head(title,actions=''){return `<div class="head"><div><h1>${title}</h1></div>${actions?`<div class="hstack">${actions}</div>`:''}</div>`;}
function empty(icon,title,action=''){return `<div class="empty"><div class="bubble">${ic(icon)}</div><h2>${title}</h2>${action}</div>`;}
function poolPicker(name,selected){
  return `<div class="pools" role="radiogroup" aria-label="账号池">
    <label class="pool-opt"><input type="radio" name="${name}" value="private" ${selected==='private'?'checked':''}><span class="box"><b>${ic('lock')} 小锅饭</b><small>只用自己的账号</small></span></label>
    <label class="pool-opt"><input type="radio" name="${name}" value="shared" ${selected==='shared'?'checked':''}><span class="box"><b>${ic('users')} 大锅饭</b><small>用朋友共享的账号</small></span></label>
  </div>`;
}
const reserveText=v=>v?v+'%':'不保留';
const accName=a=>a.name||a.email||'—';
const baseURL=()=>me?.baseURL&&me.baseURL!=='/v1'?me.baseURL:new URL('v1',location.href).href;

/* ============ 页面 ============ */
const PAGES=[
  ['home','home','仪表盘','仪表盘'],
  ['accounts','key','我的凭证','凭证'],
  ['pool','pot','大锅饭 / 小锅饭','大小锅饭'],
  ['keys','terminal','API 密钥','API 密钥'],
  ['logs','activity','流量日志','日志'],
  ['stats','chart','Token 统计','统计'],
  ['browser','window','浏览器','浏览器'],
  ['profile','user','个人中心','我的'],
  ['users','users','用户管理','用户'],
  ['admin','shield','管理员后台','后台'],
];
const navBtns=(full)=>navPages().map(([id,icon,long,short])=>`<button type="button" data-act="goto:${id}" aria-current="${page===id?'page':'false'}" title="${long}">${ic(icon)}<span>${full?long:short}</span></button>`).join('');
const navPages=()=>PAGES.filter(p=>p[0]==='browser'?!!cfg.browserEnabled:(p[0]!=='admin'&&p[0]!=='users')||me?.role==='admin');

const LOADERS={
  home:async()=>{D.ov=await api('GET','api/overview');},
  accounts:async()=>{[D.accounts,D.rules]=await Promise.all([api('GET','api/accounts'),api('GET','api/rules')]);},
  pool:async()=>{[D.pool,D.rules,D.res]=await Promise.all([api('GET','api/pool/summary'),api('GET','api/rules'),api('GET','api/pool/resources').catch(()=>null)]);},
  keys:async()=>{D.keys=await api('GET','api/keys');},
  logs:async()=>{
    if(ui.logView==='mine')D.traffic=await api('GET','api/traffic?'+trafficQS());
    else D.contrib=await api('GET','api/usage/contributions');
  },
  stats:async()=>{const st=ui.st;if(!st.scope)st.scope=me.role==='admin'?'all':'mine';
    D.stats=await api('GET','api/stats?'+new URLSearchParams({range:st.range,scope:st.scope,tz:-new Date().getTimezoneOffset()}));},
  browser:async()=>{brSet(await api('GET','api/browser'));},
  profile:async()=>{},
  users:async()=>{const [users,rules]=await Promise.all([api('GET','api/admin/users'),api('GET','api/rules')]);D.admin={...(D.admin||{}),users,rules};},
  admin:async()=>{
    const [usage,users,accounts,proxies,shops,upstreams,rules,site,retry]=await Promise.all(['usage','users','accounts','proxies','shops','upstreams'].map(x=>api('GET','api/admin/'+x)).concat([api('GET','api/rules'),api('GET','api/admin/site'),api('GET','api/admin/retry').catch(()=>null)]));
    D.admin={usage,users,accounts,proxies,shops,upstreams,rules,site,retry,bot:await api('GET','api/admin/bot').catch(()=>null),botchat:await api('GET','api/admin/botchat').catch(()=>null),kb:await api('GET','api/admin/kb').catch(()=>[]),sharedAllow:(await api('GET','api/admin/shared-models').catch(()=>({allow:null}))).allow,res:await api('GET','api/pool/resources').catch(()=>null),stock:await api('GET','api/admin/stock').catch(()=>null),sw:await api('GET','api/admin/switches').catch(()=>({mentions:true,proactive:false,stockOnly:false,shops:true})),br:cfg.browserEnabled?await api('GET','api/admin/browser').catch(()=>null):null,sf:await api('GET','api/admin/sf').catch(()=>null)};
  },
};

function dailyCard(d){
  if(!d)return '';
  const unl=d.limit==null,p=unl?0:Math.min(100,Math.round(d.used/Math.max(1,d.limit)*100)),lv=p>=90?'low':p>=70?'mid':'';
  const how=d.override!=null?(unl?'不限次数':'管理员单独设置'):unl?'不限次数':`${d.base} + ${d.per} × ${d.valid} 个共享 Pro 号 · 0 点重置`;
  return `<section class="card glass daily"><div class="dl-h"><div><h2>今日大锅饭次数</h2><p>${how}</p></div>
    <div class="dl-n"><b class="mono">${d.used.toLocaleString()}</b><span>/ ${unl?'∞':d.limit.toLocaleString()}</span></div></div>
    ${unl?'':`<div class="meter ${lv}"><span style="width:${Math.max(p,1)}%"></span></div>`}
    ${!unl&&d.override==null?`<small class="faint">共享一个 Pro 号，每天多 ${d.per} 次</small>`:''}</section>`;
}
/* ============ 仪表盘（照 agy-me pageDash）：普通用户看自己的凭证，管理员看全部 ============ */
const DST={ok:['good','正常'],cooldown:['warn','冷却'],banned:['bad','报错'],disabled:['','停用']};
/* 额度族卡片：和凭证页同一套圆环（外圈 5H 平均，内圈 7D 平均） */
function famCard(k,name,icon){
  const F=D.ov.dash.fam[k]||{total:0},tot=F.total,pc=v=>v==null?null:Math.round(v*100);
  const h=pc(F.h5),w=pc(F.week),ws=[h,w].filter(x=>x!=null);
  const ring=`<div class="aq-ring fcq-ring ${ws.length>1?'':'one'}"><svg viewBox="0 0 44 44" aria-hidden="true">${(ws.length?ws:[0]).map((p,i)=>arcC(i?13.6:19,p)).join('')}</svg><img src="${QIC[icon]}" alt=""></div>`;
  const ln=(lab,p)=>`<div class="aq-ln"><span class="w">${lab}</span><b class="${p==null?'na':lvq(p)}">${p==null?'—':p+'<small>%</small>'}</b></div>`;
  const back=tot&&F.withQuota<tot&&F.earliest?`<span class="fc-back" title="${esc(new Date(F.earliest).toLocaleString())}">↻ ${esc(short(F.earliest)||'即将')}</span>`:'';
  return `<section class="stat glass fcq ${tot?'':'off'}"><div class="fcq-n">${name}${back}</div>
    <div class="fcq-b">${ring}${tot?`<div class="fcq-m"><div class="num">${F.withQuota}<small>/ ${tot}</small></div><div class="aq-windows">${ln('5H',h)}${ln('7D',w)}</div></div>`:`<div class="fcq-m"><div class="aq-off">未开通配额</div></div>`}</div></section>`;
}
const hv=p=>p>=80?'':p>=50?'mid':'low';
function healthCard(){
  const n=D.ov.dash.counts,usable=n.total-n.disabled,p=usable?Math.round(n.ok/usable*100):null;
  return `<section class="stat glass fc"><div class="fc-h">${ic('shield')}<span>账号健康</span></div>
    ${p==null?`<div class="num faint">—</div>`:`<div class="num">${n.ok}<small>/ ${usable}</small></div>
    <div class="meter ${hv(p)}"><span style="width:${Math.max(p,1)}%"></span></div>`}
    <div class="legend">${['ok','cooldown','banned','disabled'].map(s=>`<span><i class="sdot ${DST[s][0]}"></i>${DST[s][1]} <b>${n[s]}</b></span>`).join('')}</div></section>`;
}
function riskCard(){
  const L=D.ov.dash.dots;
  return `<section class="card glass"><div class="card-head"><h2>风控</h2><div class="legend">${['ok','cooldown','banned','disabled'].map(s=>`<span><i class="sdot ${DST[s][0]}"></i>${DST[s][1]}</span>`).join('')}</div></div>
    ${L.length?`<div class="dots">${L.map(d=>{const t=esc(d.email+(d.reason?' · '+d.reason:''));return d.mine?`<button class="rdot ${d.status}" data-act="jump:${esc(d.id)}" title="${t}" aria-label="${esc(d.email)} ${DST[d.status][1]}"></button>`:`<i class="rdot ${d.status}" title="${t}"></i>`;}).join('')}</div>`:'<p class="faint">还没有凭证</p>'}</section>`;
}
function recentCard(){
  const R=D.ov.dash.recent;
  const T=R.filter(r=>!r.failed&&r.ttft).map(r=>r.ttft),top=T.length?Math.max(...T):null,max=Math.max(1000,top||0);
  const bars=R.map(r=>{const h=r.failed?100:Math.max(6,Math.round((r.ttft||0)/max*100));
    const tip=[`${mdhm(r.ts)}:${pad(new Date(r.ts).getSeconds())}`,r.account,r.model,r.failed?`${r.status} · ${r.error}`:`首字 ${sec(r.ttft)} · 耗时 ${sec(r.latency)}`].filter(Boolean).join('\n');
    return `<i class="rb ${r.failed?'bad':''}" style="height:${h}%" title="${esc(tip)}"></i>`;}).join('');
  const ok=R.filter(r=>!r.failed).length;
  return `<section class="card glass"><div class="card-head"><h2>最近请求</h2><small class="faint">${R.length?`${ok}/${R.length} 成功${top!=null?` · 最高 ${sec(top)}`:''}`:''}</small></div>
    ${R.length?`<div class="rbars" role="img" aria-label="最近 ${R.length} 次请求的首字时间">${bars}</div>`:'<p class="faint">还没有请求</p>'}</section>`;
}
function dashTop(){
  const X=D.ov.dash;if(!X)return '';
  return `<div class="grid g4">${famCard('gemini','Gemini 3.8','gemini')}${famCard('claude','Claude / GPT','claude')}${famCard('argon','Gemini 4 Argon','gemini')}${famCard('carbon','Gemini 4 Carbon','gemini')}</div>
  <div class="grid dash-2">${healthCard()}${riskCard()}</div>
  ${recentCard()}`;
}
function pageHome(){
  const o=D.ov,n=o.dash?.counts;
  const noacc=o.accounts===0;
  const nums=n?`<div class="dnums"><div><small>总账号</small><b>${n.total}</b></div><div><small>可用</small><b class="good-t">${n.ok}</b></div><div><small>正常率</small><b>${n.total-n.disabled?`${Math.round(n.ok/(n.total-n.disabled)*100)}<small>%</small>`:'—'}</b></div></div>`:'';
  return head('仪表盘',`${nums}<button class="btn" data-act="goto:keys">${ic('terminal')}获取 API 密钥</button><button class="btn primary" data-act="add">${ic('plus')}添加凭证</button>`)+annBanner()+dashTop()+
  (noacc?`<div class="card glass">${empty('key','还没有凭证',`<button class="btn primary" data-act="add">${ic('plus')}添加第一个凭证</button>`)}</div>`:'')+
  `<div class="grid g4 ${noacc?'mt-l':''}">
    <div class="stat glass mine"><div class="label">${ic('key')}我的账号</div><div class="num">${o.accounts}</div><small>${o.enabled} 个已启用</small></div>
    <div class="stat glass give"><div class="label">${ic('heart')}我贡献的账号</div><div class="num">${o.shared.length}</div></div>
    <div class="stat glass mine"><div class="label">${ic('activity')}我发起的请求 · 今日</div><div class="num">${o.today.private+o.today.shared}</div><small>小锅饭 ${o.today.private} · 大锅饭 ${o.today.shared}</small></div>
    <div class="stat glass give"><div class="label">${ic('users')}我的账号服务他人 · 今日</div><div class="num">${o.servedToday}</div></div>
  </div>
  ${dailyCard(o.daily)}
  <section class="card glass"><div class="card-head"><div><h2>账号轮换</h2><p>${esc((ROT.find(x=>x[0]===me.rotation)||ROT[1])[2])}</p></div></div>
    <div class="row"><div class="seg" role="radiogroup" aria-label="账号轮换">${ROT.map(([v,l])=>`<label><input type="radio" name="rotation" value="${v}" ${me.rotation===v?'checked':''}><span>${l}</span></label>`).join('')}</div>
    <button class="btn sm" data-act="resetsess">清除会话绑定</button></div></section>
  <div class="grid g2">
    <section class="card glass">
      <div class="card-head"><h2>新建密钥默认用</h2></div>
      ${poolPicker('defaultPool',me.defaultPool)}
      <div class="mt-l"><button class="btn primary" data-act="newkey">${ic('plus')}创建 API 密钥</button></div>
    </section>
    <section class="card glass">
      <div class="card-head"><h2>我的分享</h2><button class="btn sm" data-act="goto:accounts">管理</button></div>
      ${o.shared.length?o.shared.map(a=>`<div class="row" style="padding:8px 0"><div class="hstack"><strong>${esc(accName(a))}</strong>${poolTag('shared')}</div><small>今日 ${a.today} 次</small></div>`).join(''):
        `<p class="dim" style="padding:8px 0">暂未共享</p>`}
    </section>
  </div>
  ${o.shops?.length?`<section class="card glass">
    <div class="card-head"><div><h2>买号渠道</h2><p>谨慎购买，炸了不管</p></div></div>
    <div class="shops">${o.shops.map(s=>`<a class="shop" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer"><span><strong>${esc(s.name)}</strong>${s.note?`<small>${esc(s.note)}</small>`:''}</span>${ic('ext')}</a>`).join('')}</div>
  </section>`:''}
  <section class="card glass">
    <div class="row"><div class="hstack" style="gap:14px"><div style="width:44px;height:44px;border-radius:14px;display:grid;place-items:center;background:rgba(217,70,143,.13);color:#d9468f">${ic('pot')}</div><div><h2>朋友共享池</h2><small>${o.pool.contributors} 位贡献者 · ${o.pool.accounts} 个账号</small></div></div>
    <button class="btn" data-act="goto:pool">查看规则${ic('arrow')}</button></div>
  </section>`;
}

// official marks (same files the CLIProxyAPI panel uses)
const GEM='<img class="qp-ic" src="icons/gemini.svg" alt="" aria-hidden="true">';
const CLA='<img class="qp-ic" src="icons/claude.svg" alt="" aria-hidden="true">';
const GPT='<span class="qp-ic gpt-ic" aria-hidden="true"><img class="lt" src="icons/openai.svg" alt=""><img class="dk" src="icons/openai-dark.svg" alt=""></span>';
/* 我的凭证：一个号一张卡 / 一行（圆环版） */
const lsGet=(k,d)=>{try{return localStorage.getItem(k)??d;}catch(e){return d;}};
const lsSet=(k,v)=>{try{localStorage.setItem(k,v);}catch(e){}};
const cssId=id=>String(id).replace(/[^A-Za-z0-9_-]/g,'_');
/* 旧的「完整 / 紧凑」= 现在的卡片 / 列表 */
const accView=()=>{const v=lsGet('agy-accview','card');return v==='compact'||v==='list'?'list':'card';};
ui.acc={page:1,size:+lsGet('agy-accsize','10')||10,sort:(s=>AF.QUOTA_SORTS.some(k=>s===k||s==='-'+k)?s:'')(lsGet('agy-accsort','')),focus:null};
const A_who=a=>`<div class="aq-who"><div class="aq-mail" title="${esc(a.email)}">${esc(a.email||a.id)}</div><div class="aq-meta">${gbTag(a.tier)}${stTag(a)}${a.shared?`<span class="aq-pool" title="自用保留 ${reserveText(a.reserve??D.rules?.reserve??30)}">大锅饭${a.reserve!=null?' · 留 '+reserveText(a.reserve):''}</span>`:''}${a.name?`<span class="aq-sep"></span><span title="备注">${esc(a.name)}</span>`:''}</div></div>`;
const A_acts=a=>`<button class="btn sm ghost icon" data-act="models:${esc(a.id)}" aria-label="模型" title="模型">${ic('layers')}</button><button class="btn sm ghost icon" data-act="refreshq:${esc(a.id)}" aria-label="刷新额度" title="刷新额度">${ic('refresh')}</button><button class="btn sm ghost icon" data-act="detail:${esc(a.id)}" aria-label="详情" title="详情">${ic('sliders')}</button>`;
const A_share=a=>`<button type="button" role="switch" class="aq-tog share" data-act="share:${esc(a.id)}" aria-label="${esc(accName(a))} 参与大锅饭" aria-checked="${!!a.shared}"><span>大锅饭</span><span class="aq-sw" aria-hidden="true"></span></button>`;
const A_tog=a=>`<button type="button" role="switch" class="aq-tog" data-act="toggle:${esc(a.id)}" aria-label="启用 ${esc(accName(a))}" aria-checked="${!!a.active}"><span>${a.active?'启用':'停用'}</span><span class="aq-sw" aria-hidden="true"></span></button>`;
const syncTxt=a=>a.quotaAt?esc(ago(a.quotaAt))+'同步':'未同步';
const accCard=a=>`<article class="aq-card aq-glass ${AF.tierOf(a.tier)==='ULTRA'?'aq-ultra':''} ${a.active?'':'off'}" id="acc-${cssId(a.id)}">
      <div><div class="aq-head">${A_who(a)}</div>${quotaBlock(a)}</div>
      <div class="aq-foot"><span class="aq-foot-l"><span class="aq-clock"></span><span>${syncTxt(a)}</span></span><span class="aq-act">${A_acts(a)}${A_share(a)}${A_tog(a)}</span></div></article>`;
const accRow=a=>`<div class="aq-row ${a.active?'':'off'}" id="acc-${cssId(a.id)}">${A_who(a)}${quotaBlock(a)}<span class="aq-act">${A_acts(a)}${A_share(a)}${A_tog(a)}</span></div>`;
/* 分页：当前页的号；跳到某个号时翻到它所在的页 */
const ACC_SIZES=[10,20,50,100];
const accSorted=()=>AF.sort(D.accounts||[],ui.acc.sort);
function pageList(){
  const L=accSorted(),n=ui.acc.size,pages=Math.max(1,Math.ceil(L.length/n));
  if(ui.acc.focus){const i=L.findIndex(a=>a.id===ui.acc.focus);if(i>=0)ui.acc.page=Math.floor(i/n)+1;}
  ui.acc.page=Math.min(Math.max(1,ui.acc.page|0),pages);
  return {L,P:L.slice((ui.acc.page-1)*n,ui.acc.page*n),pages};
}
function accPager(total,pages){
  const n=ui.acc.size,p=ui.acc.page,from=total?(p-1)*n+1:0,to=Math.min(total,p*n);
  return `<div class="pager aq-pager"><small class="faint">${from}–${to} / ${total}</small>
    <select class="select sm" data-accsize aria-label="每页显示">${ACC_SIZES.map(x=>`<option value="${x}" ${x===n?'selected':''}>${x} 个/页</option>`).join('')}</select>
    <button class="btn sm ghost" data-act="apg:${p-1}" ${p<=1?'disabled':''} aria-label="上一页">‹</button><span class="mono faint">${p} / ${pages}</span><button class="btn sm ghost" data-act="apg:${p+1}" ${p>=pages?'disabled':''} aria-label="下一页">›</button>
    <label class="aq-jump"><span>跳至</span><input class="input sm" type="number" min="1" max="${pages}" data-accjump value="${p}" aria-label="跳到第几页"><span>页</span></label></div>`;
}
/* 表头排序：只有「模型配额」一个；剩得多在前 → 剩得少在前 → 默认（导入时间） */
const SORT_LABEL=Object.fromEntries(AF.SORTS);
function sortBtns(keys){
  const cur=ui.acc.sort||'',d=cur.startsWith('-'),k=d?cur.slice(1):cur;
  return keys.map(x=>`<button type="button" class="sorth${x===k?' on':''}" data-act="asort:${x}" aria-label="按${SORT_LABEL[x]}排序"${x===k?` aria-sort="${d?'descending':'ascending'}"`:''}>${SORT_LABEL[x]}<i>${x===k?(d?'↓':'↑'):'⇅'}</i></button>`).join('');
}
let accIds='';
function accBody(){
  const {L:LL,P:L,pages}=pageList();accIds=L.map(a=>a.id).join('\n');
  const pg=accPager(LL.length,pages),QS=AF.QUOTA_SORTS;
  if(accView()==='card')return `<div class="acards-head"><span class="sorts">${sortBtns(QS)}</span></div><div class="aq-cards">${L.map(accCard).join('')}</div>${pg}`;
  return `<section class="aq-list aq-glass"><div class="aq-row th"><span class="aq-th-who"></span><span class="sorts aq-sorts">${sortBtns(QS)}</span><span></span></div>
    ${L.map(accRow).join('')}</section>${pg}`;
}
function refreshAcc(){const b=$('#acc-body');if(b)b.innerHTML=accBody();else render();}
/* 静默更新：只换内容变了的号；可见的号或顺序变了才整块重画 */
function patchAcc(prev){
  const b=$('#acc-body');if(page!=='accounts'||!b){render();return;}
  const {P:L}=pageList();
  if(L.map(a=>a.id).join('\n')!==accIds||!b.querySelector('.aq-card,.aq-row:not(.th)')){refreshAcc();return;}
  const old=new Map((prev||[]).map(a=>[a.id,JSON.stringify(a)])),f=accView()==='card'?accCard:accRow;
  for(const a of L){if(old.get(a.id)===JSON.stringify(a))continue;const el=document.getElementById('acc-'+cssId(a.id));if(el)el.outerHTML=f(a);}
}
setInterval(async()=>{
  if(!me||page!=='accounts'||loadState!=='idle'||dialogOpen()||document.visibilityState!=='visible')return;
  let r;try{r=await api('GET','api/accounts');}catch(e){return;}
  if(page!=='accounts'||dialogOpen()||!Array.isArray(r))return;
  const prev=D.accounts;D.accounts=r;patchAcc(prev);
},60000);
function sleepBar(){
  return `<span class="sleep-pill" title="闲置自动休眠">${ic('moon')}<span>闲置休眠</span><button class="switch" role="switch" aria-checked="${!!me.autoSleep}" aria-label="闲置自动休眠" data-act="autosleep"></button></span>`;
}
// 打开「闲置自动休眠」前的说明，样式同添加凭证前的提示
function sleepTipDialog(){
  document.body.insertAdjacentHTML('beforeend',`<div class="shade tip-shade" id="addtip" data-tipshade><section class="dialog tip-dlg" role="dialog" aria-modal="true" aria-labelledby="tip-t">
    <div class="dialog-head"><div><h2 id="tip-t">开启闲置自动休眠</h2></div><button class="btn icon ghost" data-act="tipclose" aria-label="关闭">${ic('x')}</button></div>
    <div class="atip"><b>${ic('moon')}怎么运作</b><ol><li>小锅饭的号超过 1 小时没被用，就自动关闭，显示「休眠中」；</li><li>你再发请求时，第一条会返回「凭证正在启动，请重试」，同时把号打开；</li><li>重新发一次就正常了。</li></ol></div>
    <div class="atip"><b>${ic('shield')}为什么要开</b><p>号闲着的时候不再被查额度、不会被拿去发请求，减少闲置期间和 Google 的往来，降低封号风险。</p></div>
    <div class="atip"><b>${ic('info')}注意</b><p>只管没放进大锅饭的号。你自己手动停用的号不会被唤醒。关掉这个开关，休眠中的号会马上全部唤醒。</p></div>
    <div class="dialog-foot pair"><button class="btn big" data-act="tipclose">取消</button><button class="btn primary big" data-act="sleepon">开启</button></div></section></div>`);
  $('#addtip [data-act=sleepon]')?.focus();
}
async function setAutoSleep(on){
  await api('PATCH','api/me',{autoSleep:on});me.autoSleep=on;
  if(!on)D.accounts=await api('GET','api/accounts');
  render();toast(on?'已开启闲置自动休眠':'已关闭，休眠中的号已唤醒');
}
function pageAccounts(){
  const acc=D.accounts,v=accView();
  const seg=acc.length?`<div class="seg" role="radiogroup" aria-label="显示方式"><label><input type="radio" name="accview" value="card" ${v==='card'?'checked':''}><span>卡片</span></label><label><input type="radio" name="accview" value="list" ${v==='list'?'checked':''}><span>列表</span></label></div>`:'';
  return head('我的凭证',`${acc.length?sleepBar():''}${seg}${acc.length?`<button class="btn" data-act="export">${ic('download')}导出</button>`:''}<button class="btn primary" data-act="add">${ic('plus')}添加凭证</button>`)+
    (acc.length?`<div id="acc-body">${accBody()}</div>`
      :`<section class="card glass">${empty('key','还没有凭证',`<button class="btn primary" data-act="add">${ic('plus')}添加凭证</button>`)}</section>`);
}
let mdlFor=null,mdl=null; // mdl: {id,label,list,res:{model:{run}|{ok,ms,reply,error}}}
function mtestLine(r){
  if(!r)return '';
  if(r.run)return `<span class="mres"><span class="spin"></span>测试中…</span>`;
  return r.ok?`<span class="mres ok">${ic('check')}可用 · ${(r.ms/1000).toFixed(1)} 秒${r.reply?` · <span class="mono">${esc(r.reply)}</span>`:''}</span>`
    :`<span class="mres err">${ic('alert')}${esc(r.error||'失败')}</span>`;
}
function modelsDialog(id,label,list){
  if(list!=null&&list!==false)mdl={id,label,list,res:mdl?.id===id?mdl.res:{}};
  const R=mdl?.id===id?mdl.res:{};
  const scroll=$('.mlist')?.scrollTop;
  openDialog('支持的模型',esc(label),list==null?`<div class="mt">${loadingBox('加载中…')}</div>`:list===false?resultBox('err','加载失败',''):
    list.length?`<div class="mlist">${list.map(m=>`<div class="mrow"><b class="mono">${esc(m.id)}</b><span class="faint">${esc(m.name)}</span><button class="btn sm mtest" data-act="mtest:${esc(m.id)}" ${R[m.id]?.run?'disabled':''}>${ic('play')}测试</button>${mtestLine(R[m.id])}</div>`).join('')}</div>`:empty('layers','这个号没有可用的模型'),
    `<button class="btn primary" data-act="close">完成</button>`,true);
  if(scroll&&$('.mlist'))$('.mlist').scrollTop=scroll;
  mdlFor=list==null?id:null;
}

function rulesRead(r){
  return `<div class="rule"><h3>大锅饭 Key 总并发 / 限速</h3><div class="val">${r.keyConc} 并发 · ${r.keyRpm} 次/分</div></div>
    <div class="rule"><h3>单号并发 / 限速</h3><div class="val">${r.accConc} 并发 · ${r.accRpm?r.accRpm+' 次/分':'不限'}</div></div>
    <div class="rule"><h3>自用保留</h3><div class="val">${reserveText(r.reserve)}</div></div>`;
}
/* 大锅饭资源：共享号剩余额度按 Gemini / Claude / Argon 汇总（扣掉各号的自用保留） */
const RES_F=[['gemini','Gemini',()=>GEM],['claude','Claude',()=>CLA],['argon','Gemini 4 Argon',()=>GEM]];
const lvOf=p=>p>=40?'good':p>=15?'mid':'low';
function resWin(lab,w){
  if(!w||!w.n)return '';
  const p=Math.round(w.sum/w.n*100);
  return `<div class="qt ${lvOf(p)}"><div class="qt-a"><b>${lab}</b><span class="qt-p">${p}<small>%</small></span></div>
    <div class="qt-bar"><span style="width:${Math.max(p,2)}%"></span></div>
    <div class="qt-c"><span>${w.ok}/${w.n} 个有余量</span><span>${w.next?short(w.next)+' 后刷新':''}</span></div></div>`;
}
function resSummary(R){
  if(!R)return `<small class="faint">资源数据暂时读不到</small>`;
  const c=R.counts,usable=c.ok+c.cooldown;
  const chips=[`<span class="chip good"><span class="dot"></span>正常 ${c.ok}</span>`,c.cooldown?`<span class="chip warn"><span class="dot"></span>冷却 ${c.cooldown}</span>`:'',c.problem?`<span class="chip bad"><span class="dot"></span>出问题 ${c.problem}</span>`:'',c.off?`<span class="chip">停用 ${c.off}</span>`:'',
    c.ultra?tierTag('Ultra',' ×'+c.ultra):'',c.pro?`<span class="tier pro">Pro ×${c.pro}</span>`:'',c.free?`<span class="tier">Free ×${c.free}</span>`:''].join('');
  const fams=RES_F.map(([k,lab,icon])=>{const F=R.fam[k];if(!F||!F.accounts&&!F.off)return '';
    return `<div class="res-f ${F.open?'':'shut'}"><div class="res-h">${icon()}<b>${lab}</b>${F.open?'':'<span class="chip">大锅饭未开放</span>'}</div>
      <div class="res-n"><b class="mono">${F.full.toFixed(1)}</b><span>个满额号 · ${k==='argon'?`${F.accounts} 个号已开通${F.off?` · ${F.off} 个未开通`:''}`:`${F.accounts} 个号有这项额度`}</span></div>
      <div class="res-w">${resWin('5H',F.h5)}${resWin('Weekly',F.weekly)}</div></div>`;}).join('');
  return `<div class="res-top"><div class="res-big"><b class="mono">${usable}</b><span>/ ${c.total} 个号可用</span></div><div class="res-chips">${chips}</div></div>
    <div class="res-fams">${fams||'<small class="faint">还没有额度数据</small>'}</div>
    <p class="res-note faint">已扣除号主的自用保留 · 「满额号」= 把剩余额度加起来折算${R.upstreams?` · 另有 ${R.upstreams} 个外部上游兜底`:''}${R.oldest?` · 数据最早更新于 ${ago(R.oldest)}`:''}</p>`;
}
/* 站长兜底公益池：管理员接进来的外部上游替大锅饭接了多少请求 */
const useCell=(lab,x,sub)=>`<div class="bk-c"><span class="bk-l">${lab}</span><b class="mono">${x.n.toLocaleString()}<small>次</small></b><span class="bk-s">${fmtK(x.t)} Token${x.n?` · 成功 ${Math.round(x.ok/x.n*100)}%`:''}${sub?' · '+sub:''}</span></div>`;
const useGrid=B=>`<div class="bk-g">${useCell('今日',B.today)}${useCell('近 7 天',B.week)}${useCell('累计',B.total,B.since?'自 '+mdhm(B.since).slice(0,5):'')}</div>`;
/* 大锅饭号池：大家共享的号替大锅饭跑了多少 */
function sharedUseBlock(R){
  const S=R?.shared;if(!S)return '';
  return `<div class="bk"><div class="bk-h"><b>🍲 大锅饭号池</b><span class="faint">大家共享进大锅饭的号实际跑了多少</span></div>${useGrid(S)}</div>`;
}
function backupBlock(R){
  const B=R?.backup;if(!B||!R.upstreams&&!B.total.n)return '';
  return `<div class="bk"><div class="bk-h"><b>🛟 站长兜底公益池</b>${R.upstreams?dotChip('good','在线'):dotChip('','未启用')}<span class="faint">和大锅饭号池轮询使用</span></div>
    ${useGrid(B)}
    <div class="bk-share"><span>今日大锅饭请求里由兜底池接住</span><b class="mono">${B.share}%</b></div><div class="meter"><span style="width:${Math.min(100,Math.max(B.share,B.today.n?1:0))}%"></span></div></div>`;
}
function resCell(w,reserve){
  if(!w)return `<span class="rc faint">—</span>`;
  const xs=[w.h5,w.weekly].filter(Boolean),m=xs.reduce((a,b)=>b.frac<a.frac?b:a),p=Math.round(m.frac*100),r=reserve||0;
  const tip=[['5H',w.h5],['Weekly',w.weekly]].filter(x=>x[1]).map(([l,x])=>`${l} ${Math.round(x.frac*100)}%${x.reset?' · '+short(x.reset)+' 后刷新':''}`).join('\n');
  return `<span class="rc ${p<=r?'under':lvOf(p)}" title="${esc(tip)}"><span class="rc-bar"><span style="width:${Math.max(p,2)}%"></span>${r?`<i style="left:${r}%"></i>`:''}</span><b class="mono">${p}</b></span>`;
}
function resTable(R){
  const L=(R?.accounts||[]).map(a=>{const ws=Object.values(a.wins).flatMap(w=>[w.h5,w.weekly]).filter(Boolean);return {...a,min:ws.length?Math.min(...ws.map(x=>x.frac)):2};})
    .sort((a,b)=>(a.state==='problem')-(b.state==='problem')||a.min-b.min);
  if(!L.length)return '';
  const ST={ok:['good','正常'],cooldown:['warn','冷却'],problem:['bad','出问题'],off:['idle','停用']};
  return `<div class="tbl res-t"><div class="tr th"><span>账号</span><span>状态</span><span>Gemini</span><span>Claude</span><span>Argon</span><span class="num-r">保留</span><span class="num-r">今日</span></div>
    ${L.map(a=>{const t=tierName(a.tier),[k,lab]=ST[a.state];return `<div class="tr ${a.state==='off'?'off':''}">
      <span class="u-cell"><span class="avatar sm" title="${esc(a.owner)}">${esc((a.owner||'?')[0])}</span><span class="u-n"><span class="u-t"><strong class="mono" title="${esc(a.email)}">${esc(a.email)}</strong>${tierTag(t)}</span><span class="sub">${esc(a.owner)}${a.quotaAt?' · '+ago(a.quotaAt):''}</span></span></span>
      <span class="u-st ${k==='bad'?'bad':''}" title="${esc(a.problem||'')}"><span class="sdot ${k}"></span>${esc(a.problem||lab)}</span>
      ${resCell(a.wins.gemini,a.reserve)}${resCell(a.wins.claude,a.reserve)}${a.argon==='off'?'<span class="rc faint" title="这个号没有开通 Gemini 4 Argon">未开通</span>':resCell(a.wins.argon,a.reserve)}
      <span class="num-r mono faint">${a.reserve?a.reserve+'%':'—'}</span>
      <span class="num-r mono ${a.today.t?'':'zero'}" title="${a.today.n} 次请求">${fmtK(a.today.t)}</span></div>`;}).join('')}</div>
    <p class="res-note faint">每格是该号这项额度里最紧的窗口，竖线是号主的自用保留线；鼠标放上去看 5H / Weekly 明细。</p>`;
}
function pagePool(){
  const p=D.pool;
  return head('大锅饭 / 小锅饭')+
  `<div class="grid g2">
    <section class="card glass">
      <div class="card-head">${poolTag('private')}</div>
      <div class="stat" style="padding:0"><div class="num">${p.privateAccounts}<small>个可用账号</small></div></div>
      <div class="mt"><button class="btn primary" data-act="newkey:private" ${p.privateAccounts?'':'disabled'}>${ic('plus')}创建小锅饭密钥</button></div>
    </section>
    <section class="card glass">
      <div class="card-head">${poolTag('shared')}</div>
      <div class="stat" style="padding:0"><div class="num">${p.accounts}<small>个可用账号</small></div></div>
      <div class="mt"><button class="btn primary" data-act="newkey:shared">${ic('plus')}创建大锅饭密钥</button></div>
    </section>
  </div>
  <section class="card glass res"><div class="card-head"><div><h2>大锅饭剩余资源</h2><p>大家共享进大锅饭的号，现在还剩多少</p></div></div>${resSummary(D.res)}${sharedUseBlock(D.res)}${backupBlock(D.res)}</section>
  <section class="card glass"><div class="card-head"><h2>大锅饭规则</h2></div>${rulesRead(D.rules)}</section>`;
}

function pageKeys(){
  const list=D.keys.length?D.keys.map(k=>`<div class="key">
      <div style="min-width:0"><div class="hstack"><strong style="font-size:15px">${esc(k.name)}</strong>${poolTag(k.pool)}<button class="btn sm ghost icon" data-act="rename:${k.id}" aria-label="重命名 ${esc(k.name)}">${ic('pen')}</button></div><small class="mono">sk-agy-••••••••${esc(k.tail)}</small></div>
      <div class="seg" role="radiogroup" aria-label="${esc(k.name)} 使用的账号池">
        <label><input type="radio" name="kp-${k.id}" value="private" data-key="${k.id}" ${k.pool==='private'?'checked':''}><span>小锅饭</span></label>
        <label><input type="radio" name="kp-${k.id}" value="shared" data-key="${k.id}" ${k.pool==='shared'?'checked':''}><span>大锅饭</span></label>
      </div>
      <div class="hstack"><button class="btn sm ghost" data-act="copykey:${k.id}" ${k.key?'':'disabled'}>${ic('copy')}复制</button><button class="btn sm" data-act="connect:${k.id}">接入</button><button class="btn sm ghost danger" data-act="revoke:${k.id}" aria-label="撤销 ${esc(k.name)}">${ic('trash')}</button></div>
    </div>`).join(''):empty('terminal','还没有密钥',`<button class="btn primary" data-act="newkey">${ic('plus')}创建密钥</button>`);
  return head('API 密钥',`<button class="btn primary" data-act="newkey">${ic('plus')}创建密钥</button>`)+
  `<section class="card glass"><div class="card-head"><h2>接入地址</h2></div>
    <div class="code"><span>${esc(baseURL())}</span><button class="btn sm ghost" data-act="copy:base">${ic('copy')}复制</button></div></section>
  <section class="card glass"><div class="card-head"><h2>我的密钥</h2></div>${list}</section>`;
}

/* 流量日志 */
function trafficQS(){const t=ui.tr,p=new URLSearchParams({page:t.page,size:t.size});
  if(t.q)p.set('q',t.q);if(t.account)p.set('account',t.account);if(t.user)p.set('user',t.user);if(t.family)p.set('family',t.family);if(t.pool)p.set('pool',t.pool);if(t.err)p.set('errorsOnly','1');return p.toString();}
const CHIPS=[['all','全部'],['f:claude','claude'],['f:gemini','gemini'],['f:flash','flash'],['f:pro','pro'],['f:image','绘图'],['err','仅错误'],['p:private','小锅饭'],['p:shared','大锅饭']];
function trChips(){const t=ui.tr;return CHIPS.map(([k,l])=>{
  const on=k==='all'?!t.family&&!t.pool&&!t.err:k==='err'?t.err:k.startsWith('f:')?t.family===k.slice(2):t.pool===k.slice(2);
  return `<button type="button" class="fchip ${k.startsWith('p:')?k.slice(2):''}" aria-pressed="${on}" data-act="trchip:${k}">${l}</button>`;}).join('');}
function trTotals(){const T=D.traffic;return `<span>Total <b>${T.total.toLocaleString()}</b></span><span>OK <b class="good-t">${T.ok.toLocaleString()}</b></span><span>Error <b class="bad-t">${T.error.toLocaleString()}</b></span>`;}
const sec=ms=>ms==null?'—':ms<1000?ms+'ms':(ms/1000).toFixed(ms<1e4?2:1)+'s';
const ntok=n=>n==null?'—':fmtK(n);
function stPill(r){const s=r.status,k=s<300?'good':s===499?'':s<500?'warn':'bad';return `<span class="code-pill ${k}">${s}</span>`;}
const famIc=m=>/claude/i.test(m||'')?CLA:/gpt/i.test(m||'')?GPT:GEM;
function trModel(r){const d=r.upstream&&r.upstream!==r.model;
  return `<span class="tm-a">${famIc(r.model)}<span class="mono" title="${esc(d?r.model+' → '+r.upstream:r.model||'')}">${esc(r.model||'—')}</span></span>${d?`<span class="sub mono">→ ${esc(r.upstream)}</span>`:r.effort?`<span class="sub">effort ${esc(r.effort)}</span>`:''}`;}
const TKI={in:'<path d="M12 4v16"/><path d="m6 14 6 6 6-6"/>',out:'<path d="M12 20V4"/><path d="m6 10 6-6 6 6"/>',
  cache:'<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/>',
  write:'<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'};
const tki=k=>`<svg class="tki ${k}" viewBox="0 0 24 24" aria-hidden="true">${TKI[k]}</svg>`;
function trTok(r){if(r.in==null&&r.out==null)return '<span class="faint">—</span>';
  const n=v=>`<b>${fmtK(v||0)}</b>`;
  return `<span class="tk"><span class="tk-l">${tki('in')}${n(r.in)}${tki('out')}${n(r.out)}</span>${r.cache||r.cacheWrite?`<span class="tk-l">${r.cache?tki('cache')+`<b class="c">${fmtK(r.cache)}</b>`:''}${r.cacheWrite?tki('write')+`<b class="w">${fmtK(r.cacheWrite)}</b>`:''}</span>`:''}</span><button type="button" class="tk-i" data-act="tokpop:${r.id}" aria-label="Token 明细">${ic('info')}</button>`;}
function tokPopHTML(r){
  const L=(l,v,x='')=>`<div class="tp-r"><span>${l}${x}</span><b>${Number(v||0).toLocaleString()}</b></div>`;
  const tot=r.total||((r.in||0)+(r.out||0)+(r.think||0));
  return `<h4>Token 明细</h4>${L('输入 Token',r.in)}${L('输出 Token',r.out)}${r.think?L('思考 Token',r.think):''}${L('缓存写入',r.cacheWrite)}${L('缓存读取 Token',r.cache)}<div class="tp-r tp-t"><span>总 Token</span><b>${Number(tot).toLocaleString()}</b></div>`;
}
let tokPin=null;
function showTokPop(btn,pin){
  const id=+btn.dataset.act.slice(7),r=D.traffic?.rows.find(x=>x.id===id);if(!r)return;
  let p=$('#tokpop');if(!p){p=document.createElement('div');p.id='tokpop';p.setAttribute('role','tooltip');document.body.append(p);}
  p.innerHTML=tokPopHTML(r);p.hidden=false;
  const b=btn.getBoundingClientRect(),w=p.offsetWidth,h=p.offsetHeight;
  let x=b.left-w-10,y=b.top+b.height/2-h/2;if(x<8)x=b.right+10;
  p.style.left=Math.max(8,Math.min(x,innerWidth-w-8))+'px';p.style.top=Math.max(8,Math.min(y,innerHeight-h-8))+'px';
  tokPin=pin?id:null;
}
function hideTokPop(force){if(tokPin&&!force)return;const p=$('#tokpop');if(p)p.hidden=true;tokPin=null;}
document.addEventListener('mouseover',e=>{const b=e.target.closest?.('.tk-i');if(b&&!tokPin)showTokPop(b,false);});
document.addEventListener('mouseout',e=>{if(e.target.closest?.('.tk-i'))hideTokPop(false);});
addEventListener('scroll',()=>hideTokPop(true),true);
function trRes(r){const ok=r.result==='ok';return `<span class="res-line">${stPill(r)}<span class="sbadge ${r.stream?'':'plain'}">${r.stream?'流式':'非流'}</span>${r.attempts>1?`<span class="sbadge warn" title="上游共尝试 ${r.attempts} 次">retry ×${r.attempts-1}</span>`:''}</span>${ok?'':`<span class="sub res-why" title="${esc(r.reason||'')}">${esc(r.reason||'')}</span>`}`;}
const poolXs=p=>`<span class="pxs ${p}">${POOL[p]||'小锅饭'}</span>`;
function trTable(){
  const T=D.traffic,adm=T.admin;
  if(!T.rows.length)return empty('activity','没有记录');
  const from=(T.page-1)*T.size+1,to=from+T.rows.length-1,pages=Math.max(1,Math.ceil(T.total/T.size));
  return `<div class="tbl traffic"><div class="tr th"><span>Time</span><span>Status</span><span>Model</span><span class="c-user">${adm?'User / Key':'Key'}</span><span class="c-acc">Account</span><span class="num-r">Tokens</span><span class="num-r">Latency</span></div>
  ${T.rows.map(r=>{const d=new Date(r.ts),md=`${pad(d.getMonth()+1)}-${pad(d.getDate())}`,time=`${md} ${hms(r.ts)}`,slow=r.latency>=30000;
    return `<div class="tr ${r.result==='ok'?'':'bad-row'} ${me.role==='admin'?'click':''}" ${me.role==='admin'?`data-act="trlog:${r.id}" role="button" tabindex="0" aria-label="查看报文"`:''}>
    <span class="mono c-time">${hms(r.ts)}<span class="sub">${md}</span></span>
    <span class="c-res">${trRes(r)}</span>
    <span class="c-model">${trModel(r)}</span>
    <span class="c-user">${adm?`${esc(r.user||'—')}<span class="sub">${esc(r.key||'—')}</span>`:esc(r.key||'—')}</span>
    <span class="c-acc">${poolXs(r.pool)}<span class="sub mono" title="${esc(r.account||'')}">${esc(r.account||'—')}</span></span>
    <span class="num-r mono c-tok">${trTok(r)}</span>
    <span class="num-r mono c-lat"><span class="${slow?'warn-t':''}">${sec(r.latency)}</span><span class="sub">ttft ${sec(r.ttfb)}</span></span>
    <span class="c-meta">${poolXs(r.pool)}<span class="mono">${esc(r.account||'—')}</span><span class="mono">${ntok(r.in)} in · ${ntok(r.out)} out</span><span class="mono">${sec(r.latency)}</span><span class="mono">${time}</span></span>
  </div>`;}).join('')}</div>
  <div class="pager tr-pager"><small class="faint">${from}–${to} / ${T.total.toLocaleString()}</small>
    <select class="select inline" data-trsize aria-label="每页条数">${[50,100].map(n=>`<option value="${n}" ${T.size===n?'selected':''}>${n} / page</option>`).join('')}</select>
    <button class="btn sm ghost" data-act="trpg:${T.page-1}" ${T.page<=1?'disabled':''} aria-label="上一页">‹</button><span class="pg-jump mono faint"><input class="input sm mono" type="number" min="1" max="${pages}" value="${T.page}" data-trpage aria-label="跳到第几页"> / ${pages}</span><button class="btn sm ghost" data-act="trpg:${T.page+1}" ${T.page>=pages?'disabled':''} aria-label="下一页">›</button></div>`;
}
function pageTraffic(){
  const T=D.traffic,t=ui.tr;
  return `<div class="tr-bar">
    <input class="input sm tr-q" data-trq value="${esc(t.q)}" placeholder="搜索模型、状态码、原因" aria-label="搜索模型、状态码或原因">
    <select class="select inline" data-trf="account" aria-label="账号"><option value="">全部账号</option>${T.accounts.map(a=>`<option value="${esc(a.id)}" ${t.account===a.id?'selected':''}>${esc(a.email||a.id)}</option>`).join('')}</select>
    ${T.admin?`<select class="select inline" data-trf="user" aria-label="用户"><option value="">全部用户</option>${T.users.map(u=>`<option value="${u.id}" ${String(t.user)===String(u.id)?'selected':''}>${esc(u.name)}</option>`).join('')}</select>`:''}
    <span class="tr-tot" id="tr-tot">${trTotals()}</span>
    <span class="tr-tools"><button class="btn sm ghost icon" data-act="trrefresh" aria-label="刷新">${ic('refresh')}</button><span class="switch-field sm"><button class="switch" role="switch" aria-checked="${t.auto}" aria-label="自动刷新" data-act="trauto"></button><small>Auto</small></span></span>
  </div>
  <div class="fchips" id="tr-chips">${trChips()}</div>
  <div id="tr-body">${trTable()}</div>`;
}
async function refreshTraffic(){
  D.traffic=await api('GET','api/traffic?'+trafficQS());
  const b=$('#tr-body');if(!b)return;
  b.innerHTML=trTable();$('#tr-tot').innerHTML=trTotals();$('#tr-chips').innerHTML=trChips();
}
function pageLogs(){
  const seg=`<div class="seg" role="radiogroup" aria-label="记录视角">
    <label><input type="radio" name="logView" value="mine" ${ui.logView==='mine'?'checked':''}><span>${me.role==='admin'?'全部请求':'我的请求'}</span></label>
    <label><input type="radio" name="logView" value="contrib" ${ui.logView==='contrib'?'checked':''}><span>我的账号服务他人</span></label></div>`;
  let body;
  if(ui.logView==='mine')body=pageTraffic();
  else{
    const c=D.contrib||[];
    body=`<div class="card-head"><h2>我的账号服务他人</h2><span class="chip">今日</span></div>`+
    (c.length?`<div class="tbl contrib"><div class="tr th"><span>贡献账号</span><span class="num-r">请求</span><span>按模型</span><span class="num-r c-tok">Token</span></div>${c.map(a=>
      `<div class="tr"><strong>${esc(accName(a))}</strong><span class="num-r mono">${a.count} 次</span><span class="c-models hstack">${Object.entries(a.models).map(([m,n])=>`<span class="chip">${esc(m)} ${n}</span>`).join('')||'<small>暂无</small>'}</span><span class="num-r mono c-tok">${fmtTok(a.tokens)}</span></div>`).join('')}</div>`
      :empty('heart','还没有贡献账号',`<button class="btn" data-act="goto:accounts">去我的凭证</button>`));
  }
  return head('流量日志',seg)+`<section class="card glass">${body}</section>`;
}

function themePref(){try{return localStorage.getItem('agy-theme')||'auto'}catch(e){return 'auto'}}
/* 输入上限：所有密钥共用，按估算的输入 Token 拦截 */
const INLIM=[[0,'不限'],[100000,'10 万'],[200000,'20 万'],[500000,'50 万']];
function inputLimitCard(){
  const v=me.inputLimit||0,preset=INLIM.some(x=>x[0]===v);
  return `<section class="card glass"><div class="card-head"><div><h2>输入上限</h2><p>一次请求的输入超过这个数就直接拦下，返回「输入过限」，不消耗额度。防止上下文不知不觉爆到几十万 Token。所有密钥共用。</p></div></div>
    <div class="row"><div class="seg" role="radiogroup" aria-label="输入上限">${INLIM.map(([n,l])=>`<label><input type="radio" name="inlim" value="${n}" ${preset&&v===n?'checked':''}><span>${l}</span></label>`).join('')}</div>
    <div class="hstack"><small class="faint">自定义</small><input class="input" type="number" min="0.1" max="1000" step="0.1" data-inlim value="${v&&!preset?+(v/1e4).toFixed(1):''}" placeholder="—" aria-label="自定义输入上限（万 Token）" style="width:90px"><small>万 Token</small></div></div>
    <small class="faint">按请求内容估算（中文约 1 字 1 Token，英文约 4 字母 1 Token，图片不算），和实际会有一两成误差。</small></section>`;
}
function pageProfile(){
  return head('个人中心')+
  `<section class="card glass"><div class="row"><div class="hstack" style="gap:14px"><span class="avatar lg">${esc((me.name||'?')[0])}</span><div><h2 style="font-size:20px">${esc(me.name)}</h2><small>@${esc(me.handle)}</small></div></div><span class="chip good">${ic('check')}${String(me.discordId).startsWith('local:')?'账号密码登录':'Discord 已登录'}</span></div></section>
  <section class="card glass"><div class="card-head"><h2>我的权限</h2><span class="chip">${me.role==='admin'?'管理员':'普通用户'}</span></div>
    ${String(me.discordId).startsWith('local:')?'':`<div class="rule"><h3>Discord 身份组</h3><div class="val"><span class="chip good">已验证</span></div></div>`}
    <div class="rule"><h3>管理自己的凭证</h3><div class="val"><span class="chip good">已开启</span></div></div>
    <div class="rule"><h3>使用大锅饭</h3><div class="val"><span class="chip good">已开启</span></div></div>
  </section>
  ${inputLimitCard()}
  <section class="card glass"><div class="row"><h2>退出</h2><button class="btn" data-act="logout">${ic('logout')}退出登录</button></div></section>`;
}

/* 管理员后台 */
function proxySelect(a,proxies){
  return `<select class="select inline" data-proxy="${esc(a.id)}" aria-label="${esc(a.email)} 专属出口"><option value="">未绑定</option>${proxies.map(p=>`<option value="${p.id}" ${a.proxyId===p.id?'selected':''} ${p.account&&p.account!==a.id?'disabled':''}>${esc(p.url)}</option>`).join('')}</select>`;
}
function secretField(label,key,isSet){
  return `<span>${label}</span><div class="hstack">${isSet&&!ui['replace_'+key]?`<span class="chip good">已设置</span><button class="btn sm" data-act="replace:${key}">替换</button>${key==='botToken'?`<button class="btn sm ghost danger" data-act="clearbot">清除</button>`:''}`
    :`<input class="input mono" type="password" autocomplete="off" data-site="${key}" style="flex:1">`}</div>`;
}

const FOLD=(()=>{try{return JSON.parse(localStorage.getItem('agy-fold')||'{}')}catch(e){return {}}})();
function fold(id,title,badge,body,def=true,sub=''){
  return `<details class="card glass fold" data-fold="${id}" ${(FOLD[id]??def)?'open':''}><summary class="card-head"><div><h2>${title}</h2>${sub?`<p>${sub}</p>`:''}</div><span class="fold-b">${badge||''}</span>${ic('chev')}</summary>${body}</details>`;
}
const cnt=n=>`<span class="chip">${n}</span>`;
const dotChip=(k,t)=>`<span class="chip ${k}"><span class="dot"></span>${t}</span>`;
const PG=20;
const LISTS={
  users:{cls:'users',items:()=>D.admin.users,text:x=>[x.name,x.username,x.discordId].join(' '),
    cols:[['name','用户'],['active','状态','c-st'],['accounts','凭证','num-r'],['shared','大锅饭','num-r'],['private','小锅饭','num-r'],['keys','Keys','num-r c-n'],['dailyUsed','次数','num-r'],['reqToday','Today','num-r c-n'],['reqTotal','Total','num-r c-n'],['served','服务他人','num-r c-n'],['lastActive','Last seen','num-r c-n']],
    row:x=>{const z=v=>`<span class="num-r mono ${v?'':'zero'}">${(v||0).toLocaleString()}</span>`;return `<div class="tr ${x.active?'':'off'}">
      <span class="u-cell"><span class="avatar sm">${esc((x.name||'?')[0])}</span><span class="u-n"><span class="u-t"><strong>${esc(x.name)}</strong>${x.role==='admin'?'<span class="tier pro">Admin</span>':''}</span><span class="sub mono">${x.username?'@'+esc(x.username):esc(x.discordId)}</span></span></span>
      <span class="c-st"><span class="u-st ${x.active?'good':'bad'}"><span class="sdot ${x.active?'good':'bad'}"></span>${x.active?'正常':'已停用'}</span></span>
      ${z(x.accounts)}${z(x.shared)}${z(x.private)}<span class="num-r mono c-n ${x.keys?'':'zero'}">${x.keys}</span>
      <span class="num-r mono u-daily ${x.dailyLimit!=null&&x.dailyUsed>=x.dailyLimit?'bad-t':''}" title="今日大锅饭次数${x.dailyOverride!=null?'（单独设置）':''}">${x.dailyUsed}<i>/${x.dailyLimit==null?'∞':x.dailyLimit}</i>${x.dailyOverride!=null?'<b>*</b>':''}</span><span class="num-r mono c-n ${x.reqToday?'':'zero'}">${(x.reqToday||0).toLocaleString()}</span><span class="num-r mono c-n ${x.reqTotal?'':'zero'}">${(x.reqTotal||0).toLocaleString()}</span><span class="num-r mono c-n ${x.served?'':'zero'}">${(x.served||0).toLocaleString()}</span>
      <span class="num-r mono faint c-n">${x.lastActive?mdhm(x.lastActive):'—'}</span>
      <span class="u-act"><button class="btn sm ghost icon" data-act="ulimit:${x.id}" aria-label="设置 ${esc(x.name)} 的每日次数" title="每日次数">${ic('sliders')}</button>${x.username?`<button class="btn sm ghost icon" data-act="resetpw:${x.id}" aria-label="重置 ${esc(x.name)} 的密码" title="重置密码">${ic('lock')}</button>`:''}${x.id===me.id?'':`<button class="switch" role="switch" aria-checked="${x.active}" aria-label="${x.active?'停用':'启用'} ${esc(x.name)}" title="${x.active?'停用':'启用'}" data-act="user:${x.id}"></button>`}</span></div>`;}},
  fleet:{cls:'fleet',head:`<div class="tr th"><span>账号</span><span class="c-share">共享</span><span class="c-proxy">专属出口</span><span>状态</span><span></span></div>`,items:()=>D.admin.accounts,text:a=>[a.email,a.id,a.owner].join(' '),row:a=>{const A=D.admin,[k,,why]=accState(a);return `<div class="tr ${a.active?'':'off'}">
      <span class="u-cell"><span class="avatar sm" title="${esc(a.owner||'无主')}">${esc((a.owner||'?')[0])}</span><span class="u-n"><strong class="mono" title="${esc(a.email||a.id)}">${esc(a.email||a.id)}</strong><span class="sub">${esc(a.owner||'无主')}</span></span></span>
      <span class="c-share">${a.shared?'<span class="ar-tag">大锅饭</span>':'<span class="faint">自用</span>'}</span>
      <span class="c-proxy">${proxySelect(a,A.proxies)}</span>
      <span class="f-st"><span class="u-st ${k==='bad'?'bad':''}"><span class="sdot ${k||'idle'}"></span>${esc(accState(a)[1])}</span>${why?`<span class="sub" title="${esc(why)}">${esc(why)}</span>`:''}${modelCds(a).length?`<span class="sub" title="${esc(modelCds(a).map(c=>`${c.model} · ${c.text} · ${recover(c.retryAt)}`).join('\n'))}">${modelCds(a).length} 个模型冷却中</span>`:''}</span>
      <span class="u-act">${a.action?.url?`<a class="btn sm ghost icon" href="${esc(a.action.url)}" target="_blank" rel="noopener noreferrer" aria-label="${ACT[a.action.kind]||ACT.verify}" title="${ACT[a.action.kind]||ACT.verify}">${ic('ext')}</a><button class="btn sm ghost icon" data-act="copyurl:${esc(a.id)}" aria-label="复制链接" title="复制链接">${ic('copy')}</button>`:''}<button class="btn sm ghost icon" data-act="amodels:${esc(a.id)}" aria-label="模型" title="模型">${ic('layers')}</button><button class="switch" role="switch" aria-checked="${a.active}" aria-label="启用 ${esc(a.email)}" data-act="fleet:${esc(a.id)}"></button></span></div>`;}},
};
function pagedList(k){
  const L=LISTS[k],A=D.admin,q=(ui['q_'+k]||'').trim().toLowerCase();
  let all=L.items().filter(x=>!q||L.text(x).toLowerCase().includes(q));
  const so=ui['s_'+k];
  if(so){const {c,d}=so;all=[...all].sort((a,b)=>{const x=a[c],y=b[c];const r=typeof x==='string'||typeof y==='string'?String(x??'').localeCompare(String(y??''),'zh'):(Number(x)||0)-(Number(y)||0);return d*r;});}
  const head=L.head||`<div class="tr th">${L.cols.map(([c,t,cls=''])=>`<button type="button" class="sort ${cls} ${so?.c===c?'on':''}" data-act="sort:${k}:${c}">${t}${so?.c===c?(so.d>0?' ↑':' ↓'):''}</button>`).join('')}<span></span></div>`;
  const pages=Math.max(1,Math.ceil(all.length/PG)),p=Math.min(Math.max(1,ui['p_'+k]||1),pages);ui['p_'+k]=p;
  const rows=all.slice((p-1)*PG,p*PG).map(L.row).join('')||`<div class="tr"><span class="faint">无结果</span></div>`;
  const pager=pages>1?`<div class="pager"><button class="btn sm ghost" data-act="pg:${k}:${p-1}" ${p<=1?'disabled':''} aria-label="上一页">‹</button><span class="mono faint">${p} / ${pages}</span><button class="btn sm ghost" data-act="pg:${k}:${p+1}" ${p>=pages?'disabled':''} aria-label="下一页">›</button></div>`:'';
  return `<div class="tbl ${L.cls}">${head}${rows}</div>${pager}`;
}
function refreshList(k){const el=document.getElementById('pg-'+k);if(el)el.innerHTML=pagedList(k);}
function pageUsers(){
  const U=D.admin.users,act=U.filter(x=>x.active).length;
  return head('用户管理',`<button class="btn primary" data-act="newuser">${ic('plus')}添加账号</button>`)+
  `<div class="grid g4">
    <div class="stat glass"><div class="label">${ic('users')}用户</div><div class="num">${U.length}</div><small>${act} 个正常</small></div>
    <div class="stat glass mine"><div class="label">${ic('key')}凭证</div><div class="num">${U.reduce((n,x)=>n+x.accounts,0)}</div></div>
    <div class="stat glass give"><div class="label">${ic('heart')}共享进大锅饭</div><div class="num">${U.reduce((n,x)=>n+x.shared,0)}</div></div>
    <div class="stat glass"><div class="label">${ic('activity')}今日请求</div><div class="num">${U.reduce((n,x)=>n+x.reqToday,0).toLocaleString()}</div></div>
  </div>
  <section class="card glass">
    <div class="card-head"><h2>全部用户</h2>${cnt(U.length)}<div class="search-sm">${ic('search')}<input class="input sm" data-search="users" value="${esc(ui.q_users||'')}" placeholder="搜索名字 / 用户名" aria-label="搜索用户"></div></div>
    <div id="pg-users">${pagedList('users')}</div>
  </section>`;
}

const ADM_TABS=[['ov','总览'],['pool','号池'],['fwd','转发'],['site','站点']];
function admTab(v){ui.admTab=v;try{localStorage.setItem('agy-admtab',v);}catch(err){}render();}
function pageAdmin(){
  const A=D.admin,r=A.rules,u=A.usage,s=A.site,siteOK=s.clientId&&s.clientSecretSet;
  const alarms=u.breaker.tripped||u.alarms.length?fold('alarms','安全熔断',u.breaker.tripped?dotChip('bad','已熔断'):dotChip('good','正常'),
    `${u.alarms.slice(0,8).map(a=>`<div class="rule"><div><h3>${esc(a.kind)}</h3><div class="alarm mono">${esc(a.detail)}</div></div><div class="val faint mono">${mdhm(a.ts)}</div></div>`).join('')}
    ${u.breaker.tripped?`<div class="mt"><button class="btn primary" data-act="breaker">${ic('refresh')}解除熔断</button></div>`:''}`,u.breaker.tripped):'';
  const tab=ADM_TABS.some(t=>t[0]===ui.admTab)?ui.admTab:'ov';
  const urgent=(tab!=='ov'&&u.breaker.tripped?alarms:'')+(tab!=='site'&&!siteOK?`<button type="button" class="adm-alert glass" data-act="admtab:site">${ic('alert')}<b>Discord 登录未配置</b>${ic('arrow')}</button>`:'');
  const tabs=`<div class="seg full adm-tabs" role="radiogroup" aria-label="后台分区">${ADM_TABS.map(([v,l])=>`<label><input type="radio" name="admTab" value="${v}" ${tab===v?'checked':''}><span>${l}</span></label>`).join('')}</div>`;
  const body={
    ov:()=>`<div class="grid g4">
    <div class="stat glass"><div class="label">${ic('activity')}今日请求</div><div class="num">${u.total.toLocaleString()}</div></div>
    <div class="stat glass mine"><div class="label">${ic('lock')}小锅饭</div><div class="num">${u.private.toLocaleString()}</div></div>
    <div class="stat glass give"><div class="label">${ic('users')}大锅饭</div><div class="num">${u.shared.toLocaleString()}</div></div>
    <div class="stat glass"><div class="label">${ic('alert')}无可用账号</div><div class="num">${u.rejected}</div></div>
  </div>
  ${alarms}
  ${annAdmin()}`,
    pool:()=>`${fold('poolres','大锅饭资源',A.res?`<span class="fold-sum">${A.res.counts.ok+A.res.counts.cooldown}/${A.res.counts.total} 可用${A.res.counts.problem?` · ${A.res.counts.problem} 出问题`:''}</span>`:'',`<div class="res">${resSummary(A.res)}${sharedUseBlock(A.res)}${backupBlock(A.res)}</div>${resTable(A.res)}`)}
  ${fold('fleet','全部账号',cnt(A.accounts.length),`<div class="fold-tools"><div class="search-sm">${ic('search')}<input class="input sm" data-search="fleet" value="${esc(ui.q_fleet||'')}" placeholder="搜索邮箱 / 主人" aria-label="搜索账号"></div></div><div id="pg-fleet">${pagedList('fleet')}</div>`)}
  ${fold('proxies','专属出口',cnt(A.proxies.length),`
    <div class="tbl proxies">${A.proxies.map(p=>`<div class="tr"><span class="mono">${esc(p.url)}</span><span class="mono faint">${esc(A.accounts.find(a=>a.id===p.account)?.email||p.account||'—')}</span><span class="num-r"><button class="btn sm ghost danger" data-act="delproxy:${p.id}" ${p.account?'disabled':''} aria-label="删除">${ic('trash')}</button></span></div>`).join('')}</div>
    <div class="hstack mt"><input class="input mono" id="f-proxy" placeholder="socks5://user:pass@host:port" autocomplete="off" spellcheck="false" style="flex:1"><button class="btn" data-act="addproxy">${ic('plus')}添加</button></div>`,false)}
  ${fold('shops','买号渠道',A.sw?.shops===false?dotChip('','已隐藏'):cnt((A.shops||[]).length),`
    ${swRule('显示买号渠道','shops',A.sw?.shops!==false)}
    <div id="shop-edit">${(A.shops||[]).map(shopRow).join('')}</div>
    <div class="hstack mt"><button class="btn sm" data-act="shopadd">${ic('plus')}添加</button><button class="btn primary sm" data-act="shopsave">保存</button></div>`,false)}`,
    fwd:()=>`${fold('rules','大锅饭规则',`<span class="fold-sum">${r.dailyBase} + ${r.dailyPer}/号 · ${r.keyConc} 并发 · ${r.keyRpm}/min · 单号 ${r.accConc}${r.accRpm?'/'+r.accRpm+'m':''} · 保留 ${reserveText(r.reserve)} · 输入 ${r.sharedInput?Math.round(r.sharedInput/1e4)+' 万':'不限'}</span>`,`
    <div class="rule"><h3>大锅饭 Key 总并发 / 限速</h3><div class="hstack"><input class="input" type="number" min="1" max="200" data-rule="keyConc" value="${r.keyConc}" aria-label="大锅饭 Key 总并发"><small>并发</small><input class="input" type="number" min="1" max="10000" data-rule="keyRpm" value="${r.keyRpm}" aria-label="大锅饭 Key 总限速"><small>次/分</small></div></div>
    <div class="rule"><h3>单号并发 / 限速</h3><div class="hstack"><input class="input" type="number" min="1" max="20" data-rule="accConc" value="${r.accConc}" aria-label="单号并发上限"><small>并发</small><input class="input" type="number" min="0" max="1000" data-rule="accRpm" value="${r.accRpm??10}" aria-label="单号每分钟上限"><small>次/分</small></div></div>
    <div class="rule"><div><h3>每日次数</h3><p>每人每天 = 基础 + 共享的 Pro 号数 × 加成；管理员不限</p></div><div class="hstack"><input class="input" type="number" min="0" max="1000000" data-rule="dailyBase" value="${r.dailyBase}" aria-label="基础次数"><small>基础</small><input class="input" type="number" min="0" max="1000000" data-rule="dailyPer" value="${r.dailyPer}" aria-label="每个共享号加成"><small>/ 号</small></div></div>
    <div class="rule"><div><h3>大锅饭输入上限</h3><p>一次请求的输入超过就拦下并在 Discord @ 本人；0 = 不限</p></div><div class="hstack"><input class="input" type="number" min="0" max="10000000" step="10000" data-rule="sharedInput" value="${r.sharedInput??500000}" aria-label="大锅饭输入上限"><small>Token</small></div></div>
    <div class="rule"><div><h3>开放的模型</h3><p>大锅饭 Key 能用、能在模型列表里看到的模型</p></div><div class="hstack"><span class="faint">${A.sharedAllow==null?'全部':A.sharedAllow.length+' 个'}</span><button class="btn sm" data-act="sharedmodels">${ic('layers')}选择</button></div></div>
    <div class="rule"><div><h3>默认自用保留</h3><p>号主共享时没自己选的，就用这个</p></div><div class="seg" role="radiogroup" aria-label="自用保留比例">${[0,20,30,50].map(v=>`<label><input type="radio" name="reserve" value="${v}" ${r.reserve===v?'checked':''}><span>${reserveText(v)}</span></label>`).join('')}</div></div>`,false)}
  ${upCard(A.upstreams||[])}
  ${A.retry?fold('retry','上游重试',`<span class="fold-sum">${A.retry.requestRetry} 轮 · 最多等 ${A.retry.maxRetryInterval}s</span>`,`
    <div class="rule"><div><h3>重试轮数 / 每轮最多换号</h3><p>在 CLIProxyAPI 配置里改</p></div><div class="val mono">${A.retry.requestRetry} 轮 · ${A.retry.maxRetryCredentials||'不限'} 个</div></div>
    <div class="rule"><div><h3>最大等待时长</h3><p>名单内的号都在冷却时，最多等这么久再重试；0 = 不等</p></div><div class="hstack"><input class="input" type="number" min="0" max="300" data-retry="maxWait" value="${A.retry.maxRetryInterval}" aria-label="最大等待时长"><small>秒</small></div></div>`,false):''}
  ${sfCard(A.sf)}`,
    site:()=>`${fold('site','Discord 登录',siteOK?dotChip('good','已配置'):dotChip('bad','未配置'),`
    <div class="kv">
      <span>站点地址</span><input class="input mono" data-site="publicURL" value="${esc(s.publicURL)}" placeholder="https://pot.example.com">
      <span>Redirect URI</span><div class="code"><span>${esc(s.redirectURI||'—')}</span><button class="btn sm ghost" data-act="copy:redirect" ${s.redirectURI?'':'disabled'}>${ic('copy')}复制</button></div>
      <span>Client ID</span><input class="input mono" data-site="clientId" value="${esc(s.clientId)}">
      ${secretField('Client Secret','clientSecret',s.clientSecretSet)}
      <span>Guild ID</span><input class="input mono" data-site="guildId" value="${esc(s.guildId)}">
      <span>Role IDs</span><input class="input mono" data-site="roleIds" value="${esc(s.roleIds)}">
      ${secretField('Bot Token','botToken',s.botTokenSet)}
      <span>管理员 Discord ID</span><input class="input mono" data-site="adminIds" value="${esc(s.adminIds)}">
    </div>
    <div class="mt-l"><button class="btn primary" data-act="savesite">保存</button></div>`,!siteOK)}
  ${botCard(A.bot,s)}
  ${brAdmin(A.br)}`,
  }[tab];
  return head('管理员后台',`<a class="cpa-link" href="cpa/" target="_blank" rel="noopener"><span class="cpa-ic">${ic('sliders')}</span><span><b>CLIProxyAPI</b><small>管理面板</small></span>${ic('ext')}</a>`)+tabs+urgent+body();
}
/* 模型选择：大锅饭 / 外部上游开放哪些模型 */
let mp=null; // {kind:'shared'|'up', id, all:[{id,from}], allow:null|[]}
function modelPicker(){
  const M=mp,sel=new Set(M.allow||[]),allOn=M.allow==null;
  const row=m=>`<label class="mp-row" data-mid="${esc(m.id.toLowerCase())}"><input type="checkbox" value="${esc(m.id)}" ${allOn||sel.has(m.id)?'checked':''}>${famIc(m.id)}<span class="mono">${esc(m.id)}</span>${(m.from||[]).map(f=>`<span class="mp-src">${esc(f==='google'?'Google':f)}</span>`).join('')}</label>`;
  openDialog(M.kind==='shared'?'大锅饭开放的模型':`${esc(M.name)} 开放的模型`,M.kind==='shared'?'只影响大锅饭 Key，小锅饭不受影响':'只有勾选的模型会转发到这个上游',
    `<div class="seg full mt" role="radiogroup" aria-label="范围"><label><input type="radio" name="mpmode" value="all" ${allOn?'checked':''}><span>全部开放</span></label><label><input type="radio" name="mpmode" value="pick" ${allOn?'':'checked'}><span>只开放勾选的</span></label></div>
    <div class="mp-tools"><div class="search-sm">${ic('search')}<input class="input sm" id="mp-q" placeholder="搜索模型" aria-label="搜索模型"></div><button class="btn sm ghost" data-act="mpall:1">全选</button><button class="btn sm ghost" data-act="mpall:0">全不选</button></div>
    <div class="mp-list ${allOn?'dis':''}" id="mp-list">${M.all.length?M.all.map(row).join(''):'<p class="faint" style="padding:10px">没有拉到模型</p>'}</div>`,
    `<small class="faint" style="margin-right:auto">${M.all.length} 个模型</small><button class="btn" data-act="close">取消</button><button class="btn primary" data-act="mpsave">保存</button>`,true);
}
let upEdit=null;
function upCard(L){
  const e=upEdit;
  const form=e?`<div class="up-form"><input class="input sm" id="up-name" maxlength="40" placeholder="名称，如 Tools" value="${esc(e.name||'')}"><input class="input sm mono" id="up-url" placeholder="http://127.0.0.1:8045" value="${esc(e.url||'')}"><input class="input sm mono" id="up-key" type="password" autocomplete="off" placeholder="${e.id?'API Key（不改就留空）':'API Key'}"><input class="input sm mono" id="up-mgmt" type="password" autocomplete="off" placeholder="${e.mgmtSet?'管理密钥已设（不改留空）':'CPA 管理密钥（可选）'}"><span class="hstack"><button class="btn sm ghost" data-act="upcancel">取消</button><button class="btn sm primary" data-act="upsave">${e.id?'保存':'添加'}</button></span></div>`
    :`<div class="mt"><button class="btn sm" data-act="upnew">${ic('plus')}添加上游</button></div>`;
  const rows=L.map(u=>{const m=u.models,st=!m?['','未检测']:m.error?['bad','连不上：'+m.error]:['good',u.allow?`开放 ${u.allow.length} / ${m.count} 个模型`:`${m.count} 个模型全开放`];
    return `<div class="up-row ${u.enabled?'':'off'}"><span class="u-n"><strong>${esc(u.name)}</strong><span class="sub mono">${esc(u.url)}</span></span>
      <span class="u-st ${st[0]==='bad'?'bad':''}"><span class="sdot ${st[0]||'idle'}"></span>${esc(st[1])}</span>
      <span class="faint mono">今日 ${u.today}</span>
      <span class="u-act"><button class="btn sm ghost" data-act="upmodels:${u.id}">${ic('layers')}模型</button><button class="btn sm ghost" data-act="uptest:${u.id}">${ic('refresh')}检测</button><button class="btn sm ghost icon" data-act="upedit:${u.id}" aria-label="编辑" title="编辑">${ic('pen')}</button><button class="btn sm ghost icon danger" data-act="updel:${u.id}" aria-label="删除" title="删除">${ic('trash')}</button><button class="switch" role="switch" aria-checked="${u.enabled}" aria-label="启用 ${esc(u.name)}" data-act="uptoggle:${u.id}"></button></span></div>`;}).join('');
  return fold('upstreams','外部上游（Tools）',L.length?dotChip(L.some(u=>u.enabled)?'good':'',`${L.filter(u=>u.enabled).length} 个启用`):cnt(0),
    `<p class="faint" style="font-size:12.5px;margin:-6px 0 8px">大锅饭请求会和共享号轮流走这里；号都满了或没号时，也会自动转过来。请求原样转发，换成这里的 API Key。</p>${rows}${form}`,!L.length);
}
function botChatForm(C){
  if(!C)return '';
  const srcs=C.sources||[{id:'cpa',name:'自己的号（CPA）',models:C.models}];
  const opts=srcs.map(s=>{const ms=s.id===C.source&&!s.models.includes(C.model)?[C.model,...s.models]:s.models;
    return `<optgroup label="${esc(s.name)}">${ms.map(m=>`<option value="${esc(s.id+'|'+m)}" ${s.id===C.source&&m===C.model?'selected':''}>${esc(m)}</option>`).join('')||'<option disabled>（读不到模型列表）</option>'}</optgroup>`;}).join('');
  return `<div class="bchat mt-l"><h3>@ 机器人问答</h3>
    <div class="rule"><div><h3>模型</h3><p>跑在管理员自己的号上，或用外部上游（Tools）</p></div><select class="select" id="bc-model" aria-label="问答模型">${opts}</select></div>
    <div class="bc-p"><div class="row"><h3>预设提示词${C.custom?' <span class="chip accent">自定义</span>':' <span class="chip">默认</span>'}</h3>
      <div class="hstack"><label class="btn sm">${ic('upload')}上传 .txt / .md<input type="file" id="f-botprompt" accept=".txt,.md,text/plain,text/markdown" hidden></label><button class="btn sm ghost" data-act="botpromptreset">恢复默认</button></div></div>
      <textarea class="input mono" id="bc-prompt" rows="12" spellcheck="false" aria-label="预设提示词">${esc(C.prompt)}</textarea>
      <small class="faint">站内数据（提问人最近的请求、各时段排行、报错原因）会自动接在提示词后面，不用写进去。</small></div>
    <div class="mt"><button class="btn sm primary" data-act="botchatsave">保存</button></div>
    <div class="bc-p"><div class="row"><h3>知识库 <span class="chip">${(D.admin.kb||[]).length} 篇</span></h3>
      <label class="btn sm">${ic('upload')}上传 .md / .txt（可多选）<input type="file" id="f-kb" accept=".txt,.md,text/plain,text/markdown" multiple hidden></label></div>
      <small class="faint">酒馆教程、FAQ、群公告之类。有人提问时，机器人会挑最相关的几段来回答。</small>
      <div class="hstack"><input class="input sm" id="kb-url" placeholder="或粘贴网页地址导入，例如 https://docs.sillytavern.app/…" style="flex:1"><button class="btn sm" data-act="kburl">导入网页</button></div>
      <div class="kb-list">${(D.admin.kb||[]).map(d=>`<div class="kb-row"><span class="kb-t" title="${esc(d.source||'')}">${esc(d.title)}</span><small class="faint mono">${(d.size/1000).toFixed(1)}k 字${d.source?' · 网页':''}</small><button class="btn sm ghost danger icon" data-act="kbdel:${d.id}" aria-label="删除 ${esc(d.title)}">${ic('trash')}</button></div>`).join('')||'<small class="faint">还没有文档</small>'}</div></div></div>`;
}
function botCard(B,s){
  if(!B)return `<section class="card glass"><div class="card-head"><h2>Discord 机器人</h2></div><p class="faint">读取失败，点右上角刷新再试</p></section>`;
  const step=(n,done,title,body)=>`<div class="bstep ${done?'done':''}"><span class="bnum">${done?ic('check'):n}</span><div class="bbody"><b>${title}</b>${body}</div></div>`;
  const ready=B.inGuild&&B.channelId&&B.connected;
  let s1;
  if(!B.tokenSet)s1=`<small>先在上面「Discord 登录」里填好 Bot Token 并保存</small>`;
  else if(B.error==='bad_token')s1=`<small class="bad-t">Bot Token 无效，请在上面「Discord 登录」里替换</small>`;
  else if(!B.guildSet)s1=`<small>先在上面「Discord 登录」里填好 Guild ID（服务器 ID）</small>`;
  else if(B.inGuild)s1=`<small>「${esc(B.botName||'机器人')}」已经在服务器里</small>`;
  else s1=`<small>点下面的按钮，在弹出的页面里选你的服务器，点「授权」。完成后回来点「刷新」</small><div class="hstack mt"><a class="btn sm primary" href="${esc(B.invite)}" target="_blank" rel="noopener noreferrer">${ic('ext')}邀请机器人进服务器</a><button class="btn sm" data-act="botrefresh">${ic('refresh')}刷新</button></div>`;
  const s2=B.inGuild?`<small>号出问题的提醒和每日日报都发到这里。机器人要能在这个频道发言</small>
    <div class="bpick mt"><select class="select" data-site="botChannelId" aria-label="频道"><option value="">选择频道</option>${B.channels.map(c=>`<option value="${esc(c.id)}" ${B.channelId===c.id?'selected':''}># ${esc(c.name)}</option>`).join('')}</select>
    <select class="select" data-site="dailyHour" aria-label="日报时间"><option value="-1" ${B.dailyHour===-1?'selected':''}>不发日报</option>${Array.from({length:24},(_,h)=>`<option value="${h}" ${B.dailyHour===h?'selected':''}>每天 ${pad(h)}:00 发日报</option>`).join('')}</select>
    <button class="btn sm primary" data-act="savesite">保存</button></div>
    <small class="faint mt">找不到的话（比如已归档的子区），在 Discord 里右键它 →「复制频道 ID」，选好日报时间后在这里粘贴并保存：</small>
    <div class="bpick"><input class="input sm mono" id="bot-ch-id" placeholder="频道或子区 ID" style="max-width:240px"><button class="btn sm" data-act="botchid">用这个 ID</button></div>`:`<small class="faint">完成第 1 步后出现</small>`;
  const s3=B.connected?`<small>已连接，频道里输入 <span class="mono">/我的号</span> 或 <span class="mono">/今日榜</span> 试试</small>`
    :B.tokenSet&&!B.error?`<small>自动把 Interactions Endpoint URL 填到 Discord 开发者后台，并注册命令</small><div class="mt"><button class="btn sm primary" data-act="botconnect">一键连接</button></div>`:`<small class="faint">完成第 1 步后可用</small>`;
  return fold('bot','Discord 机器人',ready?dotChip('good','已启用'):dotChip('','未完成'),`
    ${swRule('@ 人','mentions',D.admin.sw?.mentions!==false)}
    ${D.admin.sw?.mentions!==false?swRule('仅补货通知','stockOnly',!!D.admin.sw?.stockOnly,'sw-sub'):''}
    ${stockBox(D.admin.stock)}
    ${swRule('主动发消息','proactive',!!D.admin.sw?.proactive)}
    <div class="bsteps">${step(1,B.inGuild,'邀请机器人进服务器',s1)}${step(2,B.inGuild&&!!B.channelId,'选择提醒频道',s2)}${step(3,B.connected,'连接斜杠命令',s3)}${step(4,!!B.chat?.connected,'@ 机器人问答',B.chat?.connected?`<small>已上线，在频道里 @ 机器人问报错或排行（模型 <span class="mono">${esc(B.chat.model)}</span>，跑在管理员自己的号上）</small>`:B.chat?.error?`<small class="bad-t">${esc(B.chat.error)}</small><small class="faint">打开后等几分钟会自动重连</small>`:`<small class="faint">连接中…（需要在 Discord 开发者后台 Bot 页面打开 Message Content Intent）</small>`)}</div>
    ${B.inGuild&&B.channelId?`<div class="mt-l"><button class="btn sm" data-act="bottest">发一条测试消息</button></div>`:''}
    ${botChatForm(D.admin.botchat)}`,!ready,'号出问题自动 @ 号主；/我的号、/今日榜；每天发日报');
}
function stockBox(S){
  if(!S)return '';
  const w=new Set(S.watched),seen=new Set(S.items.map(x=>x.id));
  const row=(id,name,tags)=>`<label class="mp-row"><input type="checkbox" data-act="stockck" value="${id}" ${w.has(id)?'checked':''}><span class="stk-name">#${id} ${esc(name)}</span>${tags}</label>`;
  const rows=S.items.map(x=>row(x.id,x.name,`<span class="mp-src ${x.stock>0?'stk-in':''}">${x.stock>0?'有货 '+x.stock:'缺货'}</span><span class="mp-src">¥${x.price}</span>`))
    .concat(S.watched.filter(id=>!seen.has(id)).map(id=>row(id,'','<span class="mp-src">已下架</span>')));
  return `<div class="stk"><div class="stk-head"><h3>补货监控</h3><button class="btn sm" data-act="stockrefresh">${ic('refresh')}刷新</button></div><div class="stk-list">${rows.join('')}</div></div>`;
}
const swRule=(t,k,on,cls='')=>`<div class="rule sw-rule ${cls}"><h3>${t}</h3><button class="switch" role="switch" aria-checked="${on}" aria-label="${t}" data-act="sw:${k}"></button></div>`;
function shopRow(s={}){return `<div class="shop-row"><input class="input sm" data-shop="name" placeholder="名称" maxlength="40" value="${esc(s.name||'')}"><input class="input sm mono" data-shop="url" placeholder="https://" value="${esc(s.url||'')}"><input class="input sm" data-shop="note" placeholder="备注" maxlength="80" value="${esc(s.note||'')}"><button class="btn sm ghost danger icon" data-act="shopdel" aria-label="删除">${ic('trash')}</button></div>`;}

/* ============ 共享浏览器 ============ */
let brTimer=null,brEnd=0;
const mmss=s=>`${pad(Math.floor(s/60))}:${pad(s%60)}`;
const brLive=()=>['queued','starting','active'].includes(D.br?.state);
function brSet(v){
  D.br=v;
  if(v?.state==='active')brEnd=Date.now()+v.remainingSec*1000;
  // 排队 / 启动 / 使用中每 5 秒查一次（心跳）；在本页看着「有人在用」时也查
  const want=brLive()||(page==='browser'&&v?.state==='busy');
  if(want&&!brTimer)brTimer=setInterval(brPoll,5000);
  if(!want&&brTimer){clearInterval(brTimer);brTimer=null;}
}
async function brPoll(){
  if(!me||!cfg.browserEnabled)return;
  const prev=D.br?.state;let v;
  try{v=await api('GET','api/browser');}catch(e){return;}
  brSet(v);
  if(v.state===prev){const q=$('#br-q');if(q)q.textContent=v.position;return;}
  if(page==='browser'){if(!dialogOpen()&&loadState==='idle')render();}
  else if(v.state==='active')toastAct('浏览器已就绪','打开','goto:browser');
}
setInterval(()=>{const el=$('#br-left');if(el)el.textContent=mmss(Math.max(0,Math.round((brEnd-Date.now())/1000)));},1000);
function pageBrowser(){
  const b=D.br||{state:'idle'};
  if(b.state==='active')return `<div class="br-bar glass"><span class="chip accent br-left" id="br-left">${mmss(Math.max(0,Math.round((brEnd-Date.now())/1000)))}</span>
    <div class="hstack"><a class="btn sm" href="browser/" target="_blank" rel="noopener">${ic('ext')}新窗口打开</a><button class="btn sm danger" data-act="brleave">${ic('x')}结束</button></div></div>
    <iframe class="br-frame" src="browser/" title="浏览器" allow="clipboard-read; clipboard-write; fullscreen"></iframe>`;
  const bubble=`<div class="bubble">${ic('window')}</div>`;
  const body=b.state==='queued'?`${bubble}<h2>排队中 · 前面 <span id="br-q">${b.position}</span> 人</h2><button class="btn" data-act="brleave">取消</button>`
    :b.state==='starting'?`<span class="spin"></span><h2>正在启动…</h2>`
    :b.state==='busy'?`${bubble}<h2>有人在用</h2><button class="btn primary" data-act="brjoin">排队</button>`
    :`${bubble}<button class="btn primary" data-act="brjoin">${ic('play')}开始使用</button>`;
  return head('浏览器')+`<section class="card glass"><div class="empty">${body}</div></section>`;
}
function brAdmin(B){
  if(!B)return '';
  return fold('browser','浏览器',B.active?dotChip('good','使用中'):B.starting?dotChip('warn','启动中'):dotChip('','空闲'),`
    <div class="rule"><h3>正在使用</h3><div class="hstack"><span class="val">${B.active?`${esc(B.active.name)} · <span class="mono">${mmss(B.active.remainingSec)}</span>`:B.starting?esc(B.starting):'—'}</span><button class="btn sm danger" data-act="brkick" ${B.active?'':'disabled'}>踢出</button></div></div>
    <div class="rule"><h3>排队</h3><div class="val">${B.queue.length?B.queue.map(esc).join('、'):'—'}</div></div>`,false);
}

/* ============ Embedding / Rerank（硅基流动） ============ */
function sfRow(m={type:'embedding',free:false,enabled:true}){
  return `<div class="sf-row"><input class="input sm mono" data-sf="name" placeholder="BAAI/bge-m3" maxlength="120" value="${esc(m.name||'')}" aria-label="模型名称">
    <select class="select sm" data-sf="type" aria-label="类型"><option value="embedding" ${m.type==='embedding'?'selected':''}>Embedding</option><option value="rerank" ${m.type==='rerank'?'selected':''}>Rerank</option></select>
    <label class="sf-ck"><input type="checkbox" data-sf="free" ${m.free?'checked':''} aria-label="免费"></label>
    <label class="sf-ck"><input type="checkbox" data-sf="enabled" ${m.enabled?'checked':''} aria-label="启用"></label>
    <button class="btn sm ghost" data-act="sftest">${ic('play')}测试</button>
    <button class="btn sm ghost danger icon" data-act="sfdel" aria-label="删除">${ic('trash')}</button></div>`;
}
function sfCard(S){
  if(!S)return '';
  const on=S.enabled&&S.keySet,n=S.models.filter(m=>m.enabled).length;
  return fold('sf','Embedding / Rerank',on?dotChip('good',`${n} 个模型`):!S.enabled?dotChip('','已关闭'):dotChip('warn','未填 Key'),`
    <div class="rule sw-rule"><h3>开启</h3><button class="switch" role="switch" aria-checked="${S.enabled}" aria-label="开启 Embedding / Rerank" data-act="sfon"></button></div>
    <div class="kv">
      <span>硅基流动 API Key</span><div class="hstack">${S.keySet?`<span class="chip good">已设置 ···${esc(S.keyTail)}</span>`:''}<input class="input mono" type="password" autocomplete="new-password" id="sf-key" placeholder="${S.keySet?'不改就留空':'sk-...'}" style="flex:1"></div>
      <span>接口地址</span><input class="input mono" id="sf-base" value="${esc(S.base)}" placeholder="https://api.siliconflow.cn">
      <span>每人每分钟</span><div class="hstack"><input class="input" type="number" min="0" max="100000" id="sf-rpm" value="${S.rpm}" style="max-width:140px"><small>次</small></div>
    </div>
    <div class="sf-list mt-l"><div class="sf-row th"><span>模型</span><span>类型</span><span>免费</span><span>启用</span><span></span><span></span></div><div id="sf-edit">${S.models.map(sfRow).join('')}</div></div>
    <div class="hstack mt"><button class="btn sm" data-act="sfadd">${ic('plus')}添加模型</button><button class="btn primary sm" data-act="sfsave">保存</button></div>`,!on);
}

function pageLoading(){
  return `<div class="head"><div style="width:100%"><div class="sk" style="height:30px;width:220px"></div></div></div>
  <div class="grid g4">${'<div class="stat glass"><div class="sk" style="height:14px;width:60%"></div><div class="sk mt" style="height:30px;width:40%"></div></div>'.repeat(4)}</div>
  <section class="card glass"><div class="hstack"><span class="spin"></span><span class="dim">加载中…</span></div><div class="sk mt" style="height:64px"></div><div class="sk mt-s" style="height:64px"></div></section>`;
}
function pageError(){
  return `<section class="card glass">${empty('wifi','加载失败',`<button class="btn primary" data-act="retry">${ic('refresh')}重试</button>`)}</section>`;
}

/* ============ 公告 ============ */
let ANN={list:[],seen:0,unread:0},annEdit=null;
function md(t){
  const inline=x=>esc(x).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,'$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  const out=[];let ul=false;
  for(const line of String(t||'').split('\n')){
    const m=/^\s*[-*•]\s+(.*)$/.exec(line);
    if(m){if(!ul){out.push('<ul>');ul=true;}out.push(`<li>${inline(m[1])}</li>`);continue;}
    if(ul){out.push('</ul>');ul=false;}
    out.push(line.trim()?`<p>${inline(line)}</p>`:'');
  }
  if(ul)out.push('</ul>');
  return out.join('');
}
const annDate=t=>{const d=new Date(t);return `${d.getMonth()+1} 月 ${d.getDate()} 日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;};
function annItem(a,unread){
  return `<article class="ann ${a.level==='important'?'imp':''}"><div class="ann-h">${a.pinned?`<span class="ann-tag pin">置顶</span>`:''}${a.level==='important'?`<span class="ann-tag imp">重要</span>`:''}${unread?'<span class="ann-new">NEW</span>':''}<b>${esc(a.title)}</b><time>${annDate(a.created)}</time></div>${a.body?`<div class="ann-b">${md(a.body)}</div>`:''}</article>`;
}
async function loadAnn(){try{ANN=await api('GET','api/announcements');}catch(e){}}
async function annDialog(){
  const seen=ANN.seen;
  openDialog(`${ic('bell')}公告`,'',ANN.list.length?`<div class="ann-list">${ANN.list.map(a=>annItem(a,a.id>seen)).join('')}</div>`:empty('bell','还没有公告'),`<button class="btn primary" data-act="close">知道了</button>`,true);
  if(ANN.unread){try{await api('POST','api/announcements/seen');}catch(e){}ANN.unread=0;ANN.seen=Math.max(0,...ANN.list.map(a=>a.id));const b=$('.bell');if(b)b.classList.remove('on');}
}
function annBanner(){
  const a=ANN.list.find(x=>x.pinned);if(!a)return '';
  const first=String(a.body||'').split('\n').find(l=>l.trim())||'';
  return `<button type="button" class="ann-banner ${a.level==='important'?'imp':''}" data-act="anns">${ic('bell')}<b>${esc(a.title)}</b><span>${esc(first.replace(/[*`]/g,''))}</span>${ic('arrow')}</button>`;
}
function annAdmin(){
  const e=annEdit||{},bot=D.admin?.bot,botOK=bot?.inGuild&&bot?.channelId;
  const form=`<div class="ann-form">
    <input class="input" id="an-title" maxlength="80" placeholder="标题" value="${esc(e.title||'')}">
    <textarea class="input" id="an-body" rows="5" maxlength="4000" placeholder="正文（支持 **加粗**、\`代码\`、- 列表、链接）">${esc(e.body||'')}</textarea>
    <div class="ann-opts">
      <div class="seg" role="radiogroup" aria-label="级别"><label><input type="radio" name="an-level" value="info" ${e.level!=='important'?'checked':''}><span>普通</span></label><label><input type="radio" name="an-level" value="important" ${e.level==='important'?'checked':''}><span>重要</span></label></div>
      <label class="ann-ck"><input type="checkbox" id="an-pin" ${e.pinned?'checked':''}>置顶到概览</label>
      ${e.id?'':`<label class="ann-ck ${botOK?'':'dis'}" title="${botOK?'':'机器人还没配好'}"><input type="checkbox" id="an-dc" ${botOK?'':'disabled'}>同时发到 Discord</label>`}
      <span class="ann-btns">${e.id?`<button class="btn sm ghost" data-act="ancancel">取消编辑</button>`:''}<button class="btn sm primary" data-act="ansave">${e.id?'保存修改':'发布'}</button></span>
    </div></div>`;
  const list=ANN.list.map(a=>`<div class="ann-row"><span class="ann-rt">${a.pinned?'<span class="ann-tag pin">置顶</span>':''}${a.level==='important'?'<span class="ann-tag imp">重要</span>':''}<b>${esc(a.title)}</b></span><time>${annDate(a.created)}</time><span class="ann-ra"><button class="btn sm ghost icon" data-act="anedit:${a.id}" aria-label="编辑" title="编辑">${ic('pen')}</button><button class="btn sm ghost icon danger" data-act="andel:${a.id}" aria-label="删除" title="删除">${ic('trash')}</button></span></div>`).join('');
  return fold('ann','公告',cnt(ANN.list.length),form+(list?`<div class="ann-rows">${list}</div>`:''),true);
}

/* ============ 外壳 ============ */
let loadState='idle';
/* ============ Token 统计 ============ */
const SCOL=['#0a7cff','#8b5cf6','#14b8a6','#f59e0b','#ec4899','#94a3b8'];
function tk(n){n=Number(n)||0;const f=(v,u)=>(v>=100?v.toFixed(0):v>=10?v.toFixed(1):v.toFixed(2)).replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,'')+u;return n>=1e9?f(n/1e9,'B'):n>=1e6?f(n/1e6,'M'):n>=1e3?f(n/1e3,'K'):String(n);}
const pct=(a,b)=>b?Math.round(a/b*1000)/10:0;
const sCol=(S,name)=>SCOL[name==='其他'?5:Math.max(0,S.series.indexOf(name))%5];
const RANGE=[['24h','24 小时'],['7d','7 天'],['30d','30 天'],['90d','90 天']];
function stSeg(name,opts,cur,label){return `<div class="seg" role="radiogroup" aria-label="${label}">${opts.map(([v,l])=>`<label><input type="radio" name="${name}" value="${v}" ${cur===v?'checked':''}><span>${l}</span></label>`).join('')}</div>`;}
function donut(S){
  const tot=S.models.reduce((n,m)=>n+m.tok,0),C=2*Math.PI*46;let off=0;
  const parts=S.series.map(n=>[n,n==='其他'?S.models.slice(5).reduce((a,m)=>a+m.tok,0):(S.models.find(m=>m.name===n)?.tok||0)]);
  const arcs=tot?parts.map(([n,v])=>{const len=v/tot*C,a=`<circle r="46" cx="60" cy="60" fill="none" stroke="${sCol(S,n)}" stroke-width="13" stroke-dasharray="${Math.max(len-1.5,0)} ${C}" stroke-dashoffset="${-off}"><title>${esc(n)} · ${tk(v)}</title></circle>`;off+=len;return a;}).join(''):'';
  return `<div class="st-mix"><svg class="st-donut" viewBox="0 0 120 120" role="img" aria-label="模型占比"><circle r="46" cx="60" cy="60" fill="none" stroke="var(--fill-2)" stroke-width="13"/><g transform="rotate(-90 60 60)">${arcs}</g>
    <text x="60" y="58" text-anchor="middle" class="st-dn">${tk(tot)}</text><text x="60" y="74" text-anchor="middle" class="st-dl">Tokens</text></svg>
    <div class="st-legend">${parts.map(([n,v])=>`<div class="st-li"><i style="background:${sCol(S,n)}"></i><span class="mono" title="${esc(n)}">${esc(n)}</span><b>${tk(v)}</b><small>${pct(v,tot)}%</small></div>`).join('')||'<small class="faint">暂无数据</small>'}</div></div>`;
}
function trendBars(S){
  const max=Math.max(1,...S.trend.map(b=>Object.values(b.by).reduce((a,v)=>a+v,0)));
  const hourly=S.step<864e5,every=Math.ceil(S.trend.length/12);
  const lab=t=>{const d=new Date(t);return hourly?pad(d.getHours())+':00':`${d.getMonth()+1}/${d.getDate()}`;};
  return `<div class="st-trend" role="img" aria-label="用量趋势">${S.trend.map((b,i)=>{const sum=Object.values(b.by).reduce((a,v)=>a+v,0);
    const tip=`${lab(b.t)} · ${tk(sum)} · ${b.req} 次\n`+S.series.filter(n=>b.by[n]).map(n=>`${n}：${tk(b.by[n])}`).join('\n');
    return `<div class="st-col" title="${esc(tip)}"><div class="st-stack" style="height:${sum/max*100}%">${S.series.map(n=>b.by[n]?`<i style="flex:${b.by[n]};background:${sCol(S,n)}"></i>`:'').join('')}</div><small>${i%every===0?lab(b.t):''}</small></div>`;}).join('')}</div>`;
}
function heatMap(S){
  const max=Math.max(1,...S.heat),act=S.heat.filter(Boolean).length;
  const lv=v=>!v?0:v<max*.25?1:v<max*.5?2:v<max*.75?3:4;
  let streak=0;for(let i=S.heat.length-1;i>=0&&S.heat[i];i--)streak++;
  const peak=S.heat.indexOf(Math.max(...S.heat)),day=i=>{const d=new Date(S.heatStart+i*864e5);return `${d.getMonth()+1}/${d.getDate()}`;};
  return `<div class="st-heatwrap"><div class="st-heat" role="img" aria-label="91 天活跃度">${S.heat.map((v,i)=>`<i class="l${lv(v)}" title="${day(i)} · ${tk(v)}"></i>`).join('')}</div>
    <div class="st-kv"><div><small>91 天合计</small><b>${tk(S.heat.reduce((a,v)=>a+v,0))}</b></div><div><small>活跃天数</small><b>${act} 天</b></div><div><small>连续活跃</small><b>${streak} 天</b></div>${max>1?`<div><small>峰值日 ${day(peak)}</small><b>${tk(max)}</b></div>`:''}</div></div>`;
}
function rhythm(S){
  const max=Math.max(1,...S.hours),peak=S.hours.indexOf(Math.max(...S.hours));
  return `<div class="st-rhythm" role="img" aria-label="24 小时分布">${S.hours.map((v,h)=>`<div class="st-col" title="${pad(h)}:00 · ${tk(v)}"><div class="st-stack ${h===peak&&v?'pk':''}" style="height:${v/max*100}%"><i></i></div><small>${h%6===0?pad(h):''}</small></div>`).join('')}</div>
    <p class="faint st-note">${S.hours.some(Boolean)?`近 30 天最忙在 ${pad(peak)}:00`:'近 30 天暂无数据'}</p>`;
}
function perfCard(S){
  const T=S.totals,P=S.perf||{},hit=T.in?Math.min(T.cache/T.in,1):0,ok=T.req?T.ok/T.req:0;
  const fast=P.n?Math.max(0,Math.min(1,(20000-P.ttft)/18000)):0;
  const score=T.req?Math.round(ok*40+hit*30+fast*30):0,col=score>=70?'var(--good)':score>=40?'var(--warn)':'var(--bad)';
  const ms=v=>!v?'—':v<1000?v+' ms':(v/1000).toFixed(1)+' s';
  const tip=`成功率 ${pct(T.ok,T.req)}%（占 40 分）+ 缓存命中 ${Math.round(hit*1000)/10}%（占 30 分）+ 首字速度（≤2 秒满分，≥20 秒 0 分，占 30 分）`;
  return `<div class="st-gauge" title="${esc(tip)}"><svg viewBox="0 0 200 116" role="img" aria-label="效能指数 ${score}"><path d="M18 104 A82 82 0 0 1 182 104" pathLength="100" fill="none" stroke="var(--fill-2)" stroke-width="14" stroke-linecap="round"/>
    ${score?`<path d="M18 104 A82 82 0 0 1 182 104" pathLength="100" fill="none" stroke="${col}" stroke-width="14" stroke-linecap="round" stroke-dasharray="${score} 100"/>`:''}
    <text x="100" y="92" text-anchor="middle" class="st-gn">${T.req?score:'—'}</text><text x="100" y="110" text-anchor="middle" class="st-dl">效能指数</text></svg></div>
  <div class="st-kv st-pkv"><div><small>缓存命中率</small><b>${Math.round(hit*1000)/10}%</b></div><div><small>首字延迟</small><b>${ms(P.ttft)}</b></div>
    <div><small>输出速度</small><b>${P.speed?P.speed+' tok/s':'—'}</b></div><div><small>平均耗时</small><b>${ms(P.latency)}</b></div>
    <div><small>复用 Token</small><b>${tk(T.cache)}</b></div><div><small>未缓存输入</small><b>${tk(Math.max(T.in-T.cache,0))}</b></div>
    <div><small>平均思考 / 次</small><b>${tk(T.req?Math.round(T.think/T.req):0)}</b></div><div><small>成功率</small><b>${pct(T.ok,T.req)}%</b></div></div>`;
}
function rank(list,empty){
  if(!list?.length)return `<p class="faint" style="padding:6px 0">${empty}</p>`;
  const max=Math.max(1,...list.map(x=>x.tok));
  return `<div class="st-rank">${list.map((x,i)=>`<div class="st-ri"><span class="st-no ${i<3?'st-top':''}">${i+1}</span><div class="st-rb"><div class="st-rh"><span class="mono" title="${esc(x.name)}">${esc(x.name)}</span>${x.own?'<span class="chip">我的</span>':''}<b>${tk(x.tok)}</b></div><div class="meter"><span style="width:${Math.max(x.tok/max*100,1)}%;background:var(--accent)"></span></div><small>${x.req.toLocaleString()} 次</small></div></div>`).join('')}</div>`;
}
function stModelTable(S){
  const T=S.totals.tok;
  return `<div class="tbl st-tbl"><div class="tr th"><span>模型</span><span class="num-r">请求</span><span class="num-r">输入</span><span class="num-r">输出</span><span class="num-r">思考</span><span class="num-r">缓存命中</span><span class="num-r">合计</span><span class="num-r">占比</span></div>
    ${S.models.map(m=>`<div class="tr"><span class="mono st-mn" title="${esc(m.name)}"><i style="background:${sCol(S,S.series.includes(m.name)?m.name:'其他')}"></i>${esc(m.name)}</span><span class="num-r mono">${m.req.toLocaleString()}</span><span class="num-r mono">${tk(m.in)}</span><span class="num-r mono">${tk(m.out)}</span><span class="num-r mono">${tk(m.think)}</span><span class="num-r mono">${tk(m.cache)}</span><span class="num-r mono"><b>${tk(m.tok)}</b></span><span class="num-r mono">${pct(m.tok,T)}%</span></div>`).join('')||`<p class="faint" style="padding:10px 0">这段时间没有请求</p>`}</div>`;
}
function pageStats(){
  const S=D.stats,st=ui.st,T=S.totals,all_=S.scope==='all';
  const ctl=`${S.admin?stSeg('stScope',[['all','全站'],['mine','我的']],S.scope,'统计范围'):''}${stSeg('stView',[['overview','总览'],['detail','明细']],st.view,'视图')}${stSeg('stRange',RANGE,S.range,'时间段')}`;
  const ioIn=pct(T.in,T.in+T.out+T.think);
  const kpi=`<div class="grid g4">
    <div class="stat glass mine"><div class="label">${ic('chart')}总消耗</div><div class="num">${tk(T.tok)}</div>
      <div class="st-io" title="输入 ${tk(T.in)} · 输出 ${tk(T.out)} · 思考 ${tk(T.think)}"><span style="width:${ioIn}%"></span></div><small>输入 ${tk(T.in)} · 输出 ${tk(T.out+T.think)}</small></div>
    <div class="stat glass mine"><div class="label">${ic('activity')}请求</div><div class="num">${T.req.toLocaleString()}</div><small>成功率 ${pct(T.ok,T.req)}% · 均次 ${tk(T.req?Math.round(T.tok/T.req):0)}</small></div>
    <div class="stat glass"><div class="label st-cache">${ic('layers')}缓存命中</div><div class="num">${tk(T.cache)}</div><small>占输入 ${pct(T.cache,T.in)}%</small></div>
    <div class="stat glass give"><div class="label">${ic('users')}活跃</div><div class="num">${T.accounts}<small>个号</small></div><small>${T.models} 个模型${all_?` · ${T.users} 位用户`:''}</small></div>
  </div>`;
  const body=st.view==='detail'
    ?`<section class="card glass"><div class="card-head"><div><h2>按模型</h2><p>${S.models.length} 个模型</p></div></div>${stModelTable(S)}</section>`
    :`<div class="grid st-g">
      <section class="card glass"><div class="card-head"><h2>模型构成</h2></div>${donut(S)}</section>
      <section class="card glass"><div class="card-head"><h2>用量趋势</h2><small class="faint">${S.step<864e5?'按小时':'按天'}</small></div>${trendBars(S)}</section>
    </div>
    <div class="grid st-g3">
      <section class="card glass"><div class="card-head"><h2>活跃度</h2><small class="faint">近 91 天</small></div>${heatMap(S)}</section>
      <section class="card glass"><div class="card-head"><h2>24 小时节奏</h2></div>${rhythm(S)}</section>
      <section class="card glass st-perf"><div class="card-head"><h2>效能指数</h2><small class="faint">成功的请求</small></div>${perfCard(S)}</section>
    </div>`;
  const ranks=`<div class="grid ${all_?'g2':''}">
    <section class="card glass"><div class="card-head"><h2>账号消耗榜</h2><small class="faint">前 ${S.byAccount.length}</small></div>${rank(S.byAccount,'暂无数据')}</section>
    ${all_?`<section class="card glass"><div class="card-head"><h2>用户消耗榜</h2><small class="faint">前 ${S.byUser.length}</small></div>${rank(S.byUser,'暂无数据')}</section>`:''}
  </div>`;
  return head('Token 统计',ctl)+kpi+body+ranks;
}

/* 顶栏选中项：同步 aria-current、公告红点，下划线弹到新位置 */
function syncNav(){
  document.querySelectorAll('.tnav button,.mnav button').forEach(b=>b.setAttribute('aria-current',b.dataset.act==='goto:'+page?'page':'false'));
  const bell=document.querySelector('.top .bell');if(bell)bell.classList.toggle('on',!!ANN.unread);
  moveInd(true);
}
function moveInd(anim){
  const n=document.querySelector('.tnav'),i=n?.querySelector('.tnav-ind'),b=n?.querySelector('button[aria-current=page]');
  if(!i)return;
  if(!b||!b.offsetWidth){i.style.opacity='0';return;}
  if(!anim)i.style.transition='none';
  i.style.opacity='1';i.style.left=(b.offsetLeft+b.offsetWidth/2-9)+'px';i.style.top=(b.offsetTop+b.offsetHeight-4)+'px';
  if(!anim){void i.offsetWidth;i.style.transition='';}
}
addEventListener('resize',()=>moveInd(false));
function render(){
  const root=$('#root');
  if(!me){root.innerHTML=loginView();return;}
  if(!navPages().some(p=>p[0]===page))page='home';
  const views={home:pageHome,accounts:pageAccounts,pool:pagePool,keys:pageKeys,logs:pageLogs,stats:pageStats,browser:pageBrowser,profile:pageProfile,users:pageUsers,admin:pageAdmin};
  let main;
  if(loadState==='loading')main=pageLoading();
  else if(loadState==='error')main=pageError();
  else{try{main=views[page]();}catch(e){console.error(e);main=pageError();}}
  // 顶栏不重画：只换主体内容，选中下划线弹过去
  const navKey=[navPages().map(p=>p[0]).join(),me.role,me.realRole||'',isDark()?'d':'l'].join('|');
  const hdr=root.querySelector('.top');
  if(hdr&&hdr.dataset.nav===navKey&&document.getElementById('main')){document.getElementById('main').innerHTML=main;syncNav();}
  else{
  root.innerHTML=`<div class="app">
    <div class="content"><div class="wrap">
      <header class="top glass${navPages().length>7?" many":""}" data-nav="${esc(navKey)}">
        <div class="top-left"><button type="button" class="btn sm ghost icon nav-tog" data-act="navtog" aria-label="菜单">${ic('menu')}</button>${me?.realRole==='admin'?'<div class="brand tb tb-btn" data-act="viewas">':'<div class="brand tb">'}${logoImg()}<span class="tb-name">Antigravity<i class="me">together</i></span></div></div>
        <nav class="tnav has-ind" aria-label="主导航">${navBtns()}<span class="tnav-ind" aria-hidden="true"></span></nav>
        <div class="top-right"><button class="btn sm ghost icon bell ${ANN.unread?'on':''}" data-act="anns" aria-label="公告${ANN.unread?`（${ANN.unread} 条未读）`:''}" title="公告">${ic('bell')}</button><button class="btn sm ghost icon" data-act="reload" aria-label="刷新">${ic('refresh')}</button>${themeBtn()}</div>
      </header>
      <div class="nav-shade" data-act="navtog"></div><aside class="mnav glass" aria-label="主导航">${navBtns(true)}</aside>
      <main id="main" tabindex="-1">${main}</main>
      <footer class="credit">Made with 🦴 by 聪明绝顶二狗子</footer>
    </div></div>
  </div>`;
  moveInd(false);}
  if(page==='accounts'&&ui.acc.focus&&loadState==='idle'){const el=document.getElementById('acc-'+cssId(ui.acc.focus));ui.acc.focus=null;if(el){el.scrollIntoView({block:'center'});el.classList.add('flash');setTimeout(()=>el.classList.remove('flash'),2200);}}
}

const logoImg=(st='')=>cfg.logo?`<img class="logo" src="logo.jpg" alt=""${st?` style="${st}"`:''}>`:`<span class="logo"${st?` style="${st}"`:''}>A</span>`;
function loginView(){
  const sso=cfg.setup&&!cfg.devLogin?`<a class="btn primary lg-btn" href="setup">${ic('shield')}初始化</a>`:cfg.discord?`<button class="btn discord lg-btn" data-act="signin">${DISCORD}使用 Discord 登录</button>`:'';
  return `<div class="login">
    <section class="login-card glass">
      <div class="lg-logo">${cfg.logo?'<img src="logo.jpg" alt="">':'<span class="logo">A</span>'}</div>
      <h1 class="lg-title"><b>Antigravity</b><i class="me">together</i></h1>
      ${sso}
      ${sso?'<div class="lg-or"><span>或使用账号密码</span></div>':''}
      <form class="lg-form" id="pwform" autocomplete="on">
        <label class="lg-f"><span>用户名</span><input class="input" id="f-user" name="username" autocomplete="username" autocapitalize="none" spellcheck="false"></label>
        <label class="lg-f"><span>密码</span><input class="input" id="f-pass" name="password" type="password" autocomplete="current-password"></label>
        <button class="btn ${sso?'':'primary'} lg-btn" type="submit">登录</button>
      </form>
      ${cfg.devLogin?`<div class="dev"><input class="input mono" id="f-devid" placeholder="Discord ID" inputmode="numeric"><input class="input" id="f-devname" placeholder="名称"><button class="btn" data-act="devlogin">Dev</button></div>`:''}
    </section>
    <footer class="credit">Made with 🦴 by 聪明绝顶二狗子</footer>
  </div>`;
}

async function load(p=page){
  page=p;loadState='loading';render();
  try{await LOADERS[p]();loadState='idle';}catch(e){if(!me)return;loadState='error';}
  render();
}
async function reload(){try{await LOADERS[page]();loadState='idle';}catch(e){loadState='error';}render();}

const isDark=()=>document.documentElement.dataset.theme==='dark';
const themeBtn=()=>`<button class="btn sm ghost icon" id="themebtn" data-act="theme" aria-label="${isDark()?'切到浅色':'切到深色'}" title="${isDark()?'切到浅色':'切到深色'}">${ic(isDark()?'sun':'moon')}</button>`;
function applyTheme(){
  const t=themePref();
  const dark=t==='dark'||(t==='auto'&&matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme=dark?'dark':'light';
  $('#themebtn')?.replaceWith(document.createRange().createContextualFragment(themeBtn()));
}

/* ============ 弹窗 ============ */
function openDialog(title,sub,body,foot,wide=false){
  if(!$('#layer').innerHTML)lastFocus=document.activeElement;
  $('#layer').innerHTML=`<div class="shade" data-shade><section class="dialog ${wide?'wide':''}" role="dialog" aria-modal="true" aria-labelledby="dlg-t">
    <div class="dialog-head"><div><h2 id="dlg-t">${title}</h2>${sub?`<p>${sub}</p>`:''}</div><button class="btn icon ghost" data-act="close" aria-label="关闭">${ic('x')}</button></div>
    ${body}<div class="dialog-foot">${foot}</div></section></div>`;
  const first=$('#layer [autofocus]')||$('#layer .dialog input:not([disabled]),#layer .dialog select')||$('#layer .dialog-foot .btn.primary')||$('#layer [data-act=close]');
  first?.focus();
}
function closeDialog(){$('#addtip')?.remove();$('#layer').innerHTML='';flow=null;mdlFor=null;if(lastFocus&&document.contains(lastFocus))lastFocus.focus();lastFocus=null;}
const dialogOpen=()=>!!$('#layer .dialog');

function toast(text,err=false){
  const t=document.createElement('div');t.className='toast'+(err?' err':'');t.innerHTML=ic(err?'alert':'check')+esc(text);
  $('#toasts').append(t);setTimeout(()=>{t.style.transition='opacity .3s';t.style.opacity='0';setTimeout(()=>t.remove(),300);},2600);
}
function toastAct(text,label,action){
  const t=document.createElement('div');t.className='toast act';t.innerHTML=`${ic('check')}${esc(text)}<button class="btn sm primary" data-act="${esc(action)}">${esc(label)}</button>`;
  const bye=()=>{t.style.transition='opacity .3s';t.style.opacity='0';setTimeout(()=>t.remove(),300);};
  t.querySelector('button').addEventListener('click',bye);
  $('#toasts').append(t);setTimeout(bye,10000);
}
function copy(text){(navigator.clipboard?.writeText(text)||Promise.reject()).then(()=>toast('已复制'),()=>toast('当前环境不允许复制',true));}

/* ============ 添加凭证 ============ */
const resultBox=(k,t,p)=>`<div class="result ${k}">${ic(k==='ok'?'check':'alert')}<div><b>${esc(t)}</b>${p?`<p>${esc(p)}</p>`:''}</div></div>`;
const loadingBox=t=>`<div class="result" style="background:var(--fill)"><span class="spin"></span><div><b>${t}</b></div></div>`;
const UPERR={invalid:'不是 Antigravity 凭证',duplicate:'账号已存在',invalid_token:'Refresh Token 无效或已失效',failed:'导入失败'};
// 叠在添加框上面的提示，关掉后回到添加框
function addTipDialog(){
  flow={};addDialog(1);
  document.body.insertAdjacentHTML('beforeend',`<div class="shade tip-shade" id="addtip" data-tipshade><section class="dialog tip-dlg" role="dialog" aria-modal="true" aria-labelledby="tip-t">
    <div class="dialog-head"><div><h2 id="tip-t">添加前先看一下</h2></div><button class="btn icon ghost" data-act="tipclose" aria-label="关闭">${ic('x')}</button></div>
    <div class="atip"><b>${ic('key')}有 Refresh Token 的话，优先用它导入</b><p>不用每次走浏览器登录，能减少 IP 来回变化带来的封号风险。</p></div>
    <div class="atip"><b>${ic('info')}用 OAuth 授权的号，建议先养几天</b><p>新号（尤其是买来的号）别一上来就高强度用：</p>
      <ol><li>导入后先用一两条，然后把它停用；</li><li>之后每隔 24 小时启用一下，再用一两条；</li><li>满 7 天后再放开用。</li></ol></div>
    <div class="dialog-foot"><button class="btn primary big" data-act="tipclose">知道了</button></div></section></div>`);
  $('#addtip [data-act=tipclose]')?.focus();
}
const closeTip=()=>{const t=$('#addtip');if(!t)return false;t.remove();$('#layer [autofocus]')?.focus();return true;};
function addDialog(step=1){
  flow=flow||{};
  const f=flow,tab=ui.addTab;
  if(step===1){
    const T=[['oauth','OAuth 授权'],['rt','Refresh Token'],['upload','文件导入']];
    const tabs=`<div class="seg full addtabs" role="radiogroup" aria-label="添加方式">${T.map(([v,l])=>`<label><input type="radio" name="addTab" value="${v}" ${tab===v?'checked':''}><span>${l}</span></label>`).join('')}</div>`;
    const note=t=>`<div class="anote">${ic('info')}<span>${t}</span></div>`;
    const hero=(i,t,p)=>`<div class="ahero"><div class="aicon">${ic(i)}</div><b>${t}</b><p>${p}</p></div>`;
    const err=f.err?resultBox('err',f.err,''):'';
    let body,foot=`<button class="btn wide-btn" data-act="close">取消</button>`;
    if(tab==='oauth'){
      body=note('会在新窗口打开 Google 登录页')+hero('globe','推荐方式','用 Google 账号登录授权，登录完把浏览器跳转后的地址粘贴回来就好。');
      if(f.waiting)body+=`<div class="mt">${loadingBox('正在确认授权…')}</div>`;
      else{
        body+=`<button class="btn primary big" data-act="oauthstart" ${f.linkLoading?'disabled':''}>${f.linkLoading?'<span class="spin"></span>正在生成链接…':(f.url?'重新打开登录页':'开始 OAuth 授权')}</button>`;
        if(f.url)body+=`<div class="field"><span>授权链接</span><button class="alink" data-act="copy:auth" title="复制授权链接">${ic('copy')}<span class="mono">${esc(f.url)}</span><b>复制授权链接</b></button></div>
          <button class="btn big-out" data-act="oauthcheck">${ic('check')}我已授权，继续</button>
          <div class="adiv"></div>
          <div class="acb-l">登录后页面打不开？把浏览器地址栏里的回调链接（或 Code）粘贴到这里：</div>
          <div class="acb"><input class="input mono" id="f-cb" placeholder="http://localhost:51121/oauth-callback?state=…&amp;code=…" autocomplete="off" spellcheck="false"><button class="btn" data-act="submitcb">${ic('arrow')}提交</button></div>`;
        body+=err;
      }
    }else if(tab==='rt'){
      body=note('一行一个，一次最多 20 个')+hero('key','用 Refresh Token 添加','邮箱和项目会自动识别，已经在小锅饭里的号会跳过。');
      body+=f.uploading?`<div class="mt">${loadingBox('正在验证…')}</div>`:`<textarea class="input mono mt" id="f-rt" rows="4" placeholder="1//0g…" autocomplete="off" spellcheck="false" aria-label="Refresh Token"></textarea>
        <button class="btn primary big" data-act="rtimport">导入</button>`;
    }else{
      body=note('支持单个 JSON、JSON 数组和 ZIP，可以一次选多个文件')+hero('upload','导入凭证文件','CLIProxyAPI 的凭证文件和这里导出的文件都能直接导入。');
      body+=f.uploading?`<div class="mt">${loadingBox('正在验证…')}</div>`:`<label class="drop" id="drop">${ic('upload')}<span>点击选择，或把文件拖到这里</span><input type="file" id="f-files" accept=".json,.zip,application/json,application/zip" multiple></label>`;
      if(D.accounts?.length)body+=`<div class="aexp"><span class="faint">要备份或搬到别处？</span><button class="btn sm ghost" data-act="export">${ic('download')}导出我的凭证</button></div>`;
    }
    openDialog('添加新账号','',tabs+body,foot);
    return;
  }
  if(step===2){
    const rs=f.results||[],ok=rs.filter(r=>r.ok);
    let box;
    if(ok.length===rs.length)box=resultBox('ok','验证通过',ok.map(r=>r.email).join('、'));
    else if(!ok.length)box=resultBox('err',rs.length===1?(UPERR[rs[0].error]||'上传失败'):'全部失败',rs.length>1?rs.map(r=>`${r.name}：${UPERR[r.error]||'上传失败'}`).join('；'):(rs[0]?.email||''));
    else box=resultBox('part','部分成功',`${rs.length} 个中 ${ok.length} 个通过`);
    openDialog('添加新账号','',box,
      ok.length?`<button class="btn" data-act="addback">返回</button><button class="btn primary" data-act="addstep3">继续${ic('arrow')}</button>`:`<button class="btn" data-act="addback">返回</button>`);
    return;
  }
  const head3=tab==='oauth'?resultBox('ok',f.reauth?'已重新授权':'授权成功',''):resultBox('ok',`已添加 ${f.added.length} 个账号`,'');
  openDialog('添加新账号','',
    head3+(f.added.length===1?`<label class="field"><span>备注</span><input class="input" id="f-accname" maxlength="40" placeholder="例如：备用账号" autofocus></label>`:'')+
    `<label class="check"><input type="checkbox" id="f-accshare"><span><b>同时放进大锅饭</b></span></label><div id="f-rsvwrap" hidden>${reservePick(null)}</div>`,
    `<button class="btn" data-act="close">取消</button><button class="btn primary" data-act="adddone">添加</button>`);
}

async function pollOAuth(){
  const f=flow;if(!f)return;
  const t0=Date.now();
  while(flow===f&&Date.now()-t0<330000){
    await new Promise(r=>setTimeout(r,1500));
    if(flow!==f)return;
    let s;try{s=await api('GET','api/accounts/oauth/'+encodeURIComponent(f.state));}catch(e){continue;}
    if(s.status==='wait')continue;
    f.waiting=false;
    if(s.status==='ok'){f.added=[s.account];f.reauth=s.message==='reauthorized';addDialog(3);}
    else if(s.status==='duplicate'){f.err='这个账号已经在小锅饭里了';addDialog(1);}
    else{f.err='授权失败，请重新开始';f.url=null;addDialog(1);}
    return;
  }
  if(flow===f){f.waiting=false;f.err='授权超时，请重新开始';f.url=null;addDialog(1);}
}

async function importTokens(text){
  const f=flow;if(!f)return;
  const n=text.split(/[\s,;]+/).filter(Boolean).length;
  if(!n){toast('请粘贴 Refresh Token',true);return;}
  if(n>20){toast('一次最多 20 个',true);return;}
  f.uploading=true;addDialog(1);
  let results;
  try{results=(await api('POST','api/accounts/refresh-token',{tokens:text})).results;}
  catch(e){results=[{name:'Refresh Token',ok:false,error:'failed'}];}
  if(flow!==f)return;
  f.uploading=false;f.results=results;f.added=results.filter(r=>r.ok).map(r=>r.account);
  addDialog(2);
}

function exportDialog(){
  const L=D.accounts||[];
  openDialog('导出凭证','导出的文件里有登录凭据，等于账号本身，别发给别人',
    L.length?`<label class="check"><input type="checkbox" data-act="exportall" checked><span><b>全选</b> <small class="faint">${L.length} 个号</small></span></label>
    <div class="explist">${L.map(a=>`<label class="exprow"><input type="checkbox" data-exp="${esc(a.id)}" checked><span><b>${esc(accName(a))}</b><small class="faint mono">${esc(a.email)}</small></span></label>`).join('')}</div>
    <div class="seg full mt" role="radiogroup" aria-label="格式"><label><input type="radio" name="expfmt" value="auto" checked><span>自动（多个打包 ZIP）</span></label><label><input type="radio" name="expfmt" value="zip"><span>ZIP</span></label><label><input type="radio" name="expfmt" value="json"><span>单个 JSON</span></label></div>`
    :empty('key','还没有凭证'),
    `<button class="btn" data-act="close">取消</button>${L.length?`<button class="btn primary" data-act="exportgo">${ic('download')}导出</button>`:''}`);
}

async function uploadFiles(files){
  const f=flow;if(!f||!files.length)return;
  f.uploading=true;addDialog(1);
  const results=[];
  for(const file of files){
    if(file.size>5*1024*1024){results.push({name:file.name,ok:false,error:'invalid'});continue;}
    try{const r=await api('POST','api/accounts/upload?name='+encodeURIComponent(file.name),undefined,await file.arrayBuffer());results.push(...r.results);}
    catch(e){results.push({name:file.name,ok:false,error:e.code==='duplicate'?'duplicate':'invalid'});}
  }
  if(flow!==f)return;
  f.uploading=false;f.results=results;f.added=results.filter(r=>r.ok).map(r=>r.account);
  addDialog(2);
}

/* ============ 详情 / 确认 ============ */
/* 查看原因：错误详情弹窗（照 agy-me reasonDialog，字段换成门户的 problem / detail / action / autoOff） */
function errMsg(raw){
  try{const i=raw.indexOf('{');if(i<0)return '';const p=JSON.parse(raw.slice(i));const e=typeof p.error==='string'?JSON.parse(p.error).error:p.error||p;return String(e?.message||'');}catch(e){return '';}
}
function reasonDialog(id){
  const a=D.accounts?.find(x=>x.id===id);if(!a)return;
  const p=a.problem,fb=a.forbidden||'',raw=fb||a.quotaErr||a.autoOff?.reason||'';
  const parsed=errMsg(raw)||a.detail||(p?p.hint:'')||raw||'上游未提供具体原因',both=!!raw&&raw!==parsed;
  const tags=[];
  if(fb)tags.push(['bad',/TOS_VIOLATION|violation of Terms|terms of service/i.test(fb)?'由于违规被禁用':'上游拒绝访问']);
  if(p)tags.push(['bad',p.label]);
  else if(a.state==='error')tags.push(['bad','账号异常']);
  if(a.action?.kind==='verify'&&p?.kind!=='verify')tags.push(['bad','需要验证账号']);
  if(a.state==='cooldown')tags.push(['warn','冷却中'+(a.retryAt?' · '+recover(a.retryAt):'')]);
  const n=modelCds(a).length;if(n)tags.push(['warn',`${n} 个模型冷却中`]);
  if(a.state==='off')tags.push(['',a.asleep?'休眠中':a.autoOff?'已自动停用':'账号已停用']);
  const url=a.action?.url||'',lab=a.action?.kind==='appeal'?'申诉':'验证';
  const at=fb&&a.quotaAt?['额度检测时间',a.quotaAt]:a.autoOff?.at?['自动停用时间',a.autoOff.at]:null;
  openDialog('错误详情','',`<div class="rs">
    <section><h3>账号</h3><div class="rs-acc">${esc(a.email||a.id)}</div></section>
    <section><h3>错误状态</h3><div class="rs-tags">${tags.length?tags.map(([c,t])=>`<span class="chip ${c}"><span class="dot"></span>${esc(t)}</span>`).join(''):esc(a.detail||'账号异常')}</div></section>
    <section><div class="rs-hd"><h3>原因</h3>${both?'<button type="button" class="link" data-act="rsraw">显示原始报文</button>':''}</div>
      <pre class="rs-body" id="rs-p">${esc(parsed)}</pre>${both?`<pre class="rs-body" id="rs-r" hidden>${esc(raw)}</pre>`:''}
      ${n?`<div class="mt-s">${cdList(a)}</div>`:''}
      <div class="rs-acts">${url?`<a class="btn sm primary" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${ic('ext')}前往${lab}</a><button type="button" class="btn sm" data-act="copyurl:${esc(a.id)}">${ic('copy')}复制${lab}链接</button>${cfg.browserEnabled?`<button type="button" class="btn sm" data-act="bropen:${esc(a.id)}">${ic('window')}内置浏览器打开</button>`:''}`:`<button type="button" class="btn sm" disabled title="上游报文未提供可用链接">前往${lab}</button><button type="button" class="btn sm" disabled title="上游报文未提供可用链接">复制${lab}链接</button>`}</div></section>
    <details><summary>账号自助排查指南</summary><p>先核对上方账号和原因。若上游要求验证，请使用该账号完成验证；若返回 TOS_VIOLATION，请通过上游提供的申诉入口提交申诉。处理后在凭证页刷新额度。</p></details>
    ${at?`<section class="rs-meta"><span class="aq-clock"></span>${at[0]}：${esc(new Date(at[1]).toLocaleString())}</section>`:''}
  </div>`,`<button class="btn primary" data-act="close">关闭</button>`);
}
function accountDetail(id){
  const a=D.accounts?.find(x=>x.id===id);if(!a)return;
  const [,,why]=accState(a),q=a.quota;
  openDialog(esc(accName(a)),esc(a.email),
    `<div class="hstack mt">${gbTag(a.tier)}${a.shared?poolTag('shared'):'<span class="chip">仅自用</span>'}${q&&q.credits!=null?`<span class="chip">积分 ${Number(q.credits).toLocaleString()}</span>`:''}</div>
    <label class="field"><span>备注</span><input class="input" id="f-note" maxlength="40" value="${esc(a.name)}" data-note="${esc(a.id)}"></label>
    ${quotaBlock(a,'dq')}
    <div class="rule mt-l"><h3>启用</h3><button class="switch" role="switch" aria-checked="${a.active}" aria-label="启用 ${esc(accName(a))}" data-act="toggle:${esc(a.id)}"></button></div>
    <div class="rule"><h3>状态</h3><div class="val hstack" style="justify-content:flex-end">${why?`<small>${esc(why)}</small>`:''}${stateChip(a)}${fixBtns(a)}</div></div>
    ${modelCds(a).length?`<div class="rule cdrule"><h3>模型冷却</h3>${cdList(a)}</div>`:''}
    ${a.shared?`<div class="rule"><div><h3>自用保留</h3><p>剩余额度低于这条线就不再给别人用</p></div><div class="seg" role="radiogroup" aria-label="自用保留">${[['def',`默认 ${reserveText(D.rules?.reserve??30)}`],...RSV.map(v=>[String(v),reserveText(v)])].map(([v,l])=>`<label><input type="radio" name="accrsv" data-acc="${esc(a.id)}" value="${v}" ${(a.reserve==null?'def':String(a.reserve))===v?'checked':''}><span>${l}</span></label>`).join('')}</div></div>`:''}
    <div class="rule"><h3>专属出口</h3><div class="val">${a.proxy?`<span class="chip good"><span class="dot"></span>已绑定</span> <span class="mono">${esc(a.proxy)}</span>`:'<span class="chip warn">未绑定</span>'}</div></div>
    <div class="hstack mt"><button class="btn sm" data-act="refreshq:${esc(a.id)}">${ic('refresh')}刷新额度</button><small class="faint">${esc(ago(a.quotaAt))}</small><button class="btn sm" data-act="reauth">${ic('ext')}重新授权</button><button class="btn sm danger" data-act="delacc:${esc(a.id)}">${ic('trash')}删除</button></div>`,
    `<button class="btn primary" data-act="close">完成</button>`,true);
}

const RSV=[0,20,30,50];
function reservePick(cur,name='rsv'){
  const def=D.rules?.reserve??30;
  return `<div class="field"><span>自用保留</span><div class="seg full" role="radiogroup" aria-label="自用保留"><label><input type="radio" name="${name}" value="def" ${cur==null?'checked':''}><span>默认 ${reserveText(def)}</span></label>${RSV.map(v=>`<label><input type="radio" name="${name}" value="${v}" ${cur===v?'checked':''}><span>${reserveText(v)}</span></label>`).join('')}</div>
    <small class="faint">某类模型剩余额度低于这条线时，这个号就不再给别人用，留着自己用。</small></div>`;
}
const pickedReserve=(name='rsv')=>{const v=$(`input[name=${name}]:checked`)?.value;return v==null||v==='def'?null:+v;};
function shareDialog(id){
  const a=D.accounts.find(x=>x.id===id);if(!a)return;
  if(a.shared){
    openDialog('撤回共享',esc(accName(a)),'',`<button class="btn" data-act="close">取消</button><button class="btn primary" data-act="confirmshare:${esc(id)}">撤回</button>`);
  }else{
    openDialog('放进大锅饭',esc(accName(a)),`<p class="dim mt">会消耗这个账号的同一份额度。</p>${reservePick(a.reserve)}`,
      `<button class="btn" data-act="close">取消</button><button class="btn primary" data-act="confirmshare:${esc(id)}">${ic('heart')}共享</button>`);
  }
}

function newKeyDialog(pool){
  const p=pool||me.defaultPool||'private';
  openDialog('创建 API 密钥','',
    `<label class="field"><span>名称</span><input class="input" id="f-keyname" maxlength="40" placeholder="例如：我的酒馆" autofocus></label>
    <div class="field"><span>账号池</span>${poolPicker('newKeyPool',p)}</div>`,
    `<button class="btn" data-act="close">取消</button><button class="btn primary" data-act="createkey">创建</button>`);
}
let createdKey=null;
function keyCreated(k){
  createdKey=k.key;
  openDialog('密钥已创建',`${esc(k.name)} · ${POOL[k.pool]}`,
    `<div class="code mt"><span>${esc(k.key)}</span><button class="btn sm ghost" data-act="copy:key">${ic('copy')}复制</button></div>`,
    `<button class="btn" data-act="connect:${k.id}">接入方式</button><button class="btn primary" data-act="close">完成</button>`);
}
function connectDialog(id){
  const k=D.keys?.find(x=>x.id===+id);if(!k)return;
  openDialog('客户端接入',`${esc(k.name)} · ${POOL[k.pool]}`,
    `<label class="field"><span>Base URL</span><div class="code"><span>${esc(baseURL())}</span><button class="btn sm ghost" data-act="copy:base">${ic('copy')}复制</button></div></label>
    <label class="field"><span>API Key</span><div class="code"><span>sk-agy-••••••••${esc(k.tail)}</span><button class="btn sm ghost" data-act="copykey:${k.id}" ${k.key?'':'disabled'}>${ic('copy')}复制</button></div></label>
    <div class="field"><span>示例</span><pre class="code">curl ${esc(baseURL())}/chat/completions \\
  -H "Authorization: Bearer sk-agy-…" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gemini-3-flash","messages":[{"role":"user","content":"hi"}]}'</pre></div>`,
    `<button class="btn primary" data-act="close">完成</button>`,true);
}

/* ============ 事件 ============ */
function go(p){closeDialog();load(p);$('#main')?.focus({preventScroll:true});window.scrollTo({top:0});}
// PATCH / quota responses carry no request strip; keep the one we already have
function keepAcc(v){const prev=D.accounts;D.accounts=D.accounts.map(x=>x.id===v.id?{...v,requests:x.requests,tokens:x.tokens}:x);return prev;}
const act=fn=>async(...a)=>{try{await fn(...a);}catch(e){fail(e);}};

document.addEventListener('click',act(async e=>{
  if(e.target.matches('[data-tipshade]')){closeTip();return;}
  if(e.target.matches('[data-shade]')){closeDialog();return;}
  if(tokPin&&!e.target.closest('#tokpop,.tk-i'))hideTokPop(true);
  const el=e.target.closest('[data-act]');if(!el||el.disabled)return;
  const i=el.dataset.act.indexOf(':');
  const a=i<0?el.dataset.act:el.dataset.act.slice(0,i),arg=i<0?'':el.dataset.act.slice(i+1);
  switch(a){
    case 'goto':document.body.classList.remove('nav-open');go(arg);break;
    case 'navtog':document.body.classList.toggle('nav-open');break;
    case 'admtab':admTab(arg);scrollTo({top:0,behavior:'smooth'});break;
    case 'brjoin':brSet(await api('POST','api/browser/join'));render();break;
    case 'bropen':brSet(await api('POST','api/browser/open',{id:arg}));go('browser');break;
    case 'brleave':brSet(await api('POST','api/browser/leave'));render();break;
    case 'brkick':await api('POST','api/admin/browser/kick');D.admin.br=await api('GET','api/admin/browser');toast('已踢出');render();break;
    case 'close':closeDialog();break;
    case 'reload':reload();break;
    case 'viewas':if(ui.st)ui.st.scope=null;await toggleViewAs();break;
    case 'retry':load(page);break;
    case 'signin':location.href='auth/discord/login';break;
    case 'devlogin':
      await api('POST','api/dev-login',{discordId:$('#f-devid').value.trim(),name:$('#f-devname').value.trim()});
      await boot();break;
    case 'logout':await api('POST','api/logout');me=null;D={};closeDialog();render();break;
    case 'add':addTipDialog();break;
    case 'tipclose':closeTip();break;
    case 'autosleep':if(me.autoSleep)await setAutoSleep(false);else sleepTipDialog();break;
    case 'sleepon':closeTip();await setAutoSleep(true);break;
    case 'theme':try{localStorage.setItem('agy-theme',isDark()?'light':'dark');}catch(err){}applyTheme();break;
    case 'reauth':flow={};ui.addTab='oauth';addDialog(1);break;
    case 'export':exportDialog();break;
    case 'rtimport':await importTokens($('#f-rt')?.value||'');break;
    case 'exportall':$$('#layer input[data-exp]').forEach(x=>x.checked=el.checked);break;
    case 'exportgo':{
      const ids=$$('#layer input[data-exp]:checked').map(x=>x.dataset.exp);
      if(!ids.length){toast('先选要导出的号',true);break;}
      const fmt=$('#layer input[name=expfmt]:checked')?.value||'auto';
      el.disabled=true;
      try{
        const r=await fetch('api/accounts/export',{method:'POST',credentials:'same-origin',headers:{'X-Portal-CSRF':'1','Content-Type':'application/json'},body:JSON.stringify({ids,format:fmt})});
        if(!r.ok){let d=null;try{d=await r.json();}catch(e){}const e=new Error(d?.error||'http_'+r.status);e.code=d?.error;throw e;}
        const name=/filename="([^"]+)"/.exec(r.headers.get('content-disposition')||'')?.[1]||'credentials.json';
        const url=URL.createObjectURL(await r.blob());const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),5000);
        closeDialog();toast(`已导出 ${ids.length} 个凭证`);
      }finally{el.disabled=false;}
      break;}
    case 'addback':{const f=flow;flow={...f,results:null,err:null,waiting:false,uploading:false};addDialog(1);break;}
    case 'oauthstart':{
      // open the window inside the click so popup blockers allow it, then point it at Google
      const w=window.open('about:blank','_blank');
      if(!flow.url){flow.linkLoading=true;flow.err=null;addDialog(1);
        try{const r=await api('POST','api/accounts/oauth');if(!flow){w?.close();return;}Object.assign(flow,{url:r.url,state:r.state});}
        catch(e){w?.close();throw e;}
        finally{if(flow){flow.linkLoading=false;addDialog(1);}}}
      if(w){try{w.opener=null;}catch(e){}w.location.href=flow.url;}else toast('浏览器拦截了新窗口，请复制授权链接自己打开',true);
      break;}
    case 'oauthcheck':{
      if(!flow?.state)break;
      const s_=await api('GET','api/accounts/oauth/'+encodeURIComponent(flow.state));
      if(s_.status==='ok'){flow.added=[s_.account];flow.reauth=s_.message==='reauthorized';addDialog(3);}
      else if(s_.status==='wait'){flow.err='还没收到授权结果：登录后把浏览器地址栏里的链接粘贴到下面';addDialog(1);$('#f-cb')?.focus();}
      else{flow.err=s_.status==='duplicate'?'这个账号已经在小锅饭里了':'授权失败，请重新开始';if(s_.status!=='duplicate')flow.url=null;addDialog(1);}
      break;}
    case 'submitcb':{
      let v=$('#f-cb')?.value.trim()||'';
      if(v&&!/[?&]code=/.test(v)&&/^[\w\/.-]{10,}$/.test(v))v=`http://localhost:51121/oauth-callback?state=${encodeURIComponent(flow.state)}&code=${encodeURIComponent(v)}`; // bare authorization code
      if(!/[?&]code=/.test(v)){toast('回调链接无效',true);$('#f-cb')?.focus();break;}
      flow.err=null;
      await api('POST','api/accounts/oauth/callback',{state:flow.state,url:v});
      flow.waiting=true;addDialog(1);pollOAuth();break;}
    case 'addstep3':addDialog(3);break;
    case 'adddone':{
      const name=$('#f-accname')?.value.trim();const shared=$('#f-accshare').checked;const ids=flow.added||[];
      const rsv=pickedReserve();
      for(const id of ids){const b={};if(name)b.name=name;if(shared){b.shared=true;if(rsv!=null)b.reserve=rsv;}if(Object.keys(b).length)await api('PATCH','api/accounts/'+encodeURIComponent(id),b);}
      closeDialog();toast(shared?'账号已添加，并放进了大锅饭':'账号已添加，仅自用');go('accounts');break;}
    case 'detail':accountDetail(arg);break;
    case 'reason':reasonDialog(arg);break;
    case 'rsraw':{const p=$('#rs-p'),r=$('#rs-r');if(!p||!r)break;const show=r.hidden;r.hidden=!show;p.hidden=show;el.textContent=show?'显示解析结果':'显示原始报文';break;}
    case 'asort':ui.acc.sort=AF.nextSort(ui.acc.sort,arg);lsSet('agy-accsort',ui.acc.sort);ui.acc.page=1;refreshAcc();break;
    case 'apg':ui.acc.page=+arg||1;refreshAcc();$('#acc-body')?.scrollIntoView({block:'start',behavior:'smooth'});break;
    case 'jump':ui.acc.focus=arg;go('accounts');break;
    case 'refreshq':{
      el.disabled=true;const inDlg=dialogOpen();
      try{const v=await api('POST','api/accounts/'+encodeURIComponent(arg)+'/quota');patchAcc(keepAcc(v));if(inDlg)accountDetail(arg);toast(v.quotaErr?'额度读取失败':'额度已刷新',!!v.quotaErr);}
      finally{el.disabled=false;}break;}
    case 'toggle':{const inDlg=dialogOpen();const x=D.accounts.find(y=>y.id===arg);const v=await api('PATCH','api/accounts/'+encodeURIComponent(arg),{active:!x.active});
      patchAcc(keepAcc(v));if(inDlg)accountDetail(arg);toast(v.active?'账号已启用':'账号已停用');break;}
    case 'models':case 'amodels':{
      const x=a==='models'?D.accounts?.find(y=>y.id===arg):D.admin?.accounts?.find(y=>y.id===arg);const label=x?.email||arg;
      modelsDialog(arg,label,null);
      let list;try{list=await api('GET','api/accounts/'+encodeURIComponent(arg)+'/models');}catch(err){list=false;}
      if(mdlFor===arg)modelsDialog(arg,label,list);break;}
    case 'mtest':{
      const M=mdl;if(!M||!dialogOpen())break;
      if(Object.values(M.res).some(r=>r.run)){toast('上一个测试还没结束',true);break;}
      M.res[arg]={run:true};modelsDialog(M.id,M.label,M.list);
      let r;try{r=await api('POST','api/accounts/'+encodeURIComponent(M.id)+'/models/test',{model:arg});}catch(e){r={ok:false,error:errText(e)};}
      M.res[arg]=r;if(mdl===M&&dialogOpen())modelsDialog(M.id,M.label,M.list);break;}
    case 'tokpop':{const id=+arg;if(tokPin===id)hideTokPop(true);else showTokPop(el,true);break;}
    case 'anns':annDialog();break;
    case 'ansave':{
      const b={title:$('#an-title').value.trim(),body:$('#an-body').value,level:$('input[name=an-level]:checked')?.value||'info',pinned:$('#an-pin').checked};
      if(!b.title){toast('先写标题',true);$('#an-title').focus();break;}
      if(annEdit?.id){await api('PATCH','api/admin/announcements/'+annEdit.id,b);toast('公告已更新');}
      else{b.discord=!!$('#an-dc')?.checked;const r=await api('POST','api/admin/announcements',b);toast(r.discord===false?'已发布，但发到 Discord 失败':r.discord?'已发布，并发到了 Discord':'公告已发布',r.discord===false);}
      annEdit=null;await loadAnn();ANN.unread=0;try{await api('POST','api/announcements/seen');}catch(e){}render();break;}
    case 'anedit':annEdit=ANN.list.find(x=>x.id===+arg)||null;render();$('#an-title')?.focus();break;
    case 'ancancel':annEdit=null;render();break;
    case 'andel':{const a=ANN.list.find(x=>x.id===+arg);if(!a)break;
      openDialog('删除公告',esc(a.title),'<p class="dim mt">所有人都看不到了，不可恢复。</p>',`<button class="btn" data-act="close">取消</button><button class="btn primary" style="background:var(--bad)" data-act="doandel:${a.id}">删除</button>`);break;}
    case 'doandel':await api('DELETE','api/admin/announcements/'+arg);if(annEdit?.id===+arg)annEdit=null;closeDialog();await loadAnn();render();toast('公告已删除');break;
    case 'trrefresh':await refreshTraffic();break;
    case 'trauto':ui.tr.auto=!ui.tr.auto;el.setAttribute('aria-checked',ui.tr.auto);break;
    case 'trpg':ui.tr.page=Math.max(1,+arg);await refreshTraffic();break;
    case 'trchip':{const t=ui.tr;
      if(arg==='all'){t.family='';t.pool='';t.err=false;}
      else if(arg==='err')t.err=!t.err;
      else if(arg.startsWith('f:')){const f=arg.slice(2);t.family=t.family===f?'':f;}
      else{const p=arg.slice(2);t.pool=t.pool===p?'':p;}
      t.page=1;await refreshTraffic();break;}
    case 'delacc':{const x=D.accounts.find(y=>y.id===arg);
      openDialog('删除凭证',esc(accName(x)),'<p class="dim mt">不可恢复。</p>',`<button class="btn" data-act="close">取消</button><button class="btn primary" style="background:var(--bad)" data-act="dodelacc:${esc(arg)}">删除</button>`);break;}
    case 'dodelacc':await api('DELETE','api/accounts/'+encodeURIComponent(arg));closeDialog();toast('凭证已删除');reload();break;
    case 'share':shareDialog(arg);break;
    case 'confirmshare':{const x=D.accounts.find(y=>y.id===arg);const b={shared:!x.shared};if(!x.shared)b.reserve=pickedReserve();const v=await api('PATCH','api/accounts/'+encodeURIComponent(arg),b);
      const prev=keepAcc(v);closeDialog();patchAcc(prev);toast(v.shared?`“${accName(v)}”已放进大锅饭`:`已撤回“${accName(v)}”的共享`);break;}
    case 'newkey':newKeyDialog(arg);break;
    case 'createkey':{
      const pool=$('input[name=newKeyPool]:checked')?.value||'private';
      const k=await api('POST','api/keys',{name:$('#f-keyname').value.trim()||'新的客户端',pool});
      page='keys';await reload();keyCreated(k);break;}
    case 'rename':{const k=D.keys.find(x=>x.id===+arg);
      openDialog('重命名',esc(k.name),`<label class="field"><span>名称</span><input class="input" id="f-rename" maxlength="40" value="${esc(k.name)}" autofocus></label>`,
        `<button class="btn" data-act="close">取消</button><button class="btn primary" data-act="dorename:${k.id}">保存</button>`);break;}
    case 'dorename':{const n=$('#f-rename').value.trim();if(!n)break;await api('PATCH','api/keys/'+arg,{name:n});closeDialog();reload();break;}
    case 'connect':connectDialog(arg);break;
    case 'revoke':{const k=D.keys.find(x=>x.id===+arg);
      openDialog('撤销密钥',esc(k.name),'<p class="dim mt">不可恢复。</p>',
        `<button class="btn" data-act="close">取消</button><button class="btn primary" style="background:var(--bad)" data-act="dorevoke:${arg}">撤销</button>`);break;}
    case 'dorevoke':await api('DELETE','api/keys/'+arg);closeDialog();toast('密钥已撤销');reload();break;
    case 'copyurl':{const x=[...(D.accounts||[]),...(D.admin?.accounts||[])].find(y=>y.id===arg);if(x?.action?.url)copy(x.action.url);break;}
    case 'copykey':{const k=D.keys?.find(x=>x.id===+arg);if(k?.key)copy(k.key);break;}
    case 'copy':copy(arg==='base'?baseURL():arg==='auth'?flow?.url||'':arg==='redirect'?D.admin?.site?.redirectURI||'':arg==='interactions'?D.admin?.site?.interactionsURL||'':createdKey||'');break;
    case 'ulimit':{const u=D.admin.users.find(x=>x.id===+arg),ov=u.dailyOverride,R=D.admin.rules||{};
      const mode=ov==null?'def':ov<0?'inf':'num';
      openDialog('每日大锅饭次数',esc(u.name),`<div class="seg full mt" role="radiogroup" aria-label="方式"><label><input type="radio" name="ulm" value="def" ${mode==='def'?'checked':''}><span>按规则</span></label><label><input type="radio" name="ulm" value="inf" ${mode==='inf'?'checked':''}><span>不限</span></label><label><input type="radio" name="ulm" value="num" ${mode==='num'?'checked':''}><span>自定义</span></label></div>
        <label class="field"><span>自定义每天次数</span><input class="input" type="number" min="0" max="1000000" id="f-ulimit" value="${mode==='num'?ov:''}" placeholder="例如 1000"></label>
        <small class="faint">按规则：${u.role==='admin'?'管理员不限':`${R.dailyBase??200} + ${R.dailyPer??500} × 有效共享号`}。今天已用 ${u.dailyUsed} 次。</small>`,
        `<button class="btn" data-act="close">取消</button><button class="btn primary" data-act="doulimit:${u.id}">保存</button>`);break;}
    case 'doulimit':{const m=$('input[name=ulm]:checked')?.value;let v=null;
      if(m==='inf')v=-1;else if(m==='num'){v=Math.round(+$('#f-ulimit').value);if(!(v>=0)){toast('填一个次数',true);break;}}
      await api('PATCH','api/admin/users/'+arg,{dailyLimit:v});closeDialog();toast('每日次数已更新');reload();break;}
    case 'sharedmodels':{el.disabled=true;try{const r=await api('GET','api/admin/shared-models');mp={kind:'shared',all:r.all,allow:r.allow};modelPicker();}finally{el.disabled=false;}break;}
    case 'upmodels':{el.disabled=true;try{const u=D.admin.upstreams.find(x=>x.id===+arg),t=await api('POST','api/admin/upstreams/'+arg+'/test');
      if(!t.ok){toast('拉取模型失败：'+(t.error||''),true);break;}
      mp={kind:'up',id:u.id,name:u.name,all:t.models.sort().map(id=>({id})),allow:u.allow};modelPicker();}finally{el.disabled=false;}break;}
    case 'mpall':$$('#mp-list input').forEach(x=>{if(!x.closest('.mp-row').hidden)x.checked=arg==='1';});break;
    case 'mpsave':{const all_=$('input[name=mpmode]:checked')?.value==='all',list=all_?null:$$('#mp-list input:checked').map(x=>x.value);
      if(list&&!list.length){toast('至少勾一个模型，或选「全部开放」',true);break;}
      if(mp.kind==='shared')await api('PUT','api/admin/shared-models',{allow:list});else await api('PATCH','api/admin/upstreams/'+mp.id,{models:list});
      closeDialog();mp=null;toast(all_?'已设为全部开放':`已开放 ${list.length} 个模型`);reload();break;}
    case 'upnew':upEdit={};render();$('#up-name')?.focus();break;
    case 'upedit':upEdit={...D.admin.upstreams.find(x=>x.id===+arg)};render();$('#up-name')?.focus();break;
    case 'upcancel':upEdit=null;render();break;
    case 'upsave':{const b={name:$('#up-name').value.trim(),url:$('#up-url').value.trim()},k=$('#up-key').value.trim(),mk=$('#up-mgmt')?.value.trim();if(k)b.key=k;if(mk)b.mgmtKey=mk;
      if(!b.url){toast('填上游地址',true);break;}if(!upEdit.id&&!k){toast('填 API Key',true);break;}
      const r=upEdit.id?await api('PATCH','api/admin/upstreams/'+upEdit.id,b):await api('POST','api/admin/upstreams',b);
      upEdit=null;const t=await api('POST','api/admin/upstreams/'+r.id+'/test').catch(()=>null);
      toast(t?.ok?`已保存，检测到 ${t.count} 个模型${t.accounts!=null?` · ${t.accounts} 个账号`:''}`:'已保存，但连不上：'+(t?.error||'未知错误'),!t?.ok);reload();break;}
    case 'uptest':{el.disabled=true;try{const t=await api('POST','api/admin/upstreams/'+arg+'/test');toast(t.ok?`连接正常，${t.count} 个模型${t.accounts!=null?` · ${t.accounts} 个账号`:''}`:'连不上：'+t.error,!t.ok);reload();}finally{el.disabled=false;}break;}
    case 'uptoggle':{const u=D.admin.upstreams.find(x=>x.id===+arg);await api('PATCH','api/admin/upstreams/'+arg,{enabled:!u.enabled});toast(u.enabled?'已停用':'已启用');reload();break;}
    case 'updel':{const u=D.admin.upstreams.find(x=>x.id===+arg);
      openDialog('删除上游',esc(u.name),'<p class="dim mt">大锅饭不会再转发到这里。</p>',`<button class="btn" data-act="close">取消</button><button class="btn primary" style="background:var(--bad)" data-act="doupdel:${u.id}">删除</button>`);break;}
    case 'doupdel':await api('DELETE','api/admin/upstreams/'+arg);closeDialog();toast('已删除');reload();break;
    case 'user':{const u=D.admin.users.find(x=>x.id===+arg);
      if(u.active){openDialog('停用用户',esc(u.name),'',`<button class="btn" data-act="close">取消</button><button class="btn primary" style="background:var(--bad)" data-act="douser:${arg}">停用</button>`);break;}
      await api('PATCH','api/admin/users/'+arg,{active:true});toast(`已启用“${u.name}”`);reload();break;}
    case 'newuser':
      openDialog('添加账号','',
        `<label class="field"><span>用户名</span><input class="input mono" id="f-nu" maxlength="32" autocomplete="off" autocapitalize="none" spellcheck="false" autofocus></label>
        <label class="field"><span>显示名称</span><input class="input" id="f-nn" maxlength="40" autocomplete="off"></label>
        <label class="field"><span>密码</span><input class="input mono" id="f-np" minlength="8" maxlength="128" autocomplete="new-password"></label>
        <label class="check"><input type="checkbox" id="f-na"><span>管理员</span></label>`,
        `<button class="btn" data-act="close">取消</button><button class="btn primary" data-act="createuser">创建</button>`);break;
    case 'createuser':
      await api('POST','api/admin/users',{username:$('#f-nu').value.trim(),name:$('#f-nn').value.trim(),password:$('#f-np').value,role:$('#f-na').checked?'admin':'user'});
      closeDialog();toast('账号已创建');reload();break;
    case 'resetpw':{const u=D.admin.users.find(x=>x.id===+arg);
      openDialog('重置密码',esc(u.name)+' · @'+esc(u.username),
        `<label class="field"><span>新密码</span><input class="input mono" id="f-rp" minlength="8" maxlength="128" autocomplete="new-password" autofocus></label>`,
        `<button class="btn" data-act="close">取消</button><button class="btn primary" data-act="doresetpw:${arg}">保存</button>`);break;}
    case 'doresetpw':
      await api('PATCH','api/admin/users/'+arg,{password:$('#f-rp').value});closeDialog();toast('密码已重置');break;
    case 'douser':{const u=D.admin.users.find(x=>x.id===+arg);await api('PATCH','api/admin/users/'+arg,{active:false});closeDialog();toast(`已停用“${u.name}”`);reload();break;}
    case 'fleet':{const x=D.admin.accounts.find(y=>y.id===arg);await api('PATCH','api/admin/accounts/'+encodeURIComponent(arg),{active:!x.active});toast(!x.active?'账号已启用':'账号已停用');reload();break;}
    case 'breaker':await api('POST','api/admin/breaker/reset');toast('已解除熔断');reload();break;
    case 'resetsess':await api('POST','api/me/sessions/reset');toast('会话绑定已清除，下一次请求会重新选号');break;
    case 'addproxy':{const v=$('#f-proxy').value.trim();if(!v)break;await api('POST','api/admin/proxies',{url:v});toast('出口已添加');reload();break;}
    case 'delproxy':await api('DELETE','api/admin/proxies/'+arg);reload();break;
    case 'replace':ui['replace_'+arg]=true;render();$(`[data-site=${arg}]`)?.focus();break;
    case 'clearbot':await api('PUT','api/admin/site',{clearBotToken:true});toast('已清除');reload();break;
    case 'shopadd':$('#shop-edit').insertAdjacentHTML('beforeend',shopRow());$('#shop-edit .shop-row:last-child input')?.focus();break;
    case 'shopdel':el.closest('.shop-row')?.remove();break;
    case 'sfadd':$('#sf-edit').insertAdjacentHTML('beforeend',sfRow());$('#sf-edit .sf-row:last-child input')?.focus();break;
    case 'sftest':{const r=el.closest('.sf-row'),name=$('[data-sf=name]',r).value.trim();if(!name){toast('先填模型名称',true);break;}
      el.disabled=true;try{const t=await api('POST','api/admin/sf/test',{name,type:$('[data-sf=type]',r).value});toast(t.ok?`可用 · ${t.ms}ms · ${t.detail}`:`不可用 · ${t.detail}`,!t.ok);}finally{el.disabled=false;}break;}
    case 'sfdel':el.closest('.sf-row')?.remove();break;
    case 'sfon':{const on=!D.admin.sf.enabled;D.admin.sf=await api('PUT','api/admin/sf',{enabled:on});render();toast(on?'Embedding / Rerank 已开启':'Embedding / Rerank 已关闭');break;}
    case 'sfsave':{
      const models=$$('#sf-edit .sf-row').map(r=>({name:$('[data-sf=name]',r).value.trim(),type:$('[data-sf=type]',r).value,free:$('[data-sf=free]',r).checked,enabled:$('[data-sf=enabled]',r).checked})).filter(m=>m.name);
      const b={base:$('#sf-base').value.trim(),rpm:Math.round(+$('#sf-rpm').value||0),models},k=$('#sf-key').value.trim();if(k)b.key=k;
      D.admin.sf=await api('PUT','api/admin/sf',b);render();toast('已保存');break;}
    case 'sw':{const on=!(D.admin.sw?.[arg]!==false);D.admin.sw=await api('PUT','api/admin/switches',{[arg]:on});render();toast(arg==='mentions'?(on?'机器人会 @ 人':'机器人不再 @ 任何人'):arg==='proactive'?(on?'机器人会主动发提醒、日报和补货通知':'机器人只在被 @ 时说话'):arg==='stockOnly'?(on?'只有补货通知会 @ 人':'恢复正常 @ 人'):(on?'买号渠道已显示':'买号渠道已隐藏'));break;}
    case 'shopsave':{
      const shops=$$('#shop-edit .shop-row').map(r=>Object.fromEntries($$('[data-shop]',r).map(i=>[i.dataset.shop,i.value.trim()]))).filter(s=>s.url||s.name);
      const r=await api('PUT','api/admin/shops',{shops});D.admin.shops=r.shops;render();toast('已保存');break;}
    case 'sort':{const [k,c]=arg.split(':');const o=ui['s_'+k];ui['s_'+k]={c,d:o?.c===c?-o.d:(c==='name'?1:-1)};ui['p_'+k]=1;refreshList(k);break;}
    case 'trlog':{
      openDialog('请求报文','',`<div class="dialog-body"><div class="hstack"><span class="spin"></span><span class="dim">加载中…</span></div></div>`,`<button class="btn" data-act="close">关闭</button>`,true);
      const r=await api('GET','api/admin/traffic/'+arg+'/log');
      if(!$('#layer .dialog'))break;
      $('#layer .dialog-body').innerHTML=r.found?`<pre class="code log-pre">${esc(r.text)}</pre>${r.truncated?'<p class="mt-s"><small>已截断</small></p>':''}`:`<p class="dim">没有这条请求的报文</p>`;
      if(r.found)$('#layer .dialog-foot').insertAdjacentHTML('afterbegin',`<button class="btn" data-act="copylog">${ic('copy')}复制</button>`);
      ui.logText=r.found?r.text:'';break;}
    case 'copylog':copy(ui.logText||'');break;
    case 'pg':{const [k,n]=arg.split(':');ui['p_'+k]=+n;refreshList(k);break;}
    case 'botchid':{const v=$('#bot-ch-id')?.value.trim();if(!v)break;D.admin.site=await api('PUT','api/admin/site',{botChannelId:v});D.admin.bot=await api('GET','api/admin/bot');render();toast('已保存');break;}
    case 'botrefresh':D.admin.bot=await api('GET','api/admin/bot');render();break;
    case 'botconnect':D.admin.bot=await api('POST','api/admin/bot/connect');render();toast('已连接');break;
    case 'kburl':{const u=$('#kb-url').value.trim();if(!u)return;toast('导入中…');const r=await api('POST','api/admin/kb',{url:u});D.admin.kb=r.list;render();toast('已导入');break;}
    case 'botchatsave':D.admin.botchat={...D.admin.botchat,...await api('PUT','api/admin/botchat',(()=>{const v=$('#bc-model').value,i=v.indexOf('|');return {source:v.slice(0,i),model:v.slice(i+1),prompt:$('#bc-prompt').value};})())};D.admin.botchat.prompt=$('#bc-prompt').value.trim()||D.admin.botchat.defaultPrompt;toast('问答设置已保存');render();break;
    case 'botpromptreset':$('#bc-prompt').value=D.admin.botchat.defaultPrompt;toast('已填入默认提示词，点保存生效');break;
    case 'kbdel':if(!confirm('删除这篇文档？'))return;D.admin.kb=await api('DELETE','api/admin/kb/'+arg);render();toast('已删除');break;
    case 'stockrefresh':D.admin.stock=await api('GET','api/admin/stock?refresh=1');render();toast('已刷新');break;
    case 'stockck':{const ids=$$('.stk-list input:checked').map(x=>Number(x.value));D.admin.stock.watched=(await api('PUT','api/admin/stock',{watched:ids})).watched;toast(ids.length?`监控 ${ids.length} 件`:'没有监控的商品');break;}
    case 'bottest':await api('POST','api/admin/bot/test');toast('已发送，去频道看看');break;
    case 'savesite':{
      const b={};$$('[data-site]').forEach(x=>{if(x.type!=='password'||x.value.trim())b[x.dataset.site]=x.value.trim();});
      if(b.redirectOverride===undefined)b.redirectOverride='';
      D.admin.site=await api('PUT','api/admin/site',b);ui.replace_clientSecret=ui.replace_botToken=false;D.admin.bot=await api('GET','api/admin/bot').catch(()=>null);render();toast('已保存');break;}
  }
}));

document.addEventListener('change',act(async e=>{
  const t=e.target;
  if(t.id==='f-files'){await uploadFiles([...t.files]);return;}
  if(t.id==='f-kb'){const fs=[...t.files];t.value='';for(const f of fs){if(f.size>600000){toast(`${f.name} 太大，跳过`);continue;}const r=await api('POST','api/admin/kb',{title:f.name.replace(/\.(md|txt)$/i,''),body:await f.text()});D.admin.kb=r.list;}render();toast(`已加入 ${fs.length} 篇`);return;}
  if(t.id==='f-botprompt'){const f=t.files[0];if(!f)return;if(f.size>20000*3){toast('文件太大（最多约 2 万字）');return;}$('#bc-prompt').value=(await f.text()).trim();t.value='';toast('已读入，点保存生效');return;}
  if(t.name==='defaultPool'){await api('PATCH','api/me',{defaultPool:t.value});me.defaultPool=t.value;toast(`新建密钥默认：${POOL[t.value]}`);}
  else if(t.dataset.key){const k=D.keys.find(x=>x.id===+t.dataset.key);await api('PATCH','api/keys/'+k.id,{pool:t.value});k.pool=t.value;render();toast(`“${k.name}”改为${POOL[t.value]}`);}
  else if(t.name==='logView'){ui.logView=t.value;await reload();}
  else if(t.name==='stView'){ui.st.view=t.value;render();}
  else if(t.name==='stRange'||t.name==='stScope'){ui.st[t.name==='stRange'?'range':'scope']=t.value;await reload();}
  else if(t.name==='inlim'||t.dataset.inlim!==undefined){
    const n=t.name==='inlim'?+t.value:Math.round((+t.value||0)*1e4);
    if(n&&(n<1000||n>1e7)){toast('输入上限要在 0.1 万到 1000 万之间');render();return;}
    await api('PATCH','api/me',{inputLimit:n||null});me.inputLimit=n||null;render();toast(n?`输入上限：${+(n/1e4).toFixed(1)} 万 Token`:'输入上限已关闭');}
  else if(t.name==='rotation'){await api('PATCH','api/me',{rotation:t.value});me.rotation=t.value;render();toast('账号轮换：'+(ROT.find(x=>x[0]===t.value)||[,''])[1]);}
  else if(t.dataset.retry){const v=Math.max(0,Math.min(300,Math.round(+t.value||0)));t.value=v;D.admin.retry=await api('PUT','api/admin/retry',{maxWait:v});toast('最大等待时长已更新');}
  else if(t.name==='accrsv'){const v=await api('PATCH','api/accounts/'+encodeURIComponent(t.dataset.acc),{reserve:t.value==='def'?null:+t.value});patchAcc(keepAcc(v));toast('自用保留已更新');}
  else if(t.id==='f-accshare'){const w=$('#f-rsvwrap');if(w)w.hidden=!t.checked;}
  else if(t.name==='mpmode'){const l=$('#mp-list');if(l)l.classList.toggle('dis',t.value==='all');}
  else if(t.name==='admTab'){admTab(t.value);}
  else if(t.name==='accview'){lsSet('agy-accview',t.value);ui.acc.page=1;refreshAcc();}
  else if(t.dataset.accsize!==undefined){ui.acc.size=+t.value||10;lsSet('agy-accsize',String(ui.acc.size));ui.acc.page=1;refreshAcc();}
  else if(t.dataset.accjump!==undefined){ui.acc.page=+t.value||1;refreshAcc();$('#acc-body')?.scrollIntoView({block:'start',behavior:'smooth'});}
  else if(t.name==='addTab'){ui.addTab=t.value;addDialog(1);$(`#layer input[name=addTab][value=${t.value}]`)?.focus();}
  else if(t.name==='reserve'){D.admin.rules=await api('PUT','api/admin/rules',{reserve:+t.value});toast('自用保留已更新');}
  else if(t.dataset.rule){const v=Math.max(+t.min||0,Math.min(+t.max||1e9,Math.round(+t.value||0)));t.value=v;D.admin.rules=await api('PUT','api/admin/rules',{[t.dataset.rule]:v});toast('规则已更新');}
  else if(t.dataset.proxy!==undefined){await api('PATCH','api/admin/accounts/'+encodeURIComponent(t.dataset.proxy),{proxyId:t.value?+t.value:null});toast(t.value?'专属出口已绑定':'专属出口已解绑');reload();}
  else if(t.dataset.note!==undefined){const v=await api('PATCH','api/accounts/'+encodeURIComponent(t.dataset.note),{name:t.value.trim()});patchAcc(keepAcc(v));toast('备注已保存');}
  else if(t.matches('[data-trpage]')){const n=Math.round(+t.value)||1;ui.tr.page=Math.max(1,Math.min(+t.max||1,n));await refreshTraffic();}
  else if(t.dataset.trf){ui.tr[t.dataset.trf]=t.value;ui.tr.page=1;await refreshTraffic();}
  else if(t.dataset.trsize!==undefined){ui.tr.size=+t.value;ui.tr.page=1;await refreshTraffic();}
}));

let trTimer=null;
document.addEventListener('input',e=>{if(e.target.dataset?.trq===undefined)return;clearTimeout(trTimer);const v=e.target.value.trim();
  trTimer=setTimeout(act(async()=>{ui.tr.q=v;ui.tr.page=1;await refreshTraffic();}),300);});
setInterval(()=>{if(ui.tr.auto&&me&&page==='logs'&&ui.logView==='mine'&&loadState==='idle'&&!dialogOpen()&&document.visibilityState==='visible')refreshTraffic().catch(()=>{});},5000);
document.addEventListener('input',e=>{if(e.target.id!=='mp-q')return;const q=e.target.value.trim().toLowerCase();$$('#mp-list .mp-row').forEach(r=>r.hidden=!!q&&!r.dataset.mid.includes(q));});
document.addEventListener('input',e=>{const k=e.target.dataset?.search;if(!k)return;ui['q_'+k]=e.target.value;ui['p_'+k]=1;refreshList(k);});
document.addEventListener('toggle',e=>{const id=e.target.dataset?.fold;if(!id)return;FOLD[id]=e.target.open;try{localStorage.setItem('agy-fold',JSON.stringify(FOLD));}catch(err){}},true);
document.addEventListener('submit',act(async e=>{
  if(e.target.id!=='pwform')return;e.preventDefault();
  await api('POST','api/login',{username:$('#f-user').value.trim(),password:$('#f-pass').value});
  await boot();
}));
document.addEventListener('dragover',e=>{const d=e.target.closest?.('#drop');if(d){e.preventDefault();d.classList.add('on');}});
document.addEventListener('dragleave',e=>{e.target.closest?.('#drop')?.classList.remove('on');});
document.addEventListener('drop',act(async e=>{const d=e.target.closest?.('#drop');if(!d)return;e.preventDefault();await uploadFiles([...e.dataTransfer.files]);}));

document.addEventListener('keydown',e=>{
  const dlg=$('#layer .dialog');
  if(e.key==='Escape'){if(closeTip())return;if(dlg)closeDialog();return;}
  if(e.key==='Enter'&&e.target.id==='f-devname'){$('[data-act=devlogin]')?.click();return;}
  if((e.key==='Enter'||e.key===' ')&&e.target.matches?.('.tr.click')){e.preventDefault();e.target.click();return;}
  if(e.key==='Tab'&&dlg){
    const f=$$('button:not(:disabled),input:not(:disabled),select,[tabindex]:not([tabindex="-1"])',dlg).filter(x=>x.offsetParent!==null||x.type==='radio');
    if(!f.length)return;const first=f[0],last=f[f.length-1];
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
  }
});
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change',()=>{if(themePref()==='auto')applyTheme();});

async function boot(){
  try{cfg=await api('GET','api/config');}catch(e){cfg={};}
  try{me=await api('GET','api/me');}catch(e){me=null;}
  const q=new URLSearchParams(location.search);
  if(q.get('err')){toast(ERR[q.get('err')]||'登录失败',true);history.replaceState(null,'',location.pathname);}
  if(me&&cfg.browserEnabled)brSet(await api('GET','api/browser').catch(()=>null));
  if(me){await loadAnn();await load('home');if(ANN.unread)annDialog();}else render();
}
setInterval(async()=>{if(!me||dialogOpen())return;const u=ANN.unread;await loadAnn();if(ANN.unread!==u){const b=$('.bell');if(b)b.classList.toggle('on',!!ANN.unread);}},5*60e3);
applyTheme();
boot();
})();
