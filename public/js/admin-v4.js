// HELPMAN Phase 4 — Operations Control Center
(function(){
  'use strict';

  function addOpsTabs(){
    const tabs=document.getElementById('admin-tabs');
    if(!tabs || document.querySelector('[data-tab="ops-center"]')) return;
    const defs=[['ops-center','Control Center'],['dispatch-v4','Dispatch'],['risks-v4','Risks']];
    defs.reverse().forEach(([key,label])=>{
      const b=document.createElement('button'); b.className='tab'; b.dataset.tab=key; b.setAttribute('role','tab'); b.textContent=label;
      tabs.insertBefore(b,tabs.firstChild);
      const s=document.createElement('section'); s.className='tab-panel'; s.id='panel-'+key; s.setAttribute('role','tabpanel');
      s.innerHTML=`<div id="hm4-${key}"><p class="muted">Loading…</p></div>`;
      tabs.parentNode.insertBefore(s,tabs.nextElementSibling);
    });

    document.querySelectorAll('#admin-tabs .tab').forEach(t=>{
      t.addEventListener('click',()=>{
        if(t.dataset.tab==='ops-center') loadControlCenter();
        if(t.dataset.tab==='dispatch-v4') loadDispatch();
        if(t.dataset.tab==='risks-v4') loadRisks();
      });
    });
    document.querySelector('[data-tab="ops-center"]').click();
  }

  const priKind=p=>p==='critical'?'warn':p==='high'?'warn':p==='medium'?'info':'muted';

  async function loadControlCenter(){
    const box=document.getElementById('hm4-ops-center'); if(!box)return;
    try{
      await HP.api('POST','/operations/generate',{}).catch(()=>({}));
      const [d,a]=await Promise.all([
        HP.api('GET','/operations/control-center'),
        HP.api('GET','/operations/analytics')
      ]);
      const k=d.kpis;
      box.innerHTML=`
        <div class="hm4-title-row"><div><span class="eyebrow">HELPMAN OPERATIONS</span><h2>What needs attention now</h2><p>One queue for sales, dispatch, project execution, customer approvals, payments and compliance.</p></div>
          <button class="btn btn-outline" id="hm4-refresh">Refresh</button></div>
        <div class="hm4-kpis">
          ${[
            ['Critical',k.critical_tasks],['New leads',k.new_leads],['Quotes waiting',k.quotes_waiting],
            ['Needs dispatch',k.unassigned_projects],['Active projects',k.active_projects],
            ['Approvals',k.customer_approvals],['Failed payments',k.failed_payments],['Open tasks',k.open_tasks]
          ].map(([l,v])=>`<div><span>${l}</span><strong>${v}</strong></div>`).join('')}
        </div>
        <div class="hm4-grid">
          <section class="card"><div class="section-head"><h3>Priority queue</h3><button class="btn btn-dark btn-sm" id="hm4-new-task">New task</button></div>
            <div id="hm4-queue">${d.queue.length?d.queue.map(taskRow).join(''):'<p class="muted">Queue is clear.</p>'}</div>
          </section>
          <section class="card"><h3>Business pulse</h3>
            <div class="hm4-economics">
              <div><span>Revenue</span><strong>${HP.fmtMoney(a.economics.revenue_cents)}</strong></div>
              <div><span>Gross profit</span><strong>${HP.fmtMoney(a.economics.gross_profit_cents)}</strong></div>
              <div><span>Gross margin</span><strong>${a.economics.gross_margin_pct}%</strong></div>
              <div><span>Completed</span><strong>${a.economics.completed_projects}</strong></div>
            </div>
            <h4>Acquisition</h4>
            ${a.acquisition.length?a.acquisition.map(x=>`<div class="hm4-bar-row"><span>${HP.esc(x.source)}</span><div><i style="width:${Math.min(100,x.conversion_pct)}%"></i></div><b>${x.conversion_pct}%</b><small>${x.converted}/${x.leads}</small></div>`).join(''):'<p class="muted">No source data yet.</p>'}
          </section>
        </div>`;
      document.getElementById('hm4-refresh').onclick=loadControlCenter;
      document.getElementById('hm4-new-task').onclick=createManualTask;
      wireTasks(box);
    }catch(e){box.innerHTML=`<div class="banner banner-warn">${HP.esc(HP.friendlyMessage(e))}</div>`;}
  }

  function taskRow(t){
    return `<div class="hm4-task" data-task="${t.id}">
      <div><div class="hm4-task-title">${HP.badge(t.priority,priKind(t.priority))} <strong>${HP.esc(t.title)}</strong></div>
        <small>${HP.esc(t.detail||'')}${t.assignee_name?' · '+HP.esc(t.assignee_name):''}</small></div>
      <div class="hm4-actions">
        <button class="btn btn-outline btn-sm" data-task-status="in_progress">Start</button>
        <button class="btn btn-ok btn-sm" data-task-status="done">Done</button>
      </div></div>`;
  }

  function wireTasks(box){
    box.querySelectorAll('[data-task-status]').forEach(b=>b.onclick=async()=>{
      const row=b.closest('[data-task]');
      await HP.api('PATCH','/operations/tasks/'+row.dataset.task,{status:b.dataset.taskStatus});
      HP.toast('Task updated.','ok'); loadControlCenter();
    });
  }

  async function createManualTask(){
    const title=prompt('Task title:'); if(!title)return;
    const detail=prompt('Details (optional):')||'';
    await HP.api('POST','/operations/tasks',{title,detail,priority:'medium'});
    HP.toast('Task created.','ok'); loadControlCenter();
  }

  async function loadDispatch(){
    const box=document.getElementById('hm4-dispatch-v4'); if(!box)return;
    try{
      const rows=await HP.api('GET','/operations/dispatch');
      box.innerHTML=`<div class="hm4-title-row"><div><span class="eyebrow">DISPATCH</span><h2>Project assignment board</h2><p>Unassigned and urgent work appears first. Recommendations remain explainable and compliance-gated.</p></div></div>
      <div class="hm4-dispatch-list">${rows.length?rows.map(p=>`
        <article class="card hm4-dispatch-card">
          <div class="section-head"><div><strong>Project #${p.id}</strong><div class="small muted">${HP.esc(p.service_type)} · ${HP.esc([p.city,p.state,p.zip].filter(Boolean).join(' '))}</div></div>
            ${HP.badge(p.contractor_id?'Assigned':'Needs contractor',p.contractor_id?'ok':'warn')}</div>
          <div class="small">${HP.esc(p.description||'')}</div>
          <div class="hm4-dispatch-meta"><span>Stage: ${HP.esc(p.stage)}</span><span>Urgency: ${HP.esc(p.urgency)}</span><span>${p.contractor_name?HP.esc(p.contractor_name):'No contractor'}</span></div>
          <button class="btn btn-primary btn-sm" data-rec="${p.id}">Find best match</button>
          <div class="hm4-rec" id="hm4-rec-${p.id}"></div>
        </article>`).join(''):'<p class="muted">No active projects.</p>'}</div>`;
      box.querySelectorAll('[data-rec]').forEach(b=>b.onclick=()=>loadRecommendations(b.dataset.rec));
    }catch(e){box.innerHTML=`<div class="banner banner-warn">${HP.esc(HP.friendlyMessage(e))}</div>`;}
  }

  async function loadRecommendations(pid){
    const out=document.getElementById('hm4-rec-'+pid);
    out.innerHTML='<p class="muted">Ranking available professionals…</p>';
    try{
      const rows=await HP.api('GET',`/operations/projects/${pid}/recommendations`);
      if(!rows.length){out.innerHTML='<p class="muted">No fully compliant eligible professionals found.</p>';return;}
      out.innerHTML=rows.slice(0,5).map(x=>{
        const c=x.contractor,m=x.match;
        return `<div class="hm4-rec-row"><div><strong>${HP.esc(c.legal_name)}</strong><small>Match ${m.score} · rating ${Number(c.rating_avg||0).toFixed(1)} · workload ${c.current_workload||0}</small></div>
          <button class="btn btn-outline btn-sm" data-dispatch="${c.id}" data-score="${m.score}">Offer job</button></div>`;
      }).join('');
      out.querySelectorAll('[data-dispatch]').forEach(b=>b.onclick=async()=>{
        if(!confirm('Offer this project to the selected professional?'))return;
        await HP.api('POST',`/operations/projects/${pid}/dispatch/${b.dataset.dispatch}`,{match_score:Number(b.dataset.score)});
        HP.toast('Job offered.','ok'); loadDispatch();
      });
    }catch(e){out.innerHTML=`<p class="muted">${HP.esc(HP.friendlyMessage(e))}</p>`;}
  }

  async function loadRisks(){
    const box=document.getElementById('hm4-risks-v4'); if(!box)return;
    try{
      const rows=await HP.api('GET','/operations/risks');
      box.innerHTML=`<div class="hm4-title-row"><div><span class="eyebrow">RISK CENTER</span><h2>Exceptions and operational risk</h2><p>Failed payments, unassigned projects, customer approvals and compliance expirations.</p></div></div>
        <div class="hm4-risk-grid">${rows.length?rows.map(x=>`
          <article class="card hm4-risk ${x.severity}">
            <span class="eyebrow">${HP.esc(x.severity)}</span><h3>${HP.esc(x.title)}</h3><p>${HP.esc(x.detail||'')}</p>
          </article>`).join(''):'<div class="card"><strong>No current exceptions.</strong><p class="muted">The risk center is clear.</p></div>'}</div>`;
    }catch(e){box.innerHTML=`<div class="banner banner-warn">${HP.esc(HP.friendlyMessage(e))}</div>`;}
  }

  document.addEventListener('DOMContentLoaded',addOpsTabs);
})();
