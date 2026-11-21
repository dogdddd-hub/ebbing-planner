// 오프라인용 캐시. 파일을 고치면 VERSION을 올리세요.
const VERSION = 'v3';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'scheduler.js', 'merge.js', 'sync.js', 'config.js', 'manifest.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))));
  self.clients.claim();
});
// 네트워크 우선, 실패하면 캐시 (업데이트가 바로 반영되도록)
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // 다른 주소(동기화 서버·CDN)는 캐시하지 않음
  if (new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request))
  );
});
