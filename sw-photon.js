const CACHE_NAME = 'photon-v4.0.6';
const CRITICAL = [
    '/',
    '/index.html',
    '/css/main.css',
    '/scripts/extensions/third-party/TurboClient-Photon/nitro-photon.js',
    '/scripts/extensions/third-party/TurboClient-Photon/photon-gpu.css'
];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(CRITICAL)));
    self.skipWaiting();
});

self.addEventListener('fetch', e => {
    if (e.request.method !== 'GET') return;
    e.respondWith(
        caches.match(e.request).then(cached => {
            return cached || fetch(e.request).then(res => {
                if (res.ok) {
                    const clone = res.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
                }
                return res;
            });
        })
    );
});
