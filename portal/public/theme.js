/* 首帧前确定风格、配色与日夜模式，避免闪烁 */
(function(){
  var t='auto',s='glass',p='azure';
  try{
    t=localStorage.getItem('agy-theme')||'auto';
    s=localStorage.getItem('agy-style')||'glass';
    p=localStorage.getItem('agy-palette')||'azure';
  }catch(e){}
  var dark=t==='dark'||(t==='auto'&&matchMedia('(prefers-color-scheme: dark)').matches);
  var d=document.documentElement.dataset;
  d.theme=(s==='terminal'||dark)?'dark':'light';
  d.style=s;
  d.palette=p;
})();
