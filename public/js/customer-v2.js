// HELPMAN Phase 2 — customer command center enhancements.
(function () {
  'use strict';

  function money(cents) { return HP.fmtMoney(Number(cents || 0)); }

  function addOverviewTab() {
    const tabs = document.getElementById('portal-tabs');
    if (!tabs || document.querySelector('[data-tab="overview"]')) return;

    const btn = document.createElement('button');
    btn.className = 'tab';
    btn.dataset.tab = 'overview';
    btn.setAttribute('role','tab');
    btn.textContent = 'Overview';
    tabs.insertBefore(btn, tabs.firstChild);

    const panel = document.createElement('section');
    panel.className = 'tab-panel';
    panel.id = 'panel-overview';
    panel.setAttribute('role','tabpanel');
    panel.innerHTML = '<div id="hm-command-center"><p class="muted">Loading your Helpman command center…</p></div>';
    tabs.parentNode.insertBefore(panel, tabs.nextElementSibling);

    btn.addEventListener('click', () => {
      document.querySelectorAll('#portal-tabs .tab').forEach(x => x.classList.toggle('active', x === btn));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-overview'));
      loadCommandCenter();
    });

    // Make Overview the first view.
    btn.click();
  }

  async function loadCommandCenter() {
    const box = document.getElementById('hm-command-center');
    if (!box) return;
    try {
      const [jobs, projects] = await Promise.all([
        HP.api('GET','/jobs/mine/list'),
        HP.api('GET','/projects')
      ]);

      const active = projects.filter(p => !['completed','cancelled'].includes(p.stage));
      const completed = projects.filter(p => p.stage === 'completed');
      const actionMilestones = active.flatMap(p => (p.milestones || []).filter(m => m.status === 'completed' && m.customer_approval === 'pending').map(m => ({p,m})));

      box.innerHTML = `
        <div class="hm-cc-stats">
          <div class="hm-cc-stat"><span>Active projects</span><strong>${active.length}</strong></div>
          <div class="hm-cc-stat"><span>Needs approval</span><strong>${actionMilestones.length}</strong></div>
          <div class="hm-cc-stat"><span>Completed</span><strong>${completed.length}</strong></div>
          <div class="hm-cc-stat"><span>Requests</span><strong>${jobs.length}</strong></div>
        </div>
        <div class="hm-cc-grid">
          <section class="card"><h2>What needs your attention</h2><div id="hm-actions"></div></section>
          <section class="card"><h2>Active projects</h2><div id="hm-active-projects"></div></section>
        </div>`;

      const actions = document.getElementById('hm-actions');
      if (!actionMilestones.length) actions.innerHTML = '<p class="muted">Nothing needs your approval right now.</p>';
      else actions.innerHTML = actionMilestones.map(({p,m}) =>
        `<div class="hm-action-row"><div><strong>${HP.esc(m.title)}</strong><div class="small muted">Project #${p.id}</div></div><button class="btn btn-primary btn-sm" data-open-project="${p.id}">Review</button></div>`
      ).join('');

      const list = document.getElementById('hm-active-projects');
      if (!active.length) list.innerHTML = '<p class="muted">No active projects.</p>';
      else list.innerHTML = active.map(p => `
        <button class="hm-project-summary" data-project-id="${p.id}">
          <span><strong>Project #${p.id}</strong><small>${HP.PROJECT_STAGE[p.stage] || p.stage}</small></span>
          <span>${money(p.customer_price_cents)} →</span>
        </button>`).join('');

      box.querySelectorAll('[data-project-id],[data-open-project]').forEach(el => el.addEventListener('click', () => {
        document.querySelector('#portal-tabs .tab[data-tab="projects"]').click();
      }));
    } catch (e) {
      box.innerHTML = `<div class="banner banner-warn">${HP.esc(HP.friendlyMessage(e))}</div>`;
    }
  }

  async function enhanceProjectCards() {
    const container = document.getElementById('projects-list');
    if (!container) return;
    const observer = new MutationObserver(() => {
      container.querySelectorAll('.proj-card').forEach(card => {
        if (card.dataset.hm2) return;
        card.dataset.hm2 = '1';
        const btn = card.querySelector('.proj-head button');
        if (!btn) return;
        btn.addEventListener('click', () => setTimeout(() => mountExtras(card), 80));
      });
    });
    observer.observe(container, {childList:true,subtree:true});
  }

  async function mountExtras(card) {
    if (card.querySelector('.hm-phase2-extras')) return;
    const txt = card.textContent || '';
    const m = txt.match(/Project\s*#(\d+)/i) || txt.match(/#(\d+)/);
    if (!m) return;
    const projectId = m[1];
    const body = card.querySelector('.proj-body');
    if (!body) return;

    const wrap = document.createElement('div');
    wrap.className = 'hm-phase2-extras';
    wrap.innerHTML = `
      <hr class="divider">
      <div class="hm-project-tools">
        <button class="btn btn-outline btn-sm" data-hm-schedule>Scheduling preferences</button>
        <button class="btn btn-outline btn-sm" data-hm-changes>Change orders</button>
        <button class="btn btn-outline btn-sm" data-hm-timeline>Project timeline</button>
      </div>
      <div class="hm-project-tool-output"></div>`;
    body.appendChild(wrap);

    wrap.querySelector('[data-hm-schedule]').onclick = () => renderSchedule(projectId, wrap);
    wrap.querySelector('[data-hm-changes]').onclick = () => renderChanges(projectId, wrap);
    wrap.querySelector('[data-hm-timeline]').onclick = () => renderTimeline(projectId, wrap);
  }

  async function renderSchedule(id, wrap) {
    const out = wrap.querySelector('.hm-project-tool-output');
    out.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const s = await HP.api('GET',`/customer-experience/projects/${id}/schedule-preference`);
      out.innerHTML = `
        <form class="hm-schedule-form">
          <h4>Scheduling preferences</h4>
          <div class="form-grid two">
            <div class="field"><label>Preferred date</label><input type="date" name="preferred_date" value="${HP.esc(s.preferred_date || '')}"></div>
            <div class="field"><label>Time window</label><select name="time_window">
              ${['morning','afternoon','evening','anytime'].map(x=>`<option value="${x}" ${s.time_window===x?'selected':''}>${x.replace('_',' ')}</option>`).join('')}
            </select></div>
          </div>
          <div class="field"><label>Flexibility</label><select name="flexibility">
            ${[['exact','Exact date'],['plus_minus_1','± 1 day'],['plus_minus_3','± 3 days'],['flexible','Flexible']].map(([v,l])=>`<option value="${v}" ${s.flexibility===v?'selected':''}>${l}</option>`).join('')}
          </select></div>
          <div class="field"><label>Notes</label><textarea name="notes" maxlength="500">${HP.esc(s.notes || '')}</textarea></div>
          <button class="btn btn-primary btn-sm" type="submit">Save preferences</button>
        </form>`;
      out.querySelector('form').onsubmit = async e => {
        e.preventDefault();
        const f = e.target;
        await HP.api('PUT',`/customer-experience/projects/${id}/schedule-preference`,{
          preferred_date:f.preferred_date.value || null,
          time_window:f.time_window.value,
          flexibility:f.flexibility.value,
          notes:f.notes.value.trim()
        });
        HP.toast('Scheduling preferences saved.','ok');
      };
    } catch(e) { out.innerHTML = `<p class="muted">${HP.esc(HP.friendlyMessage(e))}</p>`; }
  }

  async function renderChanges(id, wrap) {
    const out = wrap.querySelector('.hm-project-tool-output');
    out.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const rows = await HP.api('GET',`/customer-experience/projects/${id}/change-orders`);
      if (!rows.length) { out.innerHTML = '<h4>Change orders</h4><p class="muted">No documented changes for this project.</p>'; return; }
      out.innerHTML = '<h4>Change orders</h4>' + rows.map(c => `
        <div class="hm-change-order">
          <div class="section-head"><strong>${HP.esc(c.title)}</strong>${HP.badge(c.status,c.status==='approved'?'ok':c.status==='sent'?'warn':'muted')}</div>
          <p>${HP.esc(c.description)}</p>
          <div class="small">Price change: <strong>${money(c.price_delta_cents)}</strong> · Schedule: <strong>${Number(c.schedule_delta_days||0)} day(s)</strong></div>
          ${c.status==='sent'?`<div class="btn-row"><button class="btn btn-ok btn-sm" data-co-yes="${c.id}">Approve</button><button class="btn btn-outline btn-sm" data-co-no="${c.id}">Reject</button></div>`:''}
        </div>`).join('');
      out.querySelectorAll('[data-co-yes],[data-co-no]').forEach(b => b.onclick = async () => {
        const cid = b.dataset.coYes || b.dataset.coNo;
        const approved = !!b.dataset.coYes;
        const note = approved ? '' : (prompt('Optional note for the team:') || '');
        await HP.api('POST',`/customer-experience/projects/${id}/change-orders/${cid}/respond`,{approved,note});
        HP.toast(approved?'Change approved.':'Change rejected.','ok');
        renderChanges(id,wrap);
      });
    } catch(e) { out.innerHTML = `<p class="muted">${HP.esc(HP.friendlyMessage(e))}</p>`; }
  }

  async function renderTimeline(id, wrap) {
    const out = wrap.querySelector('.hm-project-tool-output');
    out.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const rows = await HP.api('GET',`/customer-experience/projects/${id}/timeline`);
      out.innerHTML = '<h4>Project timeline</h4>' + (rows.length ? `<div class="hm-timeline">${rows.map(x=>`
        <div class="hm-timeline-row"><span></span><div><strong>${HP.esc(x.title)}</strong><small>${HP.fmtDateTime(x.created_at)}${x.detail?' · '+HP.esc(x.detail):''}</small></div></div>`).join('')}</div>` : '<p class="muted">Project events will appear here.</p>');
    } catch(e) { out.innerHTML = `<p class="muted">${HP.esc(HP.friendlyMessage(e))}</p>`; }
  }

  document.addEventListener('DOMContentLoaded', () => {
    addOverviewTab();
    enhanceProjectCards();
  });
})();
