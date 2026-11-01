/* Sinapse CRM service worker: app shell cache and offline read of assigned work (UE-01.5). */
const SHELL = 'sinapse-shell-v1';
const DATA = 'sinapse-data-v1';
const OFFLINE_API = [/\/api\/v1\/queries\?/, /\/api\/v1\/queries\/[0-9a-f-]{36}$/, /\/api\/v1\/me$/, /\/api\/v1\/admin\/reference$/];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/index.html', '/icon.svg', '/manifest.webmanifest'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) {
    if (!OFFLINE_API.some((r) => r.test(url.pathname + url.search))) return;
    // network first; fall back to the last copy so assigned work can be read offline
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(DATA).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((r) => r || new Response(JSON.stringify({ error: 'Offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } }))));
    return;
  }
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/index.html')));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok && url.origin === location.origin) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); }
    return res;
  })));
});
