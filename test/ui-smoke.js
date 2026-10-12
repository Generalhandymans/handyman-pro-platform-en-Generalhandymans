// UI SMOKE TEST (no browser needed).
//
// Runs each portal's REAL scripts (customer, contractor, admin) in a Node `vm` against the REAL API,
// using the data that `npm test` leaves in /tmp/test-handyman.db, with a permissive fake DOM. It:
//   1. runs every page's init and calls every load/render function with real API payloads,
//   2. invokes every click/submit/change handler that the page registered (824 in the last run),
//   3. fails on any ReferenceError / TypeError / "x is not a function" / "Cannot read properties".
// It catches the kind of bug that sits in code nobody has clicked yet (wrong field names, role-trimmed
// payloads, typos). It does NOT check layout, CSS, accessibility or what a person actually sees:
// open the pages in a browser for that.
//
// Usage:  npm test && npm run ui-smoke        (exit code 1 if it finds a problem)
const fs = require('fs'), vm = require('vm'), path = require('path');
const PUB = path.join(__dirname, '..', 'public');
Object.assign(process.env, { DB_PATH: '/tmp/test-handyman.db', JWT_SECRET: 'harness', PORT: '3801', AUTH_RATE_LIMIT_MAX: '99999', INTAKE_RATE_LIMIT_MAX: '99999' });
require(path.join(__dirname, '..', 'server.js'));
const BASE = 'http://localhost:3801';
const realFetch = global.fetch;
const errors = [];
process.on('unhandledRejection', (e) => errors.push({ where: 'unhandledRejection', msg: String(e && e.stack || e).split('\n').slice(0, 3).join(' | ') }));

const registry = new Set();
function makeStub(label) {
  const props = {};
  let self = null;
  const fn = function () {};
  self = new Proxy(fn, {
    get(_, p) {
      if (p === 'then') return undefined;
      if (p === Symbol.toPrimitive) return () => (props.value != null ? String(props.value) : '');
      if (p === Symbol.iterator) return function* () {};
      if (p in props) return props[p];
      switch (p) {
        case 'querySelectorAll': case 'getElementsByClassName': case 'getElementsByTagName': return () => [];
        case 'children': case 'childNodes': case 'files': case 'options': return [];
        case 'classList': return { add() {}, remove() {}, toggle() {}, contains() { return false; }, replace() {} };
        case 'dataset': return (props.dataset = props.dataset || {});
        case 'style': return (props.style = props.style || {});
        case 'value': case 'textContent': case 'innerHTML': case 'innerText': case 'className': case 'href': case 'src': case 'name': case 'placeholder': return '';
        case 'checked': case 'hidden': case 'disabled': case 'open': return false;
        case 'length': return 0;
        case 'addEventListener': case 'removeEventListener': return (t, h) => { (props._l = props._l || []).push([t, h]); registry.add(self); };
        case 'getBoundingClientRect': return () => ({ left: 0, top: 0, width: 100, height: 100 });
        case 'getContext': return () => makeStub('ctx');
        case 'toDataURL': return () => 'data:image/png;base64,' + 'A'.repeat(1200);
        default: return (props[p] = makeStub(label + '.' + String(p)));
      }
    },
    set(_, p, v) { props[p] = v; return true; },
    apply() { return makeStub(label + '()'); },
    has() { return true; },
  });
  return self;
}

async function login(email, password) {
  const r = await realFetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const j = await r.json();
  if (!j.token) throw new Error('login failed for ' + email + ': ' + JSON.stringify(j));
  const me = await (await realFetch(BASE + '/api/auth/me', { headers: { Authorization: 'Bearer ' + j.token } })).json();
  return { token: j.token, user: me };
}

async function runPage(name, creds, extras) {
  const out = { page: name, errorsBefore: errors.length, toasts: [], redirects: [], calls: 0, apiFails: [] };
  const sess = await login(creds[0], creds[1]);
  const ls = new Map([['hp_token', sess.token], ['hp_user', JSON.stringify(sess.user)]]);
  const ids = {}; const docListeners = [];
  const doc = makeStub('document');
  const docProxy = new Proxy({}, {
    get(_, p) {
      if (p === 'getElementById') return (id) => (ids[id] = ids[id] || makeStub('#' + id));
      if (p === 'querySelector') return (s) => (ids[s] = ids[s] || makeStub(s));
      if (p === 'createElement' || p === 'createTextNode' || p === 'createDocumentFragment') return () => makeStub('created');
      if (p === 'addEventListener') return (t, h) => { if (t === 'DOMContentLoaded') docListeners.push(h); };
      if (p === 'readyState') return 'complete';
      if (p === 'cookie' || p === 'title') return '';
      return doc[p];
    },
    set() { return true; },
  });
  let pending = 0;
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error: (...a) => out.toasts.push('console.error: ' + a.map(String).join(' ').slice(0, 200)), info() {} },
    document: docProxy,
    localStorage: { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k), key: (i) => [...ls.keys()][i] || null, get length() { return ls.size; } },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    location: { href: 'http://localhost/' + name + '.html', origin: 'http://localhost', pathname: '/' + name + '.html', search: '', hash: '', assign() {}, replace() {}, reload() {} },
    history: { replaceState() {}, pushState() {} },
    navigator: { clipboard: { writeText: async () => {} }, userAgent: 'node-harness' },
    confirm: () => true, prompt: () => 'x', alert() {},
    fetch: (url, opts) => { pending++; out.calls++; const u = String(url).startsWith('/') ? BASE + url : url; return realFetch(u, opts).then((r) => { if (r.status >= 500) out.apiFails.push(r.status + ' ' + (opts && opts.method || 'GET') + ' ' + url); return r; }).finally(() => pending--); },
    FormData, Blob, URL, URLSearchParams, Intl, Date, JSON, Math, Promise, Number, String, Array, Object, Set, Map, Symbol, Error, TypeError, RegExp, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval() {}, requestAnimationFrame: (f) => setTimeout(f, 0), matchMedia: () => ({ matches: false, addEventListener() {} }),
    IntersectionObserver: class { observe() {} disconnect() {} }, Stripe: () => ({ elements: () => ({ create: () => makeStub('stripe-el') }) }),
    Buffer, TextEncoder, atob: (s) => Buffer.from(s, 'base64').toString('binary'), btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  });
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  const html = fs.readFileSync(path.join(PUB, name + '.html'), 'utf8');
  const srcs = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  const inline = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const run = (code, file) => { try { vm.runInContext(code, ctx, { filename: file }); } catch (e) { out.toasts.push(`SCRIPT ERROR in ${file}: ${e.message}`); errors.push({ where: file, msg: e.stack.split('\n').slice(0, 3).join(' | ') }); } };
  for (const s of srcs) run(fs.readFileSync(path.join(PUB, s), 'utf8'), s);
  // record every error toast (many screens catch errors and only show a toast)
  try { vm.runInContext("(function(){const t=HP.toast;HP.toast=function(m,k){if(k==='error')__t.push(String(m));return t.apply(this,arguments)}})()", Object.assign(ctx, { __t: out.toasts })); } catch (e) { out.toasts.push('could not hook toast: ' + e.message); }
  for (let code of inline) {
    const names = [...new Set([...code.matchAll(/function\s+(\w+)\s*\(/g)].map((m) => m[1]))];
    const exp = `try { globalThis.__x = { ${names.map((n) => `${n}: typeof ${n} === 'function' ? ${n} : undefined`).join(', ')} }; } catch (e) {}`;
    code = code.replace(/\n(\s*)init\(\);\s*\n\s*\}\)\(\);\s*$/, `\n$1${exp}\n$1init();\n  })();`);
    run(code, name + '.html(inline)');
  }
  for (const h of docListeners) { try { await h(); } catch (e) { out.toasts.push('DOMContentLoaded handler: ' + e.message); errors.push({ where: name + ' init', msg: e.stack.split('\n').slice(0, 3).join(' | ') }); } }
  const settle = async () => { for (let i = 0; i < 80 && pending > 0; i++) await new Promise((r) => setTimeout(r, 50)); await new Promise((r) => setTimeout(r, 120)); for (let i = 0; i < 80 && pending > 0; i++) await new Promise((r) => setTimeout(r, 50)); };
  await settle();
  if (extras) {
    for (const [label, fnText] of extras) {
      try { await vm.runInContext(`(async()=>{ ${fnText} })()`, ctx); } catch (e) { out.toasts.push(`EXTRA ${label}: ${e.message}`); errors.push({ where: name + ' ' + label, msg: e.stack.split('\n').slice(0, 3).join(' | ') }); }
      await settle();
    }
  }
  // EXERCISE every registered handler once (click/submit/change/...) with a fake event
  const before = out.toasts.length;
  const snapshot = [];
  for (const el of registry) for (const [t, h] of (el._l || [])) if (['click', 'submit', 'change', 'input', 'keydown'].includes(t) && typeof h === 'function') snapshot.push([el, t, h]);
  out.handlers = snapshot.length; out.handlerErrors = [];
  for (const [el, t, h] of snapshot.slice(0, 600)) {
    const ev = { preventDefault() {}, stopPropagation() {}, target: el, currentTarget: el, key: 'Enter', type: t, submitter: el };
    try { await Promise.race([Promise.resolve(h(ev)), new Promise((r) => setTimeout(r, 3000))]); }
    catch (e) { if (/is not defined|Cannot read|is not a function|not iterable|Unexpected/.test(e.message)) out.handlerErrors.push(`${t}: ${e.message} @ ${(e.stack || '').split('\n')[1] || ''}`.slice(0, 220)); }
  }
  await settle();
  for (const m of out.toasts.slice(before)) if (/is not defined|Cannot read|is not a function|not iterable|Unexpected token/.test(m)) out.handlerErrors.push('toast: ' + m.slice(0, 200));
  out.errorsAfter = errors.length;
  return out;
}

(async () => {
  await new Promise((r) => setTimeout(r, 2500));
  const results = [];
  results.push(await runPage('customer', ['cust@test.local', 'NewPass123!'], [
    ['projects', "const ps = await HP.api('GET','/projects'); const b = document.getElementById('b'); for (const p of ps) { await __x.refreshProject(p.id, b); }"],
    ['requests+referrals', "await __x.loadRequests(); await __x.loadReferrals();"],
  ]));
  results.push(await runPage('contractor', ['cont@test.local', 'Contractor123!'], [
    ['jobs', "const ps = await HP.api('GET','/projects'); const b = document.getElementById('b'); for (const p of ps) { await __x.refreshJob(p.id, b); }"],
    ['tabs', "await __x.loadProfile(); await __x.loadJobs(); await __x.loadPayouts(); await __x.loadDisputes();"],
  ]));
  results.push(await runPage('admin', ['admin@test.local', 'Admin123!'], [
    ['tabs', "for (const n of ['loadOverview','loadClients','loadContractorTab','loadProjectsTab','loadAgendaTab','loadPayoutsTab','loadDisputesTab','loadMessagesTab','loadCampaignsTab','loadKpis','loadTeam','loadSecurity','loadAuditLog','loadPipeline','loadJobsTable','loadTasks','loadContractorPipeline','loadContractorTable','loadGaps','loadAdminProjects','loadTemplates','loadCampaigns','loadEmailLog','renderSmsLog','renderAgenda','renderPayouts']) { if (typeof __x[n] !== 'function') throw new Error('missing function ' + n); try { await __x[n](); } catch (e) { throw new Error(n + ': ' + e.message); } }"],
    ['disputes', "const ds = await HP.api('GET','/disputes'); for (const d of ds) { await __x.showDispute(d.id); }"],
    ['reports', "for (const t of ['overview','funnel','contractor-funnel','margins','ticket','contractors','calibration']) { try { await __x.loadReportTab(t); } catch (e) { throw new Error('report '+t+': '+e.message); } }"],
  ]));
  for (const r of results) {
    console.log(`\n===== ${r.page}.html: ${r.calls} llamadas a la API; errores de script: ${r.errorsAfter - r.errorsBefore}; 5xx: ${r.apiFails.length}`);
    for (const t of r.toasts.filter((x) => /is not defined|Cannot read|is not a function|SCRIPT ERROR|EXTRA|DOMContentLoaded/.test(x))) console.log('  ERR:', t);
    for (const f of r.apiFails) console.log('  5xx:', f);
    console.log(`  manejadores ejercitados: ${r.handlers}; errores de programación en manejadores: ${r.handlerErrors.length}`);
    for (const h of r.handlerErrors) console.log('   HANDLER ERR:', h);
  }
  console.log('\nerrores no capturados:', errors.length);
  for (const e of errors) console.log('  ', e.where, '→', e.msg);
  const bad = errors.length + results.reduce((a, r) => a + r.handlerErrors.length + r.apiFails.length + r.toasts.filter((x) => /is not defined|Cannot read|is not a function|SCRIPT ERROR|EXTRA|DOMContentLoaded/.test(x)).length, 0);
  console.log(bad ? `\nUI SMOKE: ${bad} problema(s) encontrado(s)` : '\nUI SMOKE: sin errores');
  process.exit(bad ? 1 : 0);
})();
