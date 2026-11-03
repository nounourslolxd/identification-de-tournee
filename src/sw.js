// Service worker : application hors ligne.
// Les constantes VERSION et SHELL ci-dessous sont remplacées par scripts/build.mjs.
const VERSION = '__VERSION__';
const SHELL = __SHELL__;
const CORE = 'shell-' + VERSION;
const VENDOR = 'vendor-v1'; // Tesseract (wasm, langue) : volumineux, conservé entre les versions

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CORE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CORE && k !== VENDOR) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return; // Supabase & co : réseau direct

  // Gros fichiers auto-hébergés : cache d'abord, rempli à la première utilisation (voir ocr.warmup()).
  if (url.pathname.includes('/vendor/')) {
    e.respondWith(caches.open(VENDOR).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }

  // Coquille de l'application : cache d'abord, rafraîchi en arrière-plan.
  e.respondWith(caches.open(CORE).then(async c => {
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    return (await net) || (req.mode === 'navigate' ? c.match('index.html') : Response.error());
  }));
});
