const CACHE='helpman-shell-v1';
const SHELL=['/','/index.html','/css/styles.css','/css/helpman-v2.css','/js/api.js'];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL).catch(()=>{})));
  self.skipWaiting();
});

self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});

// Conservative cache policy:
// - GET static same-origin assets: cache-first.
// - API/auth/payment/project data: network only.
self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET') return;
  const url=new URL(req.url);
  if(url.origin!==self.location.origin) return;
  if(url.pathname.startsWith('/api/')) return;
  event.respondWith(
    caches.match(req).then(hit=>hit || fetch(req).then(res=>{
      if(res.ok && ['style','script','image','font','document'].includes(req.destination)){
        const clone=res.clone(); caches.open(CACHE).then(c=>c.put(req,clone)).catch(()=>{});
      }
      return res;
    }))
  );
});
