// sw.js —— 离线壳缓存：让 PWA 在无网络时仍能打开应用骨架。
//
// 策略：network-first（网络优先，失败回退缓存）。
// ⚠️ 重要：早期版本用的是 cache-first，导致线上更新后用户拿到的仍是旧缓存代码
// （典型症状：修了 Bug 但用户刷新后问题依旧）。故改为网络优先 + 超时兜底，
// 保证「有网时永远拿最新代码，断网时仍可离线打开」。

const CACHE = 'canmera-v2';
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

// 网络等待上限：超过就用缓存，避免弱网时白屏干等
const NET_TIMEOUT = 3500;

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
        Promise.all(
          // 清理所有历史版本缓存（含旧 cache-first 时代残留的 canmera-v1）
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

// 允许页面主动触发跳过等待，立即接管
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // 跨域请求（如 CDN）不拦截、不缓存
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    withTimeout(fetch(req), NET_TIMEOUT)
      .then((resp) => {
        if (resp && resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return resp;
      })
      .catch(() =>
        // 离线或超时：回退缓存；连缓存都没有时兜底首页
        caches.match(req).then((cached) => cached || caches.match('./index.html'))
      )
  );
});
