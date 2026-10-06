// HELPMAN Phase 6 — Growth & Launch dashboard
(function(){
  'use strict';
  function addTab(){
    const tabs=document.getElementById('admin-tabs');
    if(!tabs||document.querySelector('[data-tab="growth-v6"]'))return;
    const b=document.createElement('button');b.className='tab';b.dataset.tab='growth-v6';b.setAttribute('role','tab');b.textContent='Growth';
    tabs.appendChild(b);
    const s=document.createElement('section');s.className='tab-panel';s.id='panel-growth-v6';s.setAttribute('role','tabpanel');
    s.innerHTML='<div id="hm6-growth"><p class="muted">Loading growth dashboard…</p></div>';
    tabs.parentNode.insertBefore(s,tabs.nextElementSibling);
    b.addEventListener('click',loadGrowth);
  }
  async function loadGrowth(){
    const box=document.getElementById('hm6-growth');if(!box)return;
    try{
      const [g,r]=await Promise.all([
        HP.api('GET','/growth/admin/growth'),
        HP.api('GET','/health/ready').catch(()=>({ok:false,checks:{}}))
      ]);
      box.innerHTML=`
        <div class="hm6-head"><span class="eyebrow">GROWTH & LAUNCH</span><h2>Acquisition, reputation and production readiness</h2></div>
        <div class="hm6-kpis">
          <div><span>Avg rating</span><strong>${g.reviews.avg_rating.toFixed(1)}</strong></div>
          <div><span>Reviews</span><strong>${g.reviews.total}</strong></div>
          <div><span>Referrals</span><strong>${g.referrals.total}</strong></div>
          <div><span>Referral redemption</span><strong>${g.referrals.redemption_pct}%</strong></div>
          <div><span>Production ready</span><strong>${r.ok?'YES':'NO'}</strong></div>
        </div>
        <div class="hm6-grid">
          <section class="card"><h3>Acquisition by source</h3>
            ${g.acquisition.length?g.acquisition.map(x=>`<div class="hm6-source"><span>${HP.esc(x.source)}</span><div><i style="width:${Math.min(100,x.conversion_pct)}%"></i></div><strong>${x.conversion_pct}%</strong><small>${x.converted}/${x.leads}</small></div>`).join(''):'<p class="muted">No acquisition data yet.</p>'}
          </section>
          <section class="card"><h3>Readiness checks</h3>
            ${Object.entries(r.checks||{}).map(([k,v])=>`<div class="hm6-check"><span>${v.ok?'✓':'×'}</span><div><strong>${HP.esc(k.replaceAll('_',' '))}</strong><small>${HP.esc(v.provider||v.detail||'')}</small></div></div>`).join('')}
          </section>
        </div>`;
    }catch(e){box.innerHTML=`<div class="banner banner-warn">${HP.esc(HP.friendlyMessage(e))}</div>`;}
  }
  document.addEventListener('DOMContentLoaded',addTab);
})();
