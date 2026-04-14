/**
 * TestNear Service Worker v3.0
 * Strategy:
 *   - Static assets (HTML, CSS, JS, fonts): Cache-first
 *   - API calls (/api/*): Network-first, no cache
 *   - Locale files: Cache with network refresh
 */

const CACHE_NAME   = 'testnear-v3';
const STATIC_CACHE = 'testnear-static-v3';

const STATIC_ASSETS = [
  '/',
  '/app.css',
  '/app.js',
  '/locales/en.json',
  '/locales/es.json',
  '/manifest.json',
];

/* ── INSTALL: pre-cache static assets ── */
self.addEventListener('install', event => {
  console.log('[SW] Installing TestNear v3');
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => {
      return cache.addAll(STATIC_ASSETS).catch(err => {
        console.warn('[SW] Pre-cache partial failure (ok in dev):', err.message);
      });
    }).then(() => self.skipWaiting())
  );
});

/* ── ACTIVATE: clean old caches ── */
self.addEventListener('activate', event => {
  console.log('[SW] Activating TestNear v3');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== STATIC_CACHE && k !== CACHE_NAME)
            .map(k => { console.log('[SW] Deleting old cache:', k); return caches.delete(k); })
      )
    ).then(() => self.clients.claim())
  );
});

/* ── FETCH: routing strategy ── */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and cross-origin requests
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // API calls: network-first, no caching
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkOnly(request));
    return;
  }

  // Locale files: cache-first, refresh in background
  if (url.pathname.startsWith('/locales/')) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // Leaflet CDN (external): cache-first
  if (url.hostname.includes('cdnjs') || url.hostname.includes('openstreetmap') || url.hostname.includes('fonts.g')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Static assets & HTML: cache-first
  event.respondWith(cacheFirst(request));
});

/* ── STRATEGIES ── */

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Offline fallback for HTML navigation
    if (request.headers.get('accept')?.includes('text/html')) {
      const fallback = await caches.match('/');
      if (fallback) return fallback;
    }
    return new Response('Offline — please reconnect to search for testing sites.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch {
    return new Response(JSON.stringify({ success: false, error: 'Offline — please reconnect.' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const fetchPromise = fetch(request).then(response => {
    if (response.ok) {
      caches.open(STATIC_CACHE).then(cache => cache.put(request, response.clone()));
    }
    return response;
  }).catch(() => cached);
  return cached || fetchPromise;
}
