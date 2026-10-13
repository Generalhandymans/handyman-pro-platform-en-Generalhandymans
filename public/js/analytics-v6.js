(function(){
  'use strict';

  const ga = document.querySelector('meta[name="ga4-measurement-id"]')?.content;
  if(ga && /^G-[A-Z0-9]+$/.test(ga)){
    const s=document.createElement('script');
    s.async=true;s.src='https://www.googletagmanager.com/gtag/js?id='+encodeURIComponent(ga);
    document.head.appendChild(s);
    window.dataLayer=window.dataLayer||[];
    window.gtag=function(){dataLayer.push(arguments);};
    gtag('js',new Date());gtag('config',ga,{send_page_view:true});
  }

  window.HMAnalytics={
    event(name,params={}){
      try{
        if(window.gtag) gtag('event',name,params);
      }catch(_){}
    }
  };

  document.addEventListener('click',e=>{
    const el=e.target.closest('a,button');
    if(!el)return;
    const txt=(el.textContent||'').trim().slice(0,80);
    if(/estimate|request|book|quote|start|contact/i.test(txt)){
      window.HMAnalytics.event('cta_click',{label:txt,path:location.pathname});
    }
  });
})();
