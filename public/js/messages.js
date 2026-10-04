// Handyman Pro — shared mediated-messaging UI.
// Business rule: NO direct client<->contractor contact. Two thread kinds:
//   client_support      (customer <-> support)
//   support_contractor  (support <-> contractor)
// This component only ever shows the thread kind the current role may use;
// the server enforces the same matrix on every endpoint.
//
// Usage: HP.mountMessages(container, { fetchProjects, allowKindSwitch })
const HPMsg = (() => {
  const KIND_LABEL = {
    client_support: 'Customer support',
    support_contractor: 'Contractor support',
  };

  function mountMessages(container, opts) {
    const o = Object.assign({ fetchProjects: async () => [], allowKindSwitch: false }, opts || {});
    container.innerHTML = `
      <div class="msg-wrap">
        <div class="form-grid two">
          <div class="field">
            <label for="msg-proj-${uid()}">Project</label>
            <select id="msg-proj" class="msg-proj"><option value="">Loading projects…</option></select>
          </div>
          <div class="field msg-kind-field" hidden>
            <label for="msg-kind">Conversation</label>
            <select id="msg-kind" class="msg-kind">
              <option value="client_support">Customer support</option>
              <option value="support_contractor">Contractor support</option>
            </select>
          </div>
        </div>
        <div class="msg-notice small muted"></div>
        <div class="msg-list" role="log" aria-label="Messages" aria-live="polite"><p class="muted">Select a project to view messages.</p></div>
        <form class="msg-composer" novalidate>
          <div class="field">
            <label for="msg-body">Write a message</label>
            <textarea id="msg-body" class="msg-body" rows="3" maxlength="2000"
              placeholder="Type your message… (max 2000 characters)" disabled></textarea>
            <span class="field-error" data-error-for="body"></span>
          </div>
          <button class="btn btn-primary btn-sm" type="submit" disabled>Send</button>
        </form>
      </div>`;

    const sel = container.querySelector('.msg-proj');
    const kindSel = container.querySelector('.msg-kind');
    const kindField = container.querySelector('.msg-kind-field');
    const notice = container.querySelector('.msg-notice');
    const list = container.querySelector('.msg-list');
    const form = container.querySelector('.msg-composer');
    const body = container.querySelector('.msg-body');
    const sendBtn = form.querySelector('button[type="submit"]');
    if (o.allowKindSwitch) kindField.hidden = false;

    let threadId = null;
    let timer = null;

    function setNotice(kind) {
      notice.textContent = kind === 'client_support'
        ? 'You are chatting with Handyman Pro support. Your contractor never sees this conversation.'
        : kind === 'support_contractor'
          ? 'You are chatting with Handyman Pro support about this project. The customer never sees this conversation.'
          : '';
    }

    async function loadProjects() {
      try {
        const projects = await o.fetchProjects();
        if (!projects.length) {
          sel.innerHTML = '<option value="">No projects yet</option>';
          return;
        }
        sel.innerHTML = projects.map((p) =>
          `<option value="${p.id}">#${p.id} — ${HP.esc(p.label || '')}</option>`).join('');
        openThread();
      } catch (e) {
        sel.innerHTML = '<option value="">Could not load projects</option>';
      }
    }

    async function openThread() {
      const pid = sel.value;
      clearInterval(timer); timer = null;
      threadId = null;
      if (!pid) {
        list.innerHTML = '<p class="muted">Select a project to view messages.</p>';
        body.disabled = true; sendBtn.disabled = true;
        return;
      }
      list.innerHTML = '<p class="muted">Loading messages…</p>';
      try {
        const kind = o.allowKindSwitch ? kindSel.value : undefined;
        const t = await HP.api('POST', `/projects/${pid}/threads`, kind ? { kind } : {});
        threadId = t.id;
        setNotice(t.kind);
        if (o.allowKindSwitch) kindSel.value = t.kind;
        await refresh();
        body.disabled = false; sendBtn.disabled = false;
        timer = setInterval(refresh, 15000);
      } catch (e) {
        list.innerHTML = `<div class="banner banner-warn">Could not open messages: ${HP.esc(HP.friendlyMessage(e))}</div>`;
      }
    }

    async function refresh() {
      if (!threadId) return;
      try {
        const msgs = await HP.api('GET', `/threads/${threadId}/messages`);
        if (!msgs.length) {
          list.innerHTML = '<p class="muted">No messages yet. Say hello — support replies here.</p>';
          return;
        }
        const me = HP.user();
        list.innerHTML = msgs.map((m) => {
          const mine = me && m.sender_role !== 'admin' && (
            (me.role === 'customer' && m.sender_role === 'customer') ||
            (me.role === 'contractor' && m.sender_role === 'contractor'));
          const who = m.sender_role === 'admin' ? 'Handyman Pro support'
            : m.sender_role === 'customer' ? 'Customer' : 'Contractor';
          return `<div class="msg ${mine ? 'msg-mine' : 'msg-theirs'}">
            <div class="msg-meta"><strong>${HP.esc(m.sender_name || who)}</strong> · <span>${HP.fmtDateTime(m.created_at)}</span></div>
            <div class="msg-text">${HP.esc(m.body)}</div>
          </div>`;
        }).join('');
        list.scrollTop = list.scrollHeight;
      } catch (e) { /* keep old messages on transient errors */ }
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!threadId || !body.value.trim()) return;
      HP.clearFieldErrors(form);
      HP.busy(sendBtn, true, 'Sending…');
      try {
        await HP.api('POST', `/threads/${threadId}/messages`, { body: body.value.trim() });
        body.value = '';
        await refresh();
      } catch (err) {
        HP.handleFormError(form, err);
      } finally {
        HP.busy(sendBtn, false);
      }
    });

    sel.addEventListener('change', openThread);
    kindSel.addEventListener('change', openThread);
    // expose a cleanup for SPA-ish reuse
    container._msgCleanup = () => clearInterval(timer);

    loadProjects();
  }

  let _uid = 0;
  function uid() { return ++_uid; }

  return { mountMessages };
})();
