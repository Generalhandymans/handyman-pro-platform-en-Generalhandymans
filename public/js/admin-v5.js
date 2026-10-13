// HELPMAN Phase 5 — AI & Trust Center
(function(){
  'use strict';

  function addTabs(){
    const tabs=document.getElementById('admin-tabs');
    if(!tabs || document.querySelector('[data-tab="intelligence-v5"]')) return;
    const defs=[['intelligence-v5','Intelligence'],['security-v5','Security']];
    defs.reverse().forEach(([key,label])=>{
      const b=document.createElement('button');b.className='tab';b.dataset.tab=key;b.setAttribute('role','tab');b.textContent=label;
      tabs.insertBefore(b,tabs.firstChild);
      const s=document.createElement('section');s.className='tab-panel';s.id='panel-'+key;s.setAttribute('role','tabpanel');
      s.innerHTML=`<div id="hm5-${key}"><p class="muted">Loading…</p></div>`;
      tabs.parentNode.insertBefore(s,tabs.nextElementSibling);
    });
    document.querySelectorAll('#admin-tabs .tab').forEach(t=>t.addEventListener('click',()=>{
      if(t.dataset.tab==='intelligence-v5') loadIntelligence();
      if(t.dataset.tab==='security-v5') loadSecurity();
    }));
  }

  async function loadIntelligence(){
    const box=document.getElementById('hm5-intelligence-v5');if(!box)return;
    try{
      const runs=await HP.api('GET','/intelligence/admin/runs?limit=100');
      const by={};runs.forEach(r=>{by[r.kind]=(by[r.kind]||0)+1});
      const fallback=runs.filter(r=>r.status==='fallback').length;
      const avg=runs.filter(r=>r.confidence!=null).length
        ?Math.round(runs.filter(r=>r.confidence!=null).reduce((a,b)=>a+Number(b.confidence||0),0)/runs.filter(r=>r.confidence!=null).length):0;
      box.innerHTML=`
        <div class="hm5-hero"><div><span class="eyebrow">HELPMAN INTELLIGENCE</span><h2>AI that understands the project — with guardrails</h2>
          <p>Scope, photo signals, risk and confidence are logged and reviewable. AI assists; deterministic systems and humans control pricing, compliance and dispatch.</p></div>
          <div class="hm5-ai-badge">AI<br><small>with controls</small></div></div>
        <div class="hm5-kpis">
          <div><span>Recent AI runs</span><strong>${runs.length}</strong></div>
          <div><span>Average confidence</span><strong>${avg}%</strong></div>
          <div><span>Fallback runs</span><strong>${fallback}</strong></div>
          <div><span>Run types</span><strong>${Object.keys(by).length}</strong></div>
        </div>
        <div class="card"><h3>Recent intelligence activity</h3>
          ${runs.length?`<div class="table-scroll"><table><thead><tr><th>When</th><th>Kind</th><th>Provider</th><th>Status</th><th>Confidence</th><th>Job</th><th>Latency</th></tr></thead><tbody>
          ${runs.map(r=>`<tr><td>${HP.fmtDateTime(r.created_at)}</td><td>${HP.esc(r.kind)}</td><td>${HP.esc(r.provider)}</td><td>${HP.badge(r.status,r.status==='completed'?'ok':r.status==='fallback'?'warn':'muted')}</td><td>${r.confidence==null?'—':r.confidence+'%'}</td><td>${r.job_request_id?'#'+r.job_request_id:'—'}</td><td>${r.duration_ms==null?'—':r.duration_ms+' ms'}</td></tr>`).join('')}
          </tbody></table></div>`:'<p class="muted">No AI runs recorded yet.</p>'}
        </div>`;
    }catch(e){box.innerHTML=`<div class="banner banner-warn">${HP.esc(HP.friendlyMessage(e))}</div>`;}
  }

  async function loadSecurity(){
    const box=document.getElementById('hm5-security-v5');if(!box)return;
    try{
      const rows=await HP.api('GET','/intelligence/admin/security-events?limit=150');
      const crit=rows.filter(x=>x.severity==='critical').length;
      const warn=rows.filter(x=>x.severity==='warning').length;
      box.innerHTML=`
        <div class="hm5-title"><span class="eyebrow">TRUST & SECURITY</span><h2>Security event center</h2>
          <p>Authentication, suspicious behavior and sensitive security actions should become observable rather than disappearing into logs.</p></div>
        <div class="hm5-kpis"><div><span>Recent events</span><strong>${rows.length}</strong></div><div><span>Critical</span><strong>${crit}</strong></div><div><span>Warnings</span><strong>${warn}</strong></div></div>
        <div class="card"><h3>Events</h3>
          ${rows.length?rows.map(x=>`<div class="hm5-event ${x.severity}"><div><strong>${HP.esc(x.event_type)}</strong><small>${HP.fmtDateTime(x.created_at)} · ${HP.esc(x.ip_prefix||'')}</small></div><span>${HP.esc(x.severity)}</span></div>`).join(''):'<p class="muted">No recorded security events yet.</p>'}
        </div>`;
    }catch(e){box.innerHTML=`<div class="banner banner-warn">${HP.esc(HP.friendlyMessage(e))}</div>`;}
  }

  document.addEventListener('DOMContentLoaded',addTabs);
})();
