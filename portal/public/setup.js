(()=>{
'use strict';
const f=document.getElementById('setup'),redir=document.getElementById('redir'),msg=document.getElementById('msg');
const ERR={invalid_setup_token:'Setup Token 无效',invalid_admin_id:'Discord ID 无效',invalid_public_url:'站点地址无效',invalid_client_id:'Client ID 无效',
  invalid_guild_id:'Guild ID 无效',invalid_id:'Role ID 无效',discord_incomplete:'Discord 配置不完整'};
const show=(k,t)=>{msg.innerHTML='';const d=document.createElement('div');d.className='result '+k;const b=document.createElement('b');b.textContent=t;d.append(b);msg.append(d);};
const upd=()=>{const v=f.publicURL.value.trim().replace(/\/+$/,'');redir.textContent=v?v+'/auth/discord/callback':'—';};
f.publicURL.addEventListener('input',upd);
if(!f.publicURL.value)f.publicURL.value=new URL('.',location.href).href.replace(/\/+$/,'');upd();
document.getElementById('copy').addEventListener('click',()=>{navigator.clipboard?.writeText(redir.textContent);});
f.addEventListener('submit',async e=>{
  e.preventDefault();
  const b=Object.fromEntries(new FormData(f).entries());
  for(const k in b)b[k]=String(b[k]).trim();
  try{
    const r=await fetch('api/setup',{method:'POST',headers:{'Content-Type':'application/json','X-Portal-CSRF':'1'},body:JSON.stringify(b)});
    const d=await r.json().catch(()=>({}));
    if(!r.ok){show('err',ERR[d.error]||'保存失败');return;}
    f.querySelectorAll('input,button').forEach(x=>x.disabled=true);
    show('ok','已完成');
    setTimeout(()=>location.href='./',1500);
  }catch(err){show('err','保存失败');}
});
})();
