// HELPMAN Phase 5 — AI Scope review button in customer requests.
(function(){
  'use strict';

  function enhance(){
    const box=document.getElementById('requests-list');if(!box)return;
    const obs=new MutationObserver(()=>{
      box.querySelectorAll('.job-card').forEach(card=>{
        if(card.dataset.hm5)return;card.dataset.hm5='1';
        const head=card.querySelector('.job-head button');if(!head)return;
        head.addEventListener('click',()=>setTimeout(()=>{
          const body=card.querySelector('.job-body');if(!body||body.querySelector('.hm5-scope'))return;
          const m=(card.textContent||'').match(/#(\d+)/);if(!m)return;
          const id=m[1];
          const sec=document.createElement('div');sec.className='hm5-scope';
          sec.innerHTML=`<hr class="divider"><div class="section-head"><div><h4 style="margin:0">Helpman Project Intelligence</h4><p class="small muted">Turn your description and photos into a structured project scope. This is planning assistance, not a final diagnosis or quote.</p></div><button class="btn btn-primary btn-sm">Build smart scope</button></div><div class="hm5-scope-out"></div>`;
          body.appendChild(sec);
          sec.querySelector('button').onclick=async()=>{
            const out=sec.querySelector('.hm5-scope-out');out.innerHTML='<p class="muted">Analyzing project information…</p>';
            try{
              const r=await HP.api('POST',`/intelligence/jobs/${id}/build-scope`,{});
              out.innerHTML=`<div class="hm5-scope-card">
                <div class="section-head"><strong>Structured scope</strong>${HP.badge(`${r.confidence}% confidence`,r.confidence>=75?'ok':r.confidence>=60?'info':'warn')}</div>
                <p>${HP.esc(r.summary||'Scope created from the information provided.')}</p>
                ${r.missing_information?.length?`<div><strong>Still needed</strong><ul>${r.missing_information.map(x=>`<li>${HP.esc(x)}</li>`).join('')}</ul></div>`:''}
                ${r.risk?.flags?.length?`<div><strong>Review flags</strong><ul>${r.risk.flags.map(x=>`<li>${HP.esc(x.note)}</li>`).join('')}</ul></div>`:''}
                <p class="small muted">${r.human_review_required?'A Helpman team review is recommended before a final quote.':'Information is sufficient for the next planning step, subject to final professional review.'}</p>
              </div>`;
            }catch(e){out.innerHTML=`<p class="muted">${HP.esc(HP.friendlyMessage(e))}</p>`;}
          };
        },120));
      });
    });
    obs.observe(box,{childList:true,subtree:true});
  }
  document.addEventListener('DOMContentLoaded',enhance);
})();
