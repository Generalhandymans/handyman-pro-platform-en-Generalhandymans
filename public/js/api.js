// Helpman — shared frontend helpers.
// One file loaded by every page: auth/session, API client, formatting,
// toasts, form errors, page guard, and the shared site header.

const HP = (() => {
  const TOKEN_KEY = 'hp_token';
  const USER_KEY = 'hp_user';

  // ---------- session ----------
  function token() { return localStorage.getItem(TOKEN_KEY); }
  function user() {
    try { return JSON.parse(localStorage.getItem(USER_KEY)); }
    catch (e) { return null; }
  }
  function setSession(t, u) {
    localStorage.setItem(TOKEN_KEY, t);
    localStorage.setItem(USER_KEY, JSON.stringify(u));
  }
  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  // ---------- api client ----------
  // api(method, path, body) -> parsed JSON on success.
  // Throws {status, message, fields?, body?}. On 401 with a stored token the
  // session is cleared and the visitor is sent to auth.html.
  async function api(method, path, body, opts = {}) {
    const headers = {};
    const t = token();
    if (t) headers['Authorization'] = 'Bearer ' + t;
    let payload;
    if (body instanceof FormData) {
      payload = body; // browser sets the multipart boundary itself
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch('/api' + path, { method, headers, body: payload });
    } catch (e) {
      const err = new Error('We could not reach the server. Check your connection and try again.');
      err.status = 0;
      throw err;
    }
    if (res.status === 401) {
      if (token()) {
        clearSession();
        location.href = 'auth.html?expired=1';
        const err = new Error('Your session expired. Please log in again.');
        err.status = 401;
        throw err;
      }
      const err = new Error('Please log in to continue.');
      err.status = 401;
      throw err;
    }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      // Backend validation shape: 400 { error, fields: {field: msg} }.
      // Be lenient in case the shape varies: also accept `errors`.
      const err = new Error(
        (data && (data.error || data.message)) ||
        'Something went wrong. Please try again.'
      );
      err.status = res.status;
      err.body = data || {};
      err.fields = (data && (data.fields || data.errors)) || null;
      throw err;
    }
    return data;
  }

  // ---------- formatting ----------
  function fmtMoney(cents) {
    if (cents === null || cents === undefined || !Number.isFinite(Number(cents))) return '—';
    return '$' + (Number(cents) / 100).toLocaleString('en-US', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(String(iso).replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(String(iso).replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      ', ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---------- small dom helper ----------
  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  // ---------- toasts ----------
  function toast(msg, type = 'info') {
    let box = document.getElementById('toasts');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toasts';
      box.setAttribute('aria-live', 'polite');
      document.body.appendChild(box);
    }
    const n = el(`<div class="toast toast-${type}">${esc(msg)}</div>`);
    box.appendChild(n);
    setTimeout(() => { n.classList.add('toast-out'); setTimeout(() => n.remove(), 300); }, 4200);
  }

  // ---------- friendly errors ----------
  function friendlyMessage(err) {
    if (!err) return 'Something went wrong. Please try again.';
    if (err.fields) return 'Please review the highlighted fields below.';
    if (err.status === 0) return err.message;
    if (err.status === 400 || err.status === 422) return err.message || 'Some of the information looks off. Please check and try again.';
    if (err.status === 403) return err.message || 'You do not have access to that.';
    if (err.status === 404) return err.message || 'We could not find that record.';
    if (err.status === 409) return err.message || 'That conflicts with something already saved.';
    if (err.status >= 500) return 'Our server hit a snag. Please try again in a moment.';
    return err.message || 'Something went wrong. Please try again.';
  }

  // ---------- field errors ----------
  // Expects the form to contain one [data-error-for="fieldName"] slot per field.
  function clearFieldErrors(form) {
    form.querySelectorAll('[data-error-for]').forEach((s) => { s.textContent = ''; });
    form.querySelectorAll('.field-invalid').forEach((i) => i.classList.remove('field-invalid'));
  }
  function applyFieldErrors(form, fields) {
    clearFieldErrors(form);
    if (!fields) return;
    Object.keys(fields).forEach((name) => {
      const slot = form.querySelector(`[data-error-for="${CSS.escape(name)}"]`);
      if (slot) slot.textContent = fields[name];
      const input = form.querySelector(`[name="${CSS.escape(name)}"]`);
      if (input) input.classList.add('field-invalid');
    });
  }
  function handleFormError(form, err) {
    if (form && err && err.fields) applyFieldErrors(form, err.fields);
    toast(friendlyMessage(err), 'error');
  }

  // ---------- auth guard ----------
  // Verifies the session against the server and (optionally) the role.
  // Returns the current user object or null after redirecting.
  async function requireAuth(role) {
    if (!token()) { location.href = 'auth.html'; return null; }
    let me;
    try {
      me = await api('GET', '/auth/me');
    } catch (e) {
      // 401 with a token is already redirected by api(); just stop here.
      return null;
    }
    if (!me) { location.href = 'auth.html'; return null; }
    setSession(token(), me);
    if (role && me.role !== role) {
      const dest = { customer: 'customer.html', contractor: 'contractor.html', admin: 'admin.html' }[me.role] || 'index.html';
      location.href = dest;
      return null;
    }
    return me;
  }

  // ---------- loading buttons ----------
  function busy(btn, on, label = 'Working…') {
    if (!btn) return;
    if (on) {
      btn.dataset._label = btn.textContent;
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner" aria-hidden="true"></span> ${esc(label)}`;
    } else {
      btn.disabled = false;
      btn.textContent = btn.dataset._label || btn.textContent;
    }
  }

  // ---------- labels ----------
  const JOB_STATUS = {
    new: 'New request', ai_analyzed: 'Estimate ready', quote_sent: 'Quote sent',
    deposit_paid: 'Deposit paid', assigned: 'Assigned', scheduled: 'Scheduled',
    in_progress: 'In progress', review: 'In review', completed: 'Completed',
    lost: 'Lost', cancelled: 'Cancelled',
  };
  const PROJECT_STAGE = {
    assigned: 'Assigned', scheduled: 'Scheduled', in_progress: 'In progress',
    review: 'In review', completed: 'Completed', cancelled: 'Cancelled',
  };
  const TRADE_ICON = {
    painting: '🎨', plumbing: '🔧', electrical: '⚡', bathroom: '🛁',
    kitchen: '🍳', flooring: '🪵', drywall: '🧱', carpentry: '🪚',
    roofing: '🏠', hvac: '❄️', landscaping: '🌳', fencing: '🚧',
    concrete: '🏗️', appliance: '🔌', garage_door: '🚪', pressure_washing: '💦',
    general: '🛠️',
  };
  function badge(text, kind = 'info') {
    return `<span class="badge badge-${kind}">${esc(text)}</span>`;
  }
  function statusKind(s) {
    if (['completed', 'paid', 'accepted'].includes(s)) return 'ok';
    if (['lost', 'cancelled'].includes(s)) return 'muted';
    if (['new', 'pending'].includes(s)) return 'warn';
    if (['failed'].includes(s)) return 'error';
    return 'info';
  }

  // ---------- shared header ----------
  function portalLink(role) {
    if (role === 'customer') return 'customer.html';
    if (role === 'contractor') return 'contractor.html';
    if (role === 'admin') return 'admin.html';
    return 'auth.html';
  }
  function mountHeader(page) {
    const u = user();
    const header = document.getElementById('site-header');
    if (!header) return;
    const links = [
      { href: 'index.html', label: 'Home', id: 'home' },
      { href: 'track.html', label: 'Track a job', id: 'track' },
      { href: 'auth.html?tab=contractor', label: 'Join as a pro', id: 'contractor', cta: true },
    ];
    if (u && u.role) links.push({ href: portalLink(u.role), label: 'My portal', id: 'portal' });
    header.innerHTML = `
      <div class="wrap header-inner">
        <a class="brand" href="index.html" aria-label="Helpman home">
          <img class="helpman-logo" src="img/helpman-logo.svg?v=20261006c" alt="Helpman — Home projects, handled.">
        </a>
        <nav class="main-nav" aria-label="Main">
          ${links.map((l) => `<a href="${l.href}" class="${page === l.id ? 'active' : ''}${l.cta ? ' nav-cta' : ''}">${esc(l.label)}</a>`).join('')}
          ${u ? `<span class="nav-user">Hi, ${esc(u.name.split(' ')[0])}</span><button class="btn btn-ghost btn-sm" id="logout-btn">Log out</button>`
               : `<a href="auth.html" class="${page === 'auth' ? 'active' : ''}">Log in</a>`}
        </nav>
      </div>`;
    const lo = document.getElementById('logout-btn');
    if (lo) lo.addEventListener('click', () => {
      clearSession();
      toast('You have been logged out.');
      location.href = 'index.html';
    });
  }

  // ---------- empty states ----------
  function emptyState(title, text, ctaHtml = '') {
    return `<div class="empty">
      <div class="empty-icon" aria-hidden="true">📋</div>
      <h3>${esc(title)}</h3>
      <p>${esc(text)}</p>
      ${ctaHtml}
    </div>`;
  }

  // ---------- claim tokens (guest wizard) ----------
  function saveClaim(jobId, claim) {
    try { localStorage.setItem('hp_claim_' + jobId, JSON.stringify({ id: jobId, claim })); } catch (e) { /* ignore */ }
  }
  function loadClaim(jobId) {
    try {
      const r = localStorage.getItem('hp_claim_' + jobId);
      return r ? JSON.parse(r).claim : null;
    } catch (e) { return null; }
  }
  function photoUrl(filename) { return '/api/photos/' + encodeURIComponent(filename); }

  return {
    api, token, user, setSession, clearSession,
    fmtMoney, fmtDate, fmtDateTime, esc, el, toast, friendlyMessage,
    clearFieldErrors, applyFieldErrors, handleFormError,
    requireAuth, busy, badge, statusKind,
    JOB_STATUS, PROJECT_STAGE, TRADE_ICON,
    mountHeader, emptyState,
    saveClaim, loadClaim, photoUrl,
  };
})();

// Shared photo tile. Renders an <img> when the API provides a filename,
// otherwise a metadata tile (backend does not expose filenames on reads).
function photoTile(p) {
  const name = HP.esc(p.original_name || 'Photo');
  const meta = `${p.kind || 'photo'} · ${HP.esc(p.mime || '')} · ${HP.fmtDate(p.created_at)}`;
  if (p.filename) {
    return `<figure class="photo-tile">
      <img src="${HP.photoUrl(p.filename)}" alt="${name}" loading="lazy">
      <figcaption>${name}</figcaption>
    </figure>`;
  }
  return `<figure class="photo-tile photo-tile-meta">
      <div class="photo-placeholder" aria-hidden="true">🖼️</div>
      <figcaption><strong>${name}</strong><br><span class="muted">${meta}</span></figcaption>
    </figure>`;
}
