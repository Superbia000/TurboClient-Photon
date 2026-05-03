const CACHE_NAME = 'photon-v4';
const CRITICAL = [
    '/', '/index.html', '/css/main.css',
    '/scripts/extensions/third-party/TurboClient-Photon/nitro-photon.js',
    '/scripts/extensions/third-party/TurboClient-Photon/photon-gpu.css'
];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(CRITICAL)));
    self.skipWaiting();
});

// 缓存策略：优先缓存，后台更新 (SWR)
self.addEventListener('fetch', e => {
    if (e.request.method !== 'GET') return;
    e.respondWith(
        caches.open(CACHE_NAME).then(cache => {
            return cache.match(e.request).then(cached => {
                const fetched = fetch(e.request).then(res => {
                    if (res.ok) cache.put(e.request, res.clone());
                    return res;
                });
                return cached || fetched;
            });
        })
    );
});

// 预取角色列表
self.addEventListener('message', e => {
    if (e.data === 'PREFETCH_CHARACTERS') {
        fetch('/api/characters/all').then(res => 
            caches.open(CACHE_NAME).then(cache => cache.put('/api/characters/all', res))
        );
    }
});