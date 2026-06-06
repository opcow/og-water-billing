const CACHE = 'water-billing-v40';

const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css?v=15',
  './js/billing.js?v=2',
  './js/db.js?v=2',
  './js/ui.js?v=2',
  './js/app.js?v=33',
  './js/vendor/xlsx.full.min.js',
  './icons/icon.svg',
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
// Falls back to cache only when offline.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
