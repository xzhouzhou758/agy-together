/* 我的凭证页的排序逻辑（纯函数，照 agy-me filter.js 的 totalLeft / nextSort / sort） */
(function(g){
'use strict';
const TIERS=['PRO','ULTRA','FREE'];
const SORTS=[['quota','模型配额'],['created','导入时间']];
/** 凭证页表头只排模型配额 */
const QUOTA_SORTS=['quota'];
const FAMS=['gemini','claude','argon','carbon'];
/** 档位：旧缓存里的 ENTERPRISE / standard 一律当 FREE */
function tierOf(t){
  if(!t)return '';const x=String(t).toLowerCase();
  if(x.includes('ultra'))return 'ULTRA';if(x.includes('pro'))return 'PRO';
  return 'FREE';
}
/** 封号 / 403：门户里是「有问题」或「异常」的号 */
const isBad=a=>!!(a.problem||a.state==='error'||a.forbidden);
const liveB=(b,now)=>b&&b.reset&&Date.parse(b.reset)<=now?{frac:1,reset:null}:b;
/** 某个模型还剩多少：5H / 7D 里少的那个；封号、403、没开通、没数据都算没有 */
function famLeft(a,k,now){
  const q=a.quota;if(!q||isBad(a))return null;
  const f=q.fams?.[k];if(!f)return null;
  const v=[liveB(f.h5,now),liveB(f.week,now)].filter(Boolean).map(b=>b.frac);
  return v.length?Math.min(...v):null;
}
/** 总配额：四个模型各自剩余（0–1）加起来；封号、403、没数据算没有（不管正序倒序都排最后） */
function totalLeft(a,now){
  const q=a.quota;if(!q||isBad(a))return null;
  let t=0,n=0;for(const k of FAMS){const v=famLeft(a,k,now);if(v!=null){t+=v;n++;}}
  return n?t:null;
}
function sortVal(a,k,now){
  switch(k){
    case 'quota':return totalLeft(a,now);
    case 'gemini':case 'claude':case 'argon':case 'carbon':return famLeft(a,k,now);
    default:return Number(a.createdAt)||null;
  }
}
/** 下一次点这个表头之后的排序键。配额列：剩得多的在前 → 剩得少的在前 → 回到默认（导入时间）；其它列：正序 ↔ 倒序 */
function nextSort(cur,k){
  cur=cur||'';
  if(QUOTA_SORTS.includes(k))return cur==='-'+k?k:cur===k?'':'-'+k;
  return cur===k?'-'+k:k;
}
/** 排好序的新数组（不改原数组）；空键＝按导入时间（先导入的在前）；没数据的永远最后，并列按原顺序 */
function sort(list,key,now=Date.now()){
  key=key||'created';
  const desc=key.startsWith('-'),k=desc?key.slice(1):key,dir=desc?-1:1;
  const cmp=(x,y)=>x<y?-1:x>y?1:0;
  return list.map((a,i)=>({a,i,v:sortVal(a,k,now)})).sort((x,y)=>{
    if(x.v==null||y.v==null){if(x.v!=null)return -1;if(y.v!=null)return 1;return x.i-y.i;}
    return cmp(x.v,y.v)*dir||x.i-y.i;
  }).map(x=>x.a);
}
g.AF={TIERS,SORTS,QUOTA_SORTS,FAMS,tierOf,isBad,famLeft,totalLeft,sort,nextSort};
})(typeof window!=='undefined'?window:globalThis);
