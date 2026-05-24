// Tipsheet service worker — installable PWA + offline fallback.
//
// Strategy is news-appropriate:
//   • HTML/navigations  → network-first (fresh stories online), fall back to the
//     last-seen cached copy, then a branded offline page. Never serve stale news
//     when the network is available.
//   • /_assets, /fonts, icons → cache-first (content-hashed / immutable).
//   • everything else   → cache, then network.
//
// Bump VERSION to roll all caches on the next visit.
const VERSION = 'v1';
const STATIC_CACHE = `ts-static-${VERSION}`;
const PAGE_CACHE = `ts-pages-${VERSION}`;
const OFFLINE_URL = '/offline/';
const PRECACHE = [OFFLINE_URL, '/favicon.svg'];

const isImmutable = (p) =>
  p.startsWith('/_assets/') ||
  p.startsWith('/fonts/') ||
  p === '/favicon.svg' ||
  p.startsWith('/icon-') ||
  p.startsWith('/apple-touch');

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== STATIC_CACHE && k !== PAGE_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // leave cross-origin alone

  // Never intercept the widget API or the SW itself.
  if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return;

  if (isImmutable(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) =>
        cached ||
        fetch(request).then((res) => {
          const copy = res.clone();
          caches.open(STATIC_CACHE).then((c) => c.put(request, copy));
          return res;
        })
      )
    );
    return;
  }

  const isHTML = request.mode === 'navigate' ||
    (request.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(PAGE_CACHE).then((c) => c.put(request, copy));
          return res;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || caches.match(OFFLINE_URL))
        )
    );
    return;
  }

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});
