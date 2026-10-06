// HELPMAN Phase 3 — Professional Network workspace.
(function(){
  'use strict';

  const dayNames=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  function addProTabs(){
    const tabs=document.getElementById('portal-tabs');
    if(!tabs || document.querySelector('[data-tab="pro-dashboard"]')) return;

    const defs=[
      ['pro-dashboard','Overview'],
      ['availability','Availability'],
      ['documents','Compliance'],
      ['earnings','Earnings']
    ];
    defs.reverse().forEach(([key,label])=>{
      const b=document.createElement('button');
      b.className='tab'; b.dataset.tab=key; b.setAttribute('role','tab'); b.textContent=label;
      tabs.insertBefore(b,tabs.firstChild);
      const s=document.createElement('section');
      s.className='tab-panel'; s.id='panel-'+key; s.setAttribute('role','tabpanel');
      s.innerHTML=`<div id="hm3-${key}"><p class="muted">Loading…</p></div>`;
      tabs.parentNode.insertBefore(s,tabs.nextElementSibling);
    });

    document.querySelectorAll('#portal-tabs .tab').forEach(t=>{
      t.addEventListener('click',()=>{
        if(t.dataset.tab==='pro-dashboard') loadDashboard();
        if(t.dataset.tab==='availability') loadAvailability();
        if(t.dataset.tab==='documents') loadDocuments();
        if(t.dataset.tab==='earnings') loadEarnings();
      });
    });
    document.querySelector('[data-tab="pro-dashboard"]').click();
  }

  async function loadDashboard(){
    const box=document.getElementById('hm3-pro-dashboard'); if(!box)return;
    try{
      const d=await HP.api('GET','/contractor-ops/dashboard');
      const s=d.professional_score||{};
      box.innerHTML=`
        <div class="hm3-hero">
          <div><span class="eyebrow">Professional workspace</span><h2>Your HELPMAN Professional Score</h2>
            <p>Built from quality, completion, response behavior and compliance — not a hidden AI grade.</p></div>
          <div class="hm3-score"><strong>${s.score||0}</strong><span>/100</span></div>
        </div>
        <div class="hm3-stats">
          <div><span>Ready for matching</span><strong>${d.readiness.ready_for_matching?'Yes':'Not yet'}</strong></div>
          <div><span>Readiness</span><strong>${d.readiness.percent}%</strong></div>
          <div><span>Active jobs</span><strong>${d.jobs.active}</strong></div>
          <div><span>Completed</span><strong>${d.jobs.completed}</strong></div>
          <div><span>Approved payouts</span><strong>${HP.fmtMoney(d.payouts.approved_cents)}</strong></div>
        </div>
        <div class="hm3-grid">
          <section class="card"><h3>Readiness checklist</h3>
            <ul class="checklist">${d.readiness.items.map(x=>`<li><span>${x.ok?'✓':'○'}</span> ${HP.esc(x.label)}</li>`).join('')}</ul>
          </section>
          <section class="card"><h3>Score breakdown</h3>
            ${Object.entries((s.parts||{})).map(([k,v])=>`
              <div class="hm3-score-row"><span>${HP.esc(k.replaceAll('_',' '))}</span><div><i style="width:${Number(v||0)}%"></i></div><strong>${Math.round(v||0)}</strong></div>`).join('')}
          </section>
        </div>
        <section class="card"><div class="section-head"><h3>Skills</h3><button class="btn btn-outline btn-sm" id="hm3-edit-skills">Edit skills</button></div>
          <div class="hm3-chips">${d.skills.length?d.skills.map(x=>`<span>${HP.esc(x.skill_code)} · ${HP.esc(x.proficiency)}</span>`).join(''):'<span class="muted">No structured skills added yet.</span>'}</div>
          <div id="hm3-skills-editor"></div>
        </section>`;
      document.getElementById('hm3-edit-skills').onclick=()=>renderSkillsEditor(d.skills);
    }catch(e){box.innerHTML=`<div class="banner banner-warn">${HP.esc(HP.friendlyMessage(e))}</div>`;}
  }

  function renderSkillsEditor(skills){
    const out=document.getElementById('hm3-skills-editor');
    const initial=(skills||[]).map(x=>x.skill_code).join(', ');
    out.innerHTML=`
      <form id="hm3-skills-form">
        <div class="field"><label>Skills (comma-separated)</label>
          <textarea name="skills" placeholder="painting, drywall, carpentry, tv_mounting">${HP.esc(initial)}</textarea>
          <div class="hint">Use specific service codes. You can refine proficiency later as the network taxonomy grows.</div>
        </div>
        <button class="btn btn-primary btn-sm">Save skills</button>
      </form>`;
    out.querySelector('form').onsubmit=async e=>{
      e.preventDefault();
      const arr=e.target.skills.value.split(',').map(x=>x.trim().toLowerCase()).filter(Boolean)
        .map((skill_code,i)=>({skill_code,proficiency:'experienced',years_experience:0,is_primary:i===0}));
      await HP.api('PUT','/contractor-ops/skills',{skills:arr});
      HP.toast('Skills updated.','ok'); loadDashboard();
    };
  }

  async function loadAvailability(){
    const box=document.getElementById('hm3-availability'); if(!box)return;
    try{
      const d=await HP.api('GET','/contractor-ops/dashboard');
      const byDay=Object.fromEntries(d.availability.map(x=>[x.weekday,x]));
      box.innerHTML=`
        <div class="card"><h2>Weekly availability</h2><p class="muted">Matching uses this schedule to avoid offering work when you are not available.</p>
          <form id="hm3-av-form"><div class="hm3-week">
          ${dayNames.map((name,i)=>{const r=byDay[i]||{};return `
            <div class="hm3-day">
              <label><input type="checkbox" data-av="${i}" ${r.is_available?'checked':''}> ${name}</label>
              <input type="time" data-start="${i}" value="${r.start_time||'08:00'}">
              <input type="time" data-end="${i}" value="${r.end_time||'17:00'}">
            </div>`}).join('')}
          </div><button class="btn btn-primary" type="submit">Save availability</button></form>
        </div>
        <div class="card"><h3>Time off / blackout dates</h3>
          <form id="hm3-blackout-form" class="form-grid two">
            <div class="field"><label>Start</label><input type="date" name="start_date" required></div>
            <div class="field"><label>End</label><input type="date" name="end_date" required></div>
            <div class="field"><label>Reason</label><input name="reason" maxlength="300"></div>
            <div class="field" style="align-self:end"><button class="btn btn-outline">Add time off</button></div>
          </form>
          <div>${d.blackouts.length?d.blackouts.map(x=>`<div class="hm3-list-row"><span>${HP.esc(x.start_date)} → ${HP.esc(x.end_date)} ${x.reason?'· '+HP.esc(x.reason):''}</span><button class="btn btn-outline btn-sm" data-del-bo="${x.id}">Remove</button></div>`).join(''):'<p class="muted">No blackout dates.</p>'}</div>
        </div>`;

      box.querySelector('#hm3-av-form').onsubmit=async e=>{
        e.preventDefault();
        const days=dayNames.map((_,i)=>({
          weekday:i,
          is_available:box.querySelector(`[data-av="${i}"]`).checked,
          start_time:box.querySelector(`[data-start="${i}"]`).value,
          end_time:box.querySelector(`[data-end="${i}"]`).value
        }));
        await HP.api('PUT','/contractor-ops/availability',{days});
        HP.toast('Availability saved.','ok');
      };
      box.querySelector('#hm3-blackout-form').onsubmit=async e=>{
        e.preventDefault(); const f=e.target;
        await HP.api('POST','/contractor-ops/blackouts',{start_date:f.start_date.value,end_date:f.end_date.value,reason:f.reason.value});
        HP.toast('Time off added.','ok'); loadAvailability();
      };
      box.querySelectorAll('[data-del-bo]').forEach(b=>b.onclick=async()=>{
        await HP.api('DELETE','/contractor-ops/blackouts/'+b.dataset.delBo);
        loadAvailability();
      });
    }catch(e){box.innerHTML=`<div class="banner banner-warn">${HP.esc(HP.friendlyMessage(e))}</div>`;}
  }

  async function loadDocuments(){
    const box=document.getElementById('hm3-documents'); if(!box)return;
    try{
      const rows=await HP.api('GET','/contractor-ops/documents');
      box.innerHTML=`
        <div class="card"><h2>Compliance center</h2>
          <p class="muted">Upload current documents. Submission does not mean verified; HELPMAN review status is shown separately.</p>
          <form id="hm3-doc-form">
            <div class="form-grid two">
              <div class="field"><label>Document type</label><select name="doc_type">
                <option value="license">License</option><option value="insurance">Insurance</option>
                <option value="workers_comp">Workers' comp</option><option value="w9">W-9</option>
                <option value="business_registration">Business registration</option>
                <option value="background_consent">Background consent</option><option value="other">Other</option>
              </select></div>
              <div class="field"><label>Expiration date</label><input type="date" name="expires_on"></div>
              <div class="field"><label>Issuer</label><input name="issuer" maxlength="160"></div>
              <div class="field"><label>Document number</label><input name="document_number" maxlength="160"></div>
            </div>
            <div class="field"><label>File</label><input type="file" name="document" accept=".pdf,image/jpeg,image/png,image/webp" required></div>
            <button class="btn btn-primary">Submit for review</button>
          </form>
        </div>
        <div class="card"><h3>Your documents</h3>
          ${rows.length?rows.map(x=>`<div class="hm3-list-row"><div><strong>${HP.esc(x.doc_type.replaceAll('_',' '))}</strong><small>${HP.esc(x.original_name||'')} ${x.expires_on?'· expires '+HP.esc(x.expires_on):''}</small></div>${HP.badge(x.status,x.status==='verified'?'ok':x.status==='rejected'||x.status==='expired'?'warn':'info')}</div>`).join(''):'<p class="muted">No documents submitted.</p>'}
        </div>`;
      box.querySelector('#hm3-doc-form').onsubmit=async e=>{
        e.preventDefault(); const f=e.target, fd=new FormData(f);
        const btn=f.querySelector('button'); HP.busy(btn,true,'Uploading…');
        try{await HP.api('POST','/contractor-ops/documents',fd);HP.toast('Document submitted.','ok');loadDocuments();}
        catch(err){HP.toast(HP.friendlyMessage(err),'error');}
        finally{HP.busy(btn,false);}
      };
    }catch(e){box.innerHTML=`<div class="banner banner-warn">${HP.esc(HP.friendlyMessage(e))}</div>`;}
  }

  async function loadEarnings(){
    const box=document.getElementById('hm3-earnings'); if(!box)return;
    try{
      const d=await HP.api('GET','/contractor-ops/dashboard');
      box.innerHTML=`
        <div class="hm3-stats">
          <div><span>Pending</span><strong>${HP.fmtMoney(d.payouts.pending_cents)}</strong></div>
          <div><span>Approved</span><strong>${HP.fmtMoney(d.payouts.approved_cents)}</strong></div>
          <div><span>Paid</span><strong>${HP.fmtMoney(d.payouts.paid_cents)}</strong></div>
        </div>
        <div class="card"><h2>Payout history</h2>
          ${d.payouts.items.length?d.payouts.items.map(x=>`<div class="hm3-list-row"><div><strong>${HP.fmtMoney(x.payable_cents)}</strong><small>Project #${x.project_id} · ${HP.fmtDate(x.created_at)}</small></div>${HP.badge(x.status,x.status==='paid'?'ok':x.status==='approved'?'info':'muted')}</div>`).join(''):'<p class="muted">No payout records yet.</p>'}
        </div>`;
    }catch(e){box.innerHTML=`<div class="banner banner-warn">${HP.esc(HP.friendlyMessage(e))}</div>`;}
  }

  function enhanceJobDailyLogs(){
    const container=document.getElementById('jobs-list'); if(!container)return;
    const obs=new MutationObserver(()=>{
      container.querySelectorAll('.proj-card').forEach(card=>{
        if(card.dataset.hm3) return; card.dataset.hm3='1';
        const head=card.querySelector('.proj-head button');
        if(!head)return;
        head.addEventListener('click',()=>setTimeout(()=>{
          const body=card.querySelector('.proj-body'); if(!body||body.querySelector('.hm3-daily-log'))return;
          const m=(card.textContent||'').match(/Job #(\d+)/i); if(!m)return;
          const pid=m[1];
          const sec=document.createElement('div'); sec.className='hm3-daily-log';
          sec.innerHTML=`<hr class="divider"><h4>Daily log</h4>
            <form><div class="field"><label>What happened today?</label><textarea name="summary" maxlength="2000" required></textarea></div>
            <div class="form-grid two"><div class="field"><label>Hours worked</label><input type="number" min="0" max="24" step=".25" name="hours_worked"></div>
            <div class="field"><label>Blockers / issues</label><input name="blockers" maxlength="1500"></div></div>
            <label class="small"><input type="checkbox" name="customer_visible"> Share this update with the customer</label>
            <div><button class="btn btn-outline btn-sm">Save daily log</button></div></form>`;
          body.appendChild(sec);
          sec.querySelector('form').onsubmit=async e=>{
            e.preventDefault();const f=e.target;
            await HP.api('POST',`/contractor-ops/projects/${pid}/daily-log`,{
              summary:f.summary.value,hours_worked:f.hours_worked.value||null,blockers:f.blockers.value,
              customer_visible:f.customer_visible.checked
            });
            HP.toast('Daily log saved.','ok'); f.reset();
          };
        },100));
      });
    });
    obs.observe(container,{childList:true,subtree:true});
  }

  document.addEventListener('DOMContentLoaded',()=>{addProTabs();enhanceJobDailyLogs();});
})();
