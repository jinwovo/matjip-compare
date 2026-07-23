// 맛집비교 지도 서비스워커 — 앱 셸/지도 라이브러리/타일 캐싱 (오프라인·빠른 재실행)
// API 응답은 캐시하지 않는다(항상 최신 별점).
const SHELL_CACHE = 'goodrest-shell-v33';
const RUNTIME_CACHE = 'goodrest-runtime-v33';
const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // 별점 데이터 API는 항상 네트워크 (캐시 개입 안 함)
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) return;

  // 지도 타일 & Leaflet CDN: 런타임 캐시(cache-first) — 재방문 시 빠르고 오프라인 대응
  if (url.hostname.includes('cartocdn.com') || url.hostname === 'unpkg.com' || url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(
      caches.open(RUNTIME_CACHE).then(async (c) => {
        const hit = await c.match(e.request);
        if (hit) return hit;
        try {
          const res = await fetch(e.request);
          if (res.ok || res.type === 'opaque') c.put(e.request, res.clone());
          return res;
        } catch (err) {
          return hit || Response.error();
        }
      }),
    );
    return;
  }

  // 앱 셸/정적 자산(동일 출처): cache-first, 네트워크 폴백
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).catch(() => caches.match('/'))),
    );
  }
});
