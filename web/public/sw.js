// Service worker tối giản cho bản đồ:
//  - tile nền, tile dữ liệu, font, sprite: stale-while-revalidate (hiện ngay từ cache, cập nhật ngầm)
//  - API: network-first, rớt mạng thì dùng bản cache gần nhất
//  - trang & JS/CSS: cache-first (tên file có hash)
const VERSION = 'v1';
const TILE_CACHE = `tiles-${VERSION}`;
const API_CACHE = `api-${VERSION}`;
const APP_CACHE = `app-${VERSION}`;
const MAX_TILES = 3000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon.svg'])));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

const isTileLike = (url) =>
  url.pathname.startsWith('/tiles/') ||
  url.hostname === 'tiles.openfreemap.org';

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone()).then(() => trim(cacheName, MAX_TILES));
      return res;
    })
    .catch(() => cached);
  return cached ?? network;
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw new Error('offline');
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (isTileLike(url)) return e.respondWith(staleWhileRevalidate(req, TILE_CACHE));
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) return e.respondWith(networkFirst(req, API_CACHE));
  if (url.origin === location.origin && req.mode === 'navigate') return e.respondWith(networkFirst(req, APP_CACHE));
  if (url.origin === location.origin && url.pathname.startsWith('/assets/')) {
    return e.respondWith(caches.match(req).then((c) => c ?? fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(APP_CACHE).then((cache) => cache.put(req, copy));
      return res;
    })));
  }
});
