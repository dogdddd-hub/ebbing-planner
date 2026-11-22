// 오프라인용 캐시. 파일을 고치면 VERSION을 올리세요.
const VERSION = 'v9';
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
    // 브라우저 HTTP 캐시도 건너뛰고 서버에 확인 (배포 직후 파일끼리 버전이 섞이지 않게)
    fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request))
  );
});

// 폰 푸시: 서버가 보낸 알림 표시
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data?.text() }; }
  // 앱 아이콘 숫자도 함께 (지원하는 기기만)
  const nav = self.navigator;
  const badge = typeof d.count === 'number' && nav.setAppBadge
    ? (d.count > 0 ? nav.setAppBadge(d.count) : nav.clearAppBadge()).catch(() => {})
    : Promise.resolve();
  e.waitUntil(Promise.all([badge, self.registration.showNotification(d.title || '복습 플래너', {
    body: d.body || '복습할 시간이에요.',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: d.tag || 'review',
    data: { url: d.url || './' },
  })]));
});
// 알림을 누르면 앱 열기 (이미 열려 있으면 그 창으로)
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = all.find((c) => c.url.startsWith(self.registration.scope));
    if (open) return open.focus();
    return clients.openWindow(e.notification.data?.url || './');
  })());
});
