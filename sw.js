const CACHE = 'water-billing-6a6504ce';

const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css?v=bdfe032b',
  './js/app.js?v=d2e16d9b',
  './js/billing.js?v=1ca74bc0',
  './js/db.js?v=df952e74',
  './js/ui.js?v=c05c386d',
  './js/vendor/xlsx.full.min.js',
  './js/vendor/qrcode.min.js',
  './icons/icon.svg',
  './icons/day-night-dark.png',
  './icons/day-night-light.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first: always try the network so updates are picked up immediately.
// Falls back to cache only when offline. Only same-origin app assets are
// cached — caching the sync API would feed stale remote state to the merge
// logic when offline.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  let url;
  try { url = new URL(e.request.url); } catch { return; }
  if (url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          e.waitUntil(caches.open(CACHE).then(c => c.put(e.request, clone)));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
