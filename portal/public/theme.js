/* 首帧前确定主题，避免闪烁 */
(function(){var t='auto';try{t=localStorage.getItem('agy-theme')||'auto'}catch(e){}
var dark=t==='dark'||(t==='auto'&&matchMedia('(prefers-color-scheme: dark)').matches);
document.documentElement.dataset.theme=dark?'dark':'light';})();
