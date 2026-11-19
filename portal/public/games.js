/* 游乐场：赛狗 / 水果机 / 彩票。数据全在服务器（/api/fun），实时推送走 SSE（/api/fun/stream），这里只留界面偏好。 */
(()=>{
const {ic,esc,$,toast,render,api}=window.AGY;
const lsGet=(k,d)=>{try{return localStorage.getItem(k)||d}catch(e){return d}};
const lsSet=(k,v)=>{try{localStorage.setItem(k,v)}catch(e){}};
const oops=e=>toast(e?.detail||e?.message||'操作失败',true);
const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;

let D=null, loading=null, off=0, loadedAt=0;   // 服务器数据、本地与服务器的时间差
let tab=lsGet('agy-fun-tab3','race');
let busy=false;                                // 水果机转动 / 赛狗播放中：只更新数据不重画
const now=()=>Date.now()+off;
function load(){
  if(loading)return loading;
  loading=(async()=>{try{const d=await api('GET','api/fun');off=d.now-Date.now();D=d;loadedAt=Date.now();checkDraw();}catch(e){if(e?.status!==401)console.warn(e);}finally{loading=null;}})();
  return loading;
}
const onPage=()=>!!$('.fun-root');
const paint=()=>{if(!busy&&onPage())render();};
async function act(path,body){try{const r=await api('POST','api/fun/'+path,body);await load();return r||{};}catch(e){oops(e);await load();return null;}}
const bone=(n,cls='')=>`<span class="fb ${cls}">${n}<i>🦴</i></span>`;

/* —— 票：热敏小票 / 票根。at = 开始吐票的时刻，sAt = 盖章时刻；用负的 animation-delay 让重画时动画接着走 —— */
const p2=n=>String(n).padStart(2,'0');
const when=ts=>{const d=new Date(ts);return `${p2(d.getMonth()+1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;};
const PRINT=1100;
const rows=a=>`<div class="gtk-rows">${a.map(([k,v,c=''])=>`<span>${k}</span><b class="${c}">${v}</b>`).join('')}</div>`;
function ticket({cls='',head='',no='',sum='',body='',foot='',stamp=null,at=0,sAt=0,sty='',fun=''}){
  const t=Date.now(),live=!reduced(),pe=at?t-at:1e9,se=sAt?t-sAt:(at?pe-PRINT:1e9);
  const pin=live&&pe<PRINT+400,sin=live&&stamp&&se<900;
  const st=[sty,pin?`--t0:${-pe}ms`:'',sin?`--ts:${-se}ms`:''].filter(Boolean).join(';');
  return `<div class="gtk ${cls} ${pin?'in':''} ${sin?'sin':''}" ${st?`style="${st}"`:''} ${fun?`data-fun="${fun}" role="button" tabindex="0"`:''}>
    <div class="gtk-p">
      <div class="gtk-h">${head}<span class="gtk-no">${no}</span></div>
      ${sum?`<div class="gtk-sum">${sum}</div>`:''}
      <div class="gtk-b">${body}</div>
      <div class="gtk-f"><i class="gtk-bar"></i><span>${foot}</span></div>
    </div>
    ${stamp?`<span class="gtk-st ${stamp.c}">${stamp.t}</span>`:''}
  </div>`;
}
function confetti(delay=0){
  if(reduced())return;
  setTimeout(()=>{
    const cf=document.createElement('div');cf.className='gcf';
    const C=['#ff3d6e','#ffcc33','#2f7cf6','#18c27a','#a46bff','#ff8a3d'];
    for(let i=0;i<110;i++){const s=document.createElement('i');
      s.style.cssText=`left:${Math.random()*100}%;background:${C[i%C.length]};--d:${(1.6+Math.random()*1.6).toFixed(2)}s;--w:${(Math.random()*.5).toFixed(2)}s;--x:${Math.round(Math.random()*160-80)}px;--r:${Math.round(Math.random()*720-360)}deg;${i%3?'':'border-radius:50%;'}`;
      cf.append(s);}
    document.body.append(cf);setTimeout(()=>cf.remove(),4200);
  },delay);
}

/* —— 钱包 + 狗哥 —— */
const owedNow=w=>w.owed?w.owed*Math.pow(1+D.cfg.LOAN_RATE,Math.max(0,now()-w.owedAt)/3600e3):0;
function dogBro(w,o){const C=D.cfg;
  if(!o)return ['🐕‍🦺','要借点吗？利息好商量。'];
  if(w.overdue)return ['😡','逾期了！每天的骨头我先拿走抵债。'];
  if(o>=C.LOAN_HEAVY)return ['🐺','利滚利，懂吧？'];
  if(o>=40)return ['🐕‍🦺','记得早点还哦。'];
  return ['🐕‍🦺','小钱，玩得开心。'];}
function wallet(){
  const w=D.wallet,C=D.cfg,o=owedNow(w),[face,talk]=dogBro(w,o),I=w.inf;
  const g4=C.G4A_ON&&w.argon!=null?`<div class="fw-g4">
      <div class="fw-g4-n"><span class="fw-ar">Ar</span><b>${I?'∞':w.argon}</b><small>次</small></div>
      <div class="fw-g4-a">${C.G4A_STEPS.map(n=>`<button class="btn sm" data-fun="g4a:${n}" ${w.g4aToday+n>C.G4A_CAP?'disabled':''}>换 ${n} 次 · ${n*C.G4A_RATE}🦴</button>`).join('')}</div></div>`:'';
  return `<section class="card glass fw">
    <div class="fw-top">
      <div class="fw-bal"><span class="fw-n">${I?'∞':w.bones}</span><span class="fw-i">🦴</span>${w.red?`<span class="fw-red">${w.red}<i>🦴</i></span>`:''}</div>
      ${g4}<div class="fw-g4"><div class="fw-g4-n"><span class="fw-ar">VIP</span><b>${w.vipQuota??0}</b><small>次</small></div><div class="fw-g4-a"><button class="btn sm" data-fun="vip:1" ${o>0||(!I&&w.bones<(C.VIP_RATE||20))?'disabled':''}>换 1 次 · ${C.VIP_RATE||20}🦴</button><button class="btn sm" data-fun="vip:5" ${o>0||(!I&&w.bones<(C.VIP_RATE||20)*5)?'disabled':''}>换 5 次 · ${(C.VIP_RATE||20)*5}🦴</button></div></div>
    </div>
    <div class="fw-bro ${w.overdue?'mad':''}"><span class="fw-face">${face}</span><div class="fw-talk"><b>狗哥</b><span>${talk}</span></div>
      ${o?`<div class="fw-owe"><b id="fun-owed">${o.toFixed(2)}</b><i>🦴</i><small>+${Math.round(C.LOAN_RATE*100)}%/时</small></div>`:''}
      <div class="fw-acts">${C.LOAN_STEP.map(n=>`<button class="btn sm" data-fun="borrow:${n}" ${C.LOAN_MAX&&o+n>C.LOAN_MAX?'disabled':''}>借 ${n}</button>`).join('')}${o?`<button class="btn sm primary" data-fun="repay">还款</button>`:''}</div></div>
    ${D.admin?`<button type="button" class="fw-inf ${I?'on':''}" data-fun="inf" title="管理员无限">∞</button>`:''}
  </section>`;
}
function seg(){
  const T=[['race','🐕 赛狗'],['slots','🎰 水果机'],['lotto','🎟️ 彩票'],['wealth','🐾 狗窝账本']];
  return `<div class="seg full fun-seg" role="radiogroup" aria-label="玩法">${T.map(([v,l])=>`<label><input type="radio" name="funTab" value="${v}" ${tab===v?'checked':''}><span>${l}</span></label>`).join('')}</div>`;
}
let ledgerTab='assets';
function wealthCard(){
  const debt=ledgerTab==='debt', mine=debt?D.wealth.myDebt:D.wealth.mine;
  const leaders=debt?D.wealth.debtors:D.wealth.leaders;
  const fmt=n=>n.toLocaleString('zh-CN',{maximumFractionDigits:2});
  return `<section class="card glass wealth-card"><div class="card-head"><h2>🐾 狗窝账本</h2><div class="seg ledger-tabs" aria-label="榜单">${[['assets','💰 财富榜'],['debt','🦴 负债榜']].map(([v,l])=>`<label><input type="radio" name="ledgerTab" value="${v}" ${v===ledgerTab?'checked':''}><span>${l}</span></label>`).join('')}</div></div>
    <div class="wealth-summary"><div><small>${debt?'我欠狗哥':'我的净资产'}</small><div class="fw-bal"><b class="fw-n">${fmt(mine?(debt?mine.debt:mine.assets):0)}</b><span class="fw-i">🦴</span></div></div><span class="chip accent">${mine?`第 ${mine.rank} 名`:'无欠款'}</span></div>
    <ol class="wealth-list">${leaders.map(r=>`<li class="wealth-row">
      <span class="st-no ${r.rank<=3?'st-top':''}">${r.rank}</span>
      <div class="wealth-user"><b>${esc(r.name)}</b>${r.me?'<span class="chip accent">我</span>':''}</div>
      <div class="wealth-worth"><small>${debt?'欠狗哥':'净资产'}</small><b>${fmt(debt?r.debt:r.assets)}</b></div>
      <div class="wealth-detail"><span>余额 <b>${fmt(r.balance)}</b> <small>（白 ${fmt(r.white)} · 红 ${fmt(r.red)}）</small></span><span class="${!debt&&r.debt?'in-debt':''}">${debt?'净资产':'负债'} <b>${fmt(debt?r.assets:r.debt)}</b></span></div>
    </li>`).join('')}</ol>${debt&&!leaders.length?'<p class="ledger-empty">🐶 狗哥翻了翻账本，大家都还清啦。</p>':''}</section>`;
}
function logCard(){
  if(!D.log.length)return '';
  return `<section class="card glass flog"><div class="card-head"><h2>我的记录</h2></div><div class="flog-l">${D.log.map(x=>`<div class="flog-r"><span>${esc(x.what)}</span><span class="faint mono">${new Date(x.ts).toTimeString().slice(0,5)}</span><b class="${x.n>0?'up':x.n<0?'down':'faint'}">${x.n>0?'+':''}${x.n||'—'}</b></div>`).join('')}</div></section>`;
}
const chips=(vals,cur,key,dis)=>`<div class="gchips">${vals.map((v,i)=>`<button type="button" class="gchip k${i}" data-fun="${key}:${v}" aria-pressed="${cur===v}" ${dis?'disabled':''}>${v}</button>`).join('')}</div>`;

/* —— 赛狗 —— */
const P={size:+lsGet('agy-fun-size','4')||4,mode:lsGet('agy-fun-mode','full'),fee:+lsGet('agy-fun-fee','5')||5};
let room=null, RV=null, animId=null, liveT=0;
const raceAt=new Map(), podSeen=new Set();
const dogE=d=>D.cfg.DOGS[d][0], dogN=d=>D.cfg.DOGS[d][1];
const modeName=m=>m==='full'?'人齐发车':'全员准备';
const medal=k=>['🥇','🥈','🥉'][k]||`#${k+1}`;
const fee=(n)=>`<span class="frc-fee">🎟️ ${n}🦴</span>`;
function prizeChips(n,pot){const p=D.cfg.PRIZES[n]||[100];return `<span class="fprz">${p.map((x,k)=>`<span>${medal(k)} ${pot!=null?`${Math.floor(pot*x/100)+(k?0:pot-p.reduce((a,y)=>a+Math.floor(pot*y/100),0))}🦴`:x+'%'}</span>`).join('')}</span>`;}
function createCard(){
  const C=D.cfg,inRace=!!D.myRace;
  return `<section class="card glass frc-new">
    <div class="frc-new-g">
      <div class="seg" role="radiogroup" aria-label="人数">${[2,3,4,5].map(n=>`<label><input type="radio" name="funSize" value="${n}" ${P.size===n?'checked':''}><span>${n} 人</span></label>`).join('')}</div>
      <div class="seg" role="radiogroup" aria-label="发车方式">${[['full','人齐发车'],['ready','全员准备']].map(([v,l])=>`<label><input type="radio" name="funMode" value="${v}" ${P.mode===v?'checked':''}><span>${l}</span></label>`).join('')}</div>
    </div>
    <div class="frc-new-b">${chips(C.FEES,P.fee,'fee')}${prizeChips(P.size)}
      <button class="btn primary frc-go" data-fun="create" ${inRace?'disabled':''}>${ic('plus')}开一场 · ${P.fee}🦴</button></div>
  </section>`;
}
function lobbyRoom(r){
  const inRace=!!D.myRace,full=r.seats.length>=r.size,host=r.seats.find(s=>s.host)||r.seats[0];
  const slots=[...r.seats.map(s=>`<span class="frs ${s.me?'mine':''}"><span class="frs-e">${dogE(s.dog)}</span><b>${esc(s.name)}</b></span>`),
    ...(r.phase==='wait'?[...Array(Math.max(0,r.size-r.seats.length))].map(()=>`<span class="frs empty"><span class="frs-e">＋</span></span>`):[])].join('');
  let st,btn;
  if(r.phase==='wait'){st=`<span class="frc-n">${r.seats.length}<small>/${r.size}</small></span>`;
    btn=!r.mine&&!full&&!inRace?`<button class="btn sm primary" data-fun="join:${r.id}">加入 · ${r.fee}🦴</button>`:`<button class="btn sm" data-fun="open:${r.id}">${r.mine?'进入':'看看'}</button>`;}
  else{const w=r.order?r.seats.find(s=>s.dog===r.order[0]):null;
    st=r.phase==='run'?`<span class="frc-live">比赛中</span>`:`<span class="frc-win">🏆 ${w?`${dogE(w.dog)} ${esc(w.name)}`:''}</span>`;
    btn=`<button class="btn sm" data-fun="open:${r.id}">${r.phase==='run'?'观看':'回放'}</button>`;}
  return `<div class="frc ${r.phase}">
    <div class="frc-h"><span class="avatar sm">${esc((host?.name||r.creator||'?')[0])}</span><b class="frc-host">${esc(r.creator)}</b>${st}</div>
    <div class="frc-tags"><span class="chip">${modeName(r.mode)}</span>${fee(r.fee)}<span class="frc-pot">奖池 <b>${r.pot}</b>🦴</span></div>
    <div class="frc-seats">${slots}</div>
    <div class="frc-f">${prizeChips(Math.max(2,r.seats.length))}${btn}</div>
  </div>`;
}
function lobbyCard(){
  const L=D.races;
  return createCard()+`<section class="card glass"><div class="card-head"><h2>比赛大厅</h2><span class="chip ${L.some(r=>r.phase==='wait')?'accent':''}">${L.filter(r=>r.phase==='wait').length} 场等人</span></div>
    ${L.length?`<div class="frc-grid">${L.map(lobbyRoom).join('')}</div>`:`<div class="fempty">🏟️</div>`}
  </section>`;
}
function lanes(v){return v.seats.slice().sort((a,b)=>a.dog-b.dog);}
function track(v){
  const L=lanes(v),done=v.phase==='done'&&v.order;
  return `<div class="ft" id="fun-track">
    <div class="ft-rail"></div>
    ${L.map((s,i)=>`<div class="ft-lane"><div class="ft-gate b${s.dog}"><span class="ft-no">${i+1}</span><b>${esc(s.name)}</b></div>
      <span class="ft-dog ${s.me?'mine':''} ${done?'fin':''}" id="fun-dog${s.dog}"><span class="ft-e">${dogE(s.dog)}</span><span class="ft-pl ${done?'on k'+(s.place-1):''}" id="fun-pl${s.dog}">${done?s.place:''}</span></span></div>`).join('')||`<div class="ft-lane"></div>`}
    <div class="ft-fin"></div><div class="ft-rail b"></div>
    <div class="ft-count" id="fun-count"></div>
  </div>`;
}
function podium(v){
  const L=v.order.map(d=>v.seats.find(s=>s.dog===d)).filter(Boolean);
  const top=L.slice(0,3),seq=[1,0,2].filter(k=>top[k]);
  const enter=!podSeen.has(v.id);podSeen.add(v.id);
  return `<div class="fpod ${enter?'enter':''}">${seq.map(k=>{const s=top[k];return `<div class="fpod-c p${k+1} ${s.me?'mine':''}">
      <span class="fpod-e">${dogE(s.dog)}</span><b class="fpod-n">${esc(s.name)}</b><span class="fpod-w">${s.win?`+${s.win}🦴`:'—'}</span>
      <div class="fpod-b"><span>${k+1}</span></div></div>`;}).join('')}</div>
    ${L.length>3?`<div class="fpod-rest">${L.slice(3).map((s,k)=>`<span class="${s.me?'mine':''}">${k+4} · ${dogE(s.dog)} ${esc(s.name)}</span>`).join('')}</div>`:''}`;
}
function dogPicker(v){
  const me=v.seats.find(s=>s.me);if(!me)return '';
  const owner=d=>v.seats.find(s=>s.dog===d);
  return `<div class="fdogs">${D.cfg.DOGS.map(([e,n],d)=>{const o=owner(d),mine=o&&o.me;
    return `<button type="button" class="fdog b${d} ${mine?'on':''} ${o&&!mine?'taken':''}" data-fun="pick:${v.id}:${d}" ${o&&!mine?'disabled':''} aria-pressed="${!!mine}">
      <span class="fdog-e">${e}</span><b>${n}</b><small>${o?esc(mine?'我':o.name):'空闲'}</small></button>`;}).join('')}</div>`;
}
function roomCard(){
  const v=RV;if(!v)return `<section class="card glass"><div class="fempty">🐕</div></section>`;
  const me=v.seats.find(s=>s.me),inRace=!!D.myRace,full=v.seats.length>=v.size;
  if(v.phase==='run'&&animId!==v.id&&animId!==-v.id)setTimeout(()=>{if(RV===v&&animId!==v.id&&$('#fun-track'))animate(v);},0);
  const head=`<div class="frm-h">${me&&v.phase==='wait'?'':`<button class="btn sm ghost" data-fun="lobby">${ic('chev')}大厅</button>`}
    <b class="frm-t">${esc(v.creator)} 的比赛</b>
    <span class="chip">${modeName(v.mode)}</span>${fee(v.fee)}<span class="frc-pot">奖池 <b>${v.pot}</b>🦴</span></div>`;
  let body='';
  if(v.phase==='wait'){
    const rd=v.mode==='ready';
    body=`${dogPicker(v)}
    <div class="frm-seats">${v.seats.map(s=>`<div class="frm-s ${s.me?'mine':''}"><span class="frm-se">${dogE(s.dog)}</span><b>${esc(s.name)}</b>${s.host?'<span class="frm-host">房主</span>':''}${rd?`<span class="frm-rd ${s.ready?'on':''}">${s.ready?'已准备':'未准备'}</span>`:''}</div>`).join('')}
      ${[...Array(Math.max(0,v.size-v.seats.length))].map(()=>`<div class="frm-s empty"><span class="frm-se">＋</span></div>`).join('')}</div>
    <div class="frm-f"><span class="frc-n">${v.seats.length}<small>/${v.size}</small></span>${prizeChips(Math.max(2,v.seats.length),v.pot)}
      ${me&&rd?`<button class="btn ${me.ready?'':'primary'}" data-fun="ready:${v.id}">${me.ready?'取消准备':'准备'}</button>`:''}
      ${me?`<button class="btn ghost" data-fun="leave:${v.id}">退出</button>`:!full&&!inRace?`<button class="btn primary" data-fun="join:${v.id}">加入 · ${v.fee}🦴</button>`:''}</div>`;
  }else if(v.phase==='run'){
    body=`<div class="ft-live" id="fun-live"></div>`;
  }else if(v.phase==='done'){
    const tk=raceTicket(v);
    body=`<div class="grc-end ${tk?'':'solo'}">${tk}<div class="grc-pod">${podium(v)}</div></div><div class="frm-f end"><button class="btn primary" data-fun="lobby">回大厅</button></div>`;
  }else body=`<div class="frm-f end"><span class="faint">已解散</span><button class="btn" data-fun="lobby">回大厅</button></div>`;
  return `<section class="card glass frm">${head}${track(v)}${body}</section>`;
}
function raceCard(){if(D.myRace&&!room){room=D.myRace;setTimeout(pollRoom,0);}return room?roomCard():lobbyCard();}
async function openRoom(id){room=id;RV=null;paint();await pollRoom();}
async function pollRoom(){
  if(!room)return;
  const id=room;
  let v;try{v=await api('GET','api/fun/race/'+id);}catch(e){if(room===id){room=null;RV=null;paint();}return;}
  if(room!==id)return;
  RV=v;
  if(v.phase==='run'&&animId===v.id)return;
  if(v.phase==='run'&&animId===-v.id){setTimeout(pollRoom,1000);return;}
  if(v.phase==='done'&&!raceAt.has(v.id))raceAt.set(v.id,Date.now());
  paint();
}
function stopAnim(){if(animId>0)busy=false;animId=null;}
const lerpPos=(cp,t)=>{const K=cp.length;if(t<=0)return 0;if(t>=cp[K-1])return 1;let k=0;while(cp[k]<=t)k++;const a=k?cp[k-1]:0;return (k+(t-a)/(cp[k]-a))/K;};
function trackW(){const tr=$('#fun-track'),g=tr?.querySelector('.ft-gate');return tr?tr.clientWidth-(g?.offsetWidth||80)-56:0;}
// 赛事票根：从跑道下沿吐出，前三盖名次章
function raceTicket(v){
  const me=v.seats.find(s=>s.me);if(!me||!v.order)return '';
  const k=v.order.indexOf(me.dog);if(k<0)return '';
  const st=k<3?{c:'k'+k,t:['冠军','亚军','季军'][k]}:{c:'grey sm',t:'再接<br>再厉'};
  return `<div class="gout grc-out"><i class="gout-m"></i>${ticket({cls:'race'+(k===0&&me.win>0?' gold':''),head:'<b>DOG RACE</b>',no:`No.${String(v.id).padStart(5,'0')}`,
    body:`<div class="gtk-big"><span>${dogE(me.dog)}</span><em>${esc(dogN(me.dog))}</em></div>${rows([['名次',`第 ${k+1} 名`],['奖金',me.win>0?`+${me.win}🦴`:'0','up'],['人数',`${v.seats.length} 人`],['奖池',`${v.pot}🦴`]])}`,
    foot:when(v.endAt||v.startAt||now()),stamp:st,at:raceAt.get(v.id)||0})}</div>`;
}
function animate(v){
  animId=v.id;busy=true;
  const dogs=Object.keys(v.plan).map(Number),end=Math.max(...dogs.map(d=>v.plan[d][v.plan[d].length-1]));
  const fin=new Set();let lastLive='';
  const step=()=>{
    const tr=$('#fun-track');if(animId!==v.id)return;if(!tr||room!==v.id){busy=false;animId=null;return;}
    const W=trackW(),t=now()-v.startAt,cnt=$('#fun-count');
    if(cnt){const s=t<0?String(Math.ceil(-t/1000)):t<600?'跑！':'';if(cnt.textContent!==s){cnt.textContent=s;cnt.classList.remove('pop');void cnt.offsetWidth;if(s)cnt.classList.add('pop');}}
    const pos=dogs.map(d=>({d,p:lerpPos(v.plan[d],t),T:v.plan[d][v.plan[d].length-1]}));
    for(const x of pos){const el=$('#fun-dog'+x.d);if(!el)continue;
      el.style.transform=`translateX(${(x.p*W).toFixed(1)}px)`;el.classList.toggle('run',t>0&&x.p<1);
      if(x.p>=1&&!fin.has(x.d)){fin.add(x.d);const k=v.order.indexOf(x.d),pl=$('#fun-pl'+x.d);if(pl){pl.textContent=k+1;pl.className='ft-pl on pin k'+k;}}}
    if(Date.now()-liveT>140){liveT=Date.now();
      const ord=pos.slice().sort((a,b)=>(b.p>=1&&a.p>=1)?a.T-b.T:b.p-a.p).map(x=>x.d),key=ord.join();
      const lv=$('#fun-live');if(lv&&key!==lastLive){lastLive=key;lv.innerHTML=ord.map((d,k)=>{const s=v.seats.find(z=>z.dog===d);return `<span class="ftl ${s?.me?'mine':''} ${k===0?'lead':''}"><i>${k+1}</i>${dogE(d)} ${esc(s?.name||'')}</span>`;}).join('');}}
    if(t>end+400){busy=false;animId=-v.id;load().then(()=>pollRoom());return;}
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* —— 水果机 —— */
let slBet=+lsGet('agy-fun-slbet','1')||1, reels=[4,4,4], lastHit=null, slFresh=null;
// 小票从流水重建：「水果机 🐾🦴🍖」+ 净输赢 n，倍数按图案算回来，押注 = n/(倍数-1) 或 −n
function slotTks(){
  const S=D.cfg.SYM,out=[];
  for(const x of D.log||[]){
    if(typeof x.what!=='string'||!x.what.startsWith('水果机 '))continue;
    const s=[...x.what.slice(4).trim()].map(e=>S.findIndex(y=>y[0]===e));
    if(s.length!==3||s.some(i=>i<0))continue;
    const [a,b,c]=s,three=a===b&&b===c;
    const m=three?S[a][2]:(a===b||a===c)?S[a][3]:b===c?S[b][3]:0;
    const n=+x.n||0,bet=m>1?Math.round(n/(m-1)):Math.max(0,-n);
    out.push({s,ts:x.ts,m,bet,win:m*bet,three:three&&m>0});
    if(out.length>=3)break;
  }
  return out;
}
function slotTicket(t,k){
  const S=D.cfg.SYM,sy=t.s.map(i=>S[i][0]).join(''),res=t.win>0?`+${t.win}🦴`:'未中';
  return ticket({cls:`slot ${t.three?'gold':''} ${k?'old':''}`,sty:k?`--k:${k}`:'',fun:k?'tk':'',
    head:'<b>DOG SLOTS</b>',no:`No.${String(t.ts).slice(-6)}`,
    sum:`<span class="gtk-sy">${sy}</span><b class="${t.win>0?'up':''}">${res}</b><span>${when(t.ts).slice(6,11)}</span>`,
    body:`<div class="gtk-big sy">${sy}</div>${rows([['押注',`${t.bet}🦴`],['倍数',t.m?`×${t.m}`:'—'],['派彩',res,t.win>0?'up':'dim']])}`,
    foot:when(t.ts),stamp:t.win>0?{c:'red',t:'中'}:null,at:!k&&slFresh&&slFresh.ts===t.ts?slFresh.at:0});
}
let rankTab='wins';
const boostPending=new Set();
function rankSlip(){
  const peach=rankTab==='peach', loss=rankTab==='losses';
  const list=peach?D.slotBoost.leaders:D.slotRanks[rankTab];
  const amount=n=>peach?`${n}<small>次</small>`:`${n>0?'+':''}${n}<small>🦴</small>`;
  return `<section class="peach-slip" data-board="${rankTab}" aria-label="水果机排行榜">
    <header><b>水果机排行</b><span aria-hidden="true">★</span></header>
    <div class="rank-switch" role="group" aria-label="切换排行榜">${[['wins','净赢'],['losses','净输'],['peach','卖屁股']].map(([v,label])=>`<button data-fun="rank:${v}" aria-pressed="${rankTab===v}">${label}</button>`).join('')}</div>
    <ol>${list.map((u,i)=>`<li><i>${p2(i+1)}</i><span>${esc(u.name)}</span><strong>${!peach&&u.net==null?'未上机':amount(peach?u.uses:u.net)}</strong></li>`).join('')}</ol>
    ${list.length?'':`<p>${peach?'还没人上榜':loss?'暂无净输玩家':'暂无净赢玩家'}</p>`}
    <footer>${peach?'我的次数':'我的净输赢'}<strong>${amount(peach?D.slotBoost.uses:D.slotRanks.mine)}</strong></footer></section>`;
}
const boostOdds=b=>`本把胜率约 ${(b.chance*100).toFixed(1)}% · 含未中时 25% 的免费重摇机会`;
function slotsCard(){
  const S=D.cfg.SYM;
  const three=S.map(([s,,m3])=>`<div class="fpay-r"><span>${s}${s}${s}</span><b>×${m3}</b></div>`).reverse().join('');
  const two=S.filter(x=>x[3]).map(([s,,,m2])=>`<div class="fpay-r"><span>${s}${s}</span><b>×${m2}</b></div>`).reverse().join('');
  return `<section class="card glass fsl"><div class="gsl">
    <div class="gsl-m">
      <div class="fcab" id="fun-cab">
        <div class="fcab-top"><span class="fcab-lg" role="status">DOG SLOTS</span></div>
        <div class="fcab-lights">${'<i></i>'.repeat(11)}</div>
        <div class="freels">${reels.map((s,i)=>`<div class="freel ${lastHit&&lastHit.includes(i)?'hit':''}"><div class="fstrip" id="fun-r${i}"><div>${S[s][0]}</div></div></div>`).join('')}<div class="fline"></div></div>
        <div class="fcab-ctl"><div class="stake-line"><span>押注</span>${chips(D.cfg.SLOT_BETS,slBet,'slbet',busy)}</div>
          <div class="lever-line"><button class="peach-key" data-fun="slotboost" ${busy?'disabled':''} data-ready="${D.slotBoost.ready}"><span aria-hidden="true">🍑</span><span class="peach-label">${D.slotBoost.ready?'下把已加运':'卖屁股'}</span><i aria-hidden="true"></i></button>
          <button class="fpull" data-fun="pull" ${busy?'disabled':''}>拉！</button></div>
          <small class="peach-odds" ${D.slotBoost.ready?'':'hidden'}>${boostOdds(D.slotBoost)}</small></div>
      </div>
      <div class="gout gsl-out"><i class="gout-m"></i>${slotTks().map(slotTicket).join('')}</div>
    </div>
    <aside class="slot-side">${rankSlip()}
    <div class="fpay"><div class="fpay-c">${three}</div><div class="fpay-c two">${two}</div></div></aside>
  </div></section>`;
}
async function pull(){
  if(busy)return;busy=true;lastHit=null;
  document.querySelectorAll('.fsl button').forEach(b=>b.disabled=true);
  document.querySelectorAll('.freel.hit').forEach(x=>x.classList.remove('hit'));
  await Promise.all(boostPending);
  let r;try{r=await api('POST','api/fun/slots',{bet:slBet});}catch(e){busy=false;oops(e);load().then(paint);return;}
  const S=D.cfg.SYM,cab=$('#fun-cab');cab?.classList.remove('jack','win');cab?.classList.add('go');
  const H=$('.freel')?.clientHeight||100;
  r.reels.forEach((s,i)=>{
    const el=$('#fun-r'+i);if(!el)return;const n=18+i*7,cells=[reels[i]];for(let k=0;k<n;k++)cells.push(Math.floor(Math.random()*S.length));cells.push(s);
    el.style.transition='none';el.style.transform='translateY(0)';el.innerHTML=cells.map(c=>`<div>${S[c][0]}</div>`).join('');
    void el.offsetHeight;el.style.transition=`transform ${1.1+i*.45}s cubic-bezier(.3,.1,.2,1.04)`;el.style.transform=`translateY(${-(cells.length-1)*H}px)`;
  });
  await new Promise(x=>setTimeout(x,1100+2*450+150));
  reels=r.reels;busy=false;
  const [a,b,c]=r.reels;
  lastHit=r.three?[0,1,2]:r.win?(a===b?[0,1]:a===c?[0,2]:[1,2]):null;
  await load();
  const t=slotTks()[0];if(t)slFresh={ts:t.ts,at:Date.now()};
  render();
  const cab2=$('#fun-cab');
  if(r.three){cab2?.classList.add('jack');confetti(PRINT);}
  else if(r.win)cab2?.classList.add('win');
}

/* —— 彩票 —— */
let pick=[0,0], spPick=0, mult=+lsGet('agy-fun-mult','1')||1, ltFresh=null, drawFresh=null;
const RECENT=10*60e3, ROLL=[900,1600,2300];
let rollAt=0, rollLabel='', rollT=0;
const cdText=()=>{const s=Math.max(0,Math.round((D.lotto.endsAt-now())/1000));return `${p2(Math.floor(s/60))}:${p2(s%60)}`;};
const dial=(k,d,cls='')=>`<div class="fdial ${cls}"><button type="button" data-fun="dial:${k}:1" aria-label="加一">${ic('chev')}</button><span>${d}</span><button type="button" data-fun="dial:${k}:-1" aria-label="减一">${ic('chev')}</button></div>`;
const balls=(nums,sp,hit)=>`<span class="fballs">${nums.map((d,i)=>`<b class="${hit&&hit[i]===d?'hit':''}">${d}</b>`).join('')}<b class="sp">${sp}</b></span>`;
// 最近一期开奖：本人第一次看到它的时间存本地，十分钟内且本期还没买 → 「我的彩票」显示上期盖好章的票
const recent=h=>h&&lsGet('agy-fun-drawn','')===h.label&&Date.now()-(+lsGet('agy-fun-drawnAt','0')||0)<RECENT;
function rollTick(){
  const e=Date.now()-rollAt;
  document.querySelectorAll('.glt-ball[data-v]').forEach((b,i)=>{
    const stop=ROLL[Math.min(i,2)];
    if(e<stop){b.textContent=Math.floor(Math.random()*10);b.classList.add('roll');}
    else if(b.classList.contains('roll')){b.textContent=b.dataset.v;b.classList.remove('roll');b.classList.add('set');}
  });
  const hint=document.getElementById('lotto-reveal');
  if(hint && e>=ROLL[1])hint.textContent=hint.dataset.close==='1'?'前两位全中，等最后一球！':'最后一球，揭特码！';
  if(e>ROLL[2]+80){clearInterval(rollT);rollT=0;paint();}
}
function startRoll(h){
  rollAt=Date.now();rollLabel=h.label;
  if(!rollT)rollT=setInterval(rollTick,70);
  if(h.mine.some(t=>t.hits===2&&(h.rules!==2||t.spHit)&&t.win>0))confetti(ROLL[2]+300);
}
const rolling=h=>!reduced()&&rollLabel===h.label&&Date.now()-rollAt<ROLL[2];
function lotTicket(t,i,label,h){
  const C=D.cfg,res=h?h.res:null,hit=res?t.nums.map((d,k)=>d===res[k]):[];
  const won=!!(res&&t.win>0),gold=won&&t.hits===2&&(h.rules!==2||t.spHit);
  const stamp=res?(won?{c:'red',t:`中<small>+${t.win}🦴</small>`}:{c:'grey',t:t.hits?'中一位 · 无奖':'未中'}):null;
  const sAt=res&&rollLabel===h.label?rollAt+ROLL[2]+250:0;
  return ticket({cls:`lt ${gold?'gold':''} ${res&&!won?'void':''}`,head:'<b>大锅饭</b>',no:esc(label),
    body:`<div class="gtk-num">${t.nums.map((d,k)=>`<b class="${hit[k]?'hit':''}">${d}</b>`).join('')}<i>+</i><b class="sp ${res&&t.spHit?'hit':''}">${t.sp}</b></div>
      <div class="gtk-mx"><span>×${t.mult}</span><span>${C.TICKET*t.mult}🦴</span></div>`,
    foot:res&&h.rules===2?(gold?'🐕 狗哥开金库！':t.hits+Number(t.spHit)===2?'🍖 叼走一块肉':t.spHit?'🐾 狗哥认得你':t.nums[0]===res[1]&&t.nums[1]===res[0]?'🐕 前两个站反了。':'🐕 下期再会！'):`No.${esc(String(label).replace(/\D/g,''))}${p2(i+1)}`,stamp,
    at:!res&&!i&&ltFresh&&ltFresh.n===D.lotto.mineCount?ltFresh.at:0,sAt:sAt||(res?1:0)});
}
function lottoCard(){
  const L=D.lotto,C=D.cfg,left=C.TICKETS-L.mineCount,h=L.hist[0];
  if(h&&drawFresh===h.label){drawFresh=null;if(recent(h)&&!reduced())startRoll(h);}
  // 买票
  const buy=`<div class="glt-buy"><div class="fticket">
    <div class="flt-top"><div class="flt-tt"><b>大锅饭彩票</b><span>第 ${esc(L.label)} 期</span></div><span class="flt-left">${L.mineCount}/${C.TICKETS}</span></div>
    <div class="fdials">${pick.map((d,i)=>dial(i,d)).join('')}<span class="fplus">+</span>${dial('s',spPick,'sp')}</div>
    <div class="flt-mult">${C.LOT_MULTS.map(m=>`<button type="button" class="fmult" data-fun="mult:${m}" aria-pressed="${mult===m}">×${m}</button>`).join('')}</div>
    <div class="flt-act"><button class="btn" data-fun="rand">${ic('refresh')}机选</button><button class="btn primary" data-fun="buy" ${left>0?'':'disabled'}>买一注 · ${C.TICKET*mult}🦴</button></div>
    <div class="fperf"></div>
    <div class="flt-pay"><div><span>三位全中</span><b>分全池</b></div><div><span>任意两位</span><b>${C.SECOND_PRIZE}🦴/倍</b></div><div><span class="spc">只中特码</span><b>${C.SP_BACK}🦴/倍</b></div></div>
  </div></div>`;
  // 等待开奖
  const roll=h&&rolling(h);
  const ball=(d,k,sp)=>`<b class="glt-ball ${sp?'sp':''} ${roll?'roll':''}" ${roll?`data-v="${d}"`:''}>${roll?'?':d}</b>`;
  const draw=`<div class="glt-pn glt-dr">
    <div class="glt-hd"><b>等待开奖</b><span class="glt-iss">${esc(L.label)}</span></div>
    <div class="glt-cd" id="fun-cd">${cdText()}</div>
    <div class="glt-st"><div><span>奖池</span><b>${L.pot}<i>🦴</i></b></div><div><span>本期</span><b>${L.count}<i>注</i></b></div>${L.carry>C.SEED?`<div><span>滚存</span><b>${L.carry}<i>🦴</i></b></div>`:''}</div>
    ${h?`<div class="glt-last"><span class="glt-iss">${esc(h.label)}</span><span class="glt-bs">${h.res.map((d,k)=>ball(d,k)).join('')}<i>+</i>${ball(h.sp,2,1)}</span></div>`:''}
    ${D.admin?`<button class="btn sm ghost glt-adm" data-fun="drawlot">${ic('play')}现在开奖</button>`:''}
  </div>`;
  // 我的彩票：本期的；本期还没买、上期刚开过 → 上期的（盖章）
  const mine=L.tickets.filter(t=>t.me);
  const showLast=!mine.length&&recent(h)&&h.mine.length;
  const list=showLast&&roll?[]:showLast?h.mine.map((t,i)=>lotTicket(t,i,h.label,h)):mine.map((t,i)=>lotTicket(t,i,L.label,null));
  const my=`<div class="glt-pn glt-my">
    <div class="glt-hd"><b>我的彩票</b><span class="chip ${showLast&&h.myWin>0?'good':''}">${showLast&&roll?'开奖中':showLast?(h.myWin>0?`+${h.myWin}🦴`:esc(h.label)):`${L.mineCount}/${C.TICKETS}`}</span></div>
    <div class="glt-tks">${roll&&showLast?`<div id="lotto-reveal" data-close="${h.mine.some(t=>t.hits===2)?1:0}">摇号中…</div>`:list.join('')||`<div class="glt-none">🎟️</div>`}</div>
  </div>`;
  const tks=L.tickets.length?`<div class="glt-pn glt-bets"><div class="glt-hd"><b>本期投注</b><span class="chip">${L.count}</span></div><div class="flt-bets">${L.tickets.map(t=>`<div class="flt-bet ${t.me?'mine':''}"><span class="flt-u">${esc(t.name)}</span>${balls(t.nums,t.sp)}<span class="flt-x">×${t.mult}</span></div>`).join('')}</div></div>`:'';
  const hist=L.hist.length?`<div class="glt-pn glt-hist"><div class="glt-hd"><b>往期</b></div><div class="flt-hist">${L.hist.filter(x=>!roll||x!==h).map(x=>`<div class="flt-h"><span class="glt-iss">${esc(x.label)}</span>${balls(x.res,x.sp)}<span class="faint">${x.pot}🦴</span><span class="faint" title="${esc((x.winners||[]).join('、'))}">${x.nTop?`头奖 ${x.nTop} 注`:'滚存'}</span><b class="${x.myWin?'up':'faint'}">${x.myWin?'+'+x.myWin:x.mine.length?'未中':'—'}</b></div>`).join('')}</div></div>`:'';
  return `<section class="card glass glt"><div class="glt-g">${buy}${draw}${my}${tks}${hist}</div></section>`;
}
// 开奖：记住看过的最新一期和第一次看到的时间；之前看过别的期 → 这期要滚号
function checkDraw(){
  const h=D?.lotto?.hist?.[0];if(!h)return;
  const seen=lsGet('agy-fun-drawn','');
  if(seen===h.label)return;
  lsSet('agy-fun-drawn',h.label);lsSet('agy-fun-drawnAt',String(Date.now()));
  if(seen)drawFresh=h.label;
}

/* —— 入口 —— */
window.funTab=()=>{
  sseOpen();
  if(!D){load().then(paint);return `<div class="fun-root"></div><section class="card glass"><div class="fempty">🦴</div></section>`;}
  try{if(!['race','slots','lotto','wealth'].includes(tab))tab='race';
    return `<div class="fun-root"></div>`+wallet()+seg()+({race:raceCard,slots:slotsCard,lotto:lottoCard,wealth:wealthCard}[tab]())+logCard();}
  catch(e){console.error(e);return `<section class="card glass"><div class="mono faint">${esc(e&&e.stack||e)}</div></section>`;}
};

document.addEventListener('click',async e=>{
  const el=e.target.closest('[data-fun]');if(!el||el.disabled)return;
  const [a,x,y]=el.dataset.fun.split(':');
  if(a==='tk'){el.classList.toggle('open');return;}
  if(a==='borrow'){if(await act('borrow',{n:+x}))toast(`狗哥借你 ${x}🦴`);paint();}
  else if(a==='repay'){const r=await act('repay');if(r)toast(r.left?`还了 ${r.paid}🦴，还欠 ${r.left}🦴`:`债清了 · 还了 ${r.paid}🦴`);paint();}
  else if(a==='g4a'){const r=await act('g4a',{n:+x});if(r)toast(`G4A +${x} 次 · 剩 ${r.argon} 次`);paint();}
  else if(a==='vip'){const r=await act('vip-redeem',{count:+x});if(r)toast(`VIP 节点 +${x} 次 · 剩 ${r.vipQuota} 次`);paint();}
  else if(a==='inf'){await act('inf');paint();}
  else if(a==='lobby'){stopAnim();room=null;RV=null;await load();paint();}
  else if(busy)return;
  else if(a==='fee'){P.fee=+x;lsSet('agy-fun-fee',x);paint();}
  else if(a==='create'){const r=await act('race',{size:P.size,mode:P.mode,fee:P.fee});if(r)openRoom(r.id);else paint();}
  else if(a==='join'){const r=await act(`race/${x}/join`);if(r)openRoom(+x);else paint();}
  else if(a==='open')openRoom(+x);
  else if(a==='pick'){const id=+x;if(await act(`race/${id}/dog`,{dog:+y}))pollRoom();}
  else if(a==='leave'){if(await act(`race/${x}/leave`)!==null){room=null;RV=null;}paint();}
  else if(a==='ready'){await act(`race/${x}/ready`);pollRoom();}
  else if(a==='slbet'){slBet=+x;lsSet('agy-fun-slbet',x);paint();}
  else if(a==='rank'){rankTab=x;paint();document.querySelector(`.rank-switch [aria-pressed="true"]`)?.focus({preventScroll:true});}
  else if(a==='slotboost'){
    const request=api('POST','api/fun/slots/boost',{}).then(state=>{
      
      const boost=D.slotBoost;
      boost.ready=true;
      boost.uses=Math.max(boost.uses,state.uses);
      const cab=$('#fun-cab');
      if(!cab)return;
      const key=cab.querySelector('.peach-key');
      key.dataset.ready='true';
      key.querySelector('.peach-label').textContent='下把已加运';
      const odds=cab.querySelector('.peach-odds');
      odds.hidden=false;
      odds.textContent=boostOdds(boost);

    }).catch(oops);
    boostPending.add(request);
    request.finally(()=>boostPending.delete(request));
  }
  else if(a==='pull')pull();
  else if(a==='dial'){if(x==='s')spPick=(spPick+(+y)+10)%10;else pick[+x]=(pick[+x]+(+y)+10)%10;paint();}
  else if(a==='rand'){pick=pick.map(()=>Math.floor(Math.random()*10));spPick=Math.floor(Math.random()*10);paint();}
  else if(a==='mult'){mult=+x;lsSet('agy-fun-mult',x);paint();}
  else if(a==='buy'){if(await act('lotto/buy',{nums:pick,sp:spPick,mult}))ltFresh={n:D.lotto.mineCount,at:Date.now()};paint();}
  else if(a==='drawlot'){await act('lotto/draw');paint();}
});
document.addEventListener('keydown',e=>{const el=e.target.closest?.('[data-fun=tk]');if(el&&(e.key==='Enter'||e.key===' ')){e.preventDefault();el.classList.toggle('open');}});
document.addEventListener('change',e=>{
  const t=e.target;
  if(t.name==='ledgerTab'){ledgerTab=t.value;paint();document.querySelector('input[name=ledgerTab]:checked')?.focus({preventScroll:true});return;}
  if(t.name==='funSize'){P.size=+t.value;lsSet('agy-fun-size',t.value);paint();return;}
  if(t.name==='funMode'){P.mode=t.value;lsSet('agy-fun-mode',t.value);return;}
  if(t.name!=='funTab')return;
  if(busy&&!(animId>0)){t.checked=false;const c=document.querySelector(`input[name=funTab][value=${tab}]`);if(c)c.checked=true;return;}
  stopAnim();
  tab=t.value;lsSet('agy-fun-tab3',tab);paint();
});

/* —— 实时推送：收到就防抖拉一次；断线 EventSource 自己重连，彻底断了这边再开 —— */
let es=null, esAt=0, deb=0;
function sseOpen(){
  if(es||typeof EventSource==='undefined'||Date.now()-esAt<3000)return;
  esAt=Date.now();
  try{es=new EventSource('api/fun/stream');}catch(e){es=null;return;}
  es.onmessage=ev=>{let m;try{m=JSON.parse(ev.data);}catch(e){return;}
    if(m.hello&&Date.now()-loadedAt<1500)return;
    if(m.news&&onPage())for(const n of m.news)if(n.src==='dc'&&D?.myRace!==n.id)dcToast(n);
    if(D&&!m.races&&!m.hello&&m.v===D.v)return;
    kick();};
  es.onerror=()=>{if(es&&es.readyState===2){es.close();es=null;}};
}
// Discord 上有人开了赛狗：右下角提示，点「去看看」打开那个房间
function dcToast(n){const t=document.createElement('div');t.className='toast act';
  t.innerHTML=`${ic('check')}${esc(n.host||'有人')} 在 Discord 开了一场赛狗<button class="btn sm primary">去看看</button>`;
  const bye=()=>{t.style.transition='opacity .3s';t.style.opacity='0';setTimeout(()=>t.remove(),300);};
  t.querySelector('button').addEventListener('click',()=>{bye();if(tab!=='race'){tab='race';lsSet('agy-fun-tab3',tab);}openRoom(n.id);});
  $('#toasts')?.append(t);setTimeout(bye,10000);}
function sseClose(){if(es){es.close();es=null;}}
function kick(){clearTimeout(deb);deb=setTimeout(async()=>{if(!onPage())return;await load();if(room&&tab==='race')await pollRoom();else paint();},180);}
// 每秒：欠款跳动、彩票倒计时、连接看护；60 秒兜底刷新一次
let tick=0;
setInterval(()=>{
  if(!onPage()){sseClose();return;}
  sseOpen();
  if(!D||document.visibilityState!=='visible')return;tick++;
  const ow=$('#fun-owed');if(ow)ow.textContent=owedNow(D.wallet).toFixed(2);
  const cd=$('#fun-cd');if(cd)cd.textContent=cdText();
  if(tick%60===0&&!busy)kick();
},1000);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&onPage()&&D)kick();});
})();
