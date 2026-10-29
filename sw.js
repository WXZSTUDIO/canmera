// sw.js —— 离线壳缓存：让 PWA 在无网络时仍能打开应用骨架。
// 策略：静态资源安装期预缓存；运行期 cache-first，并回填新资源到缓存。

const CACHE = 'canmera-v1';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './js/main.js',
  './js/gl.js',
  './js/camera.js',
  './js/looks.js',
  './manifest.webmanifest',
  './icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((resp) => {
          // 仅缓存同源的成功响应，避免缓存跨域/错误响应
          if (resp && resp.ok && new URL(req.url).origin === self.location.origin) {
            const copy = resp.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return resp;
        })
        .catch(() => cached);
    })
  );
});
