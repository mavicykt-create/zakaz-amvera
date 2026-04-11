const STATIC_CACHE = 'mobile-order-static-v6';
const API_CACHE = 'mobile-order-api-v6';
const IMAGE_CACHE = 'mobile-order-images-v6';
const OFFLINE_PAGE = '/offline.html';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/offline.html',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    await cache.addAll(STATIC_ASSETS);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();

    await Promise.all(
      keys
        .filter((key) => ![STATIC_CACHE, API_CACHE, IMAGE_CACHE].includes(key))
        .map((key) => caches.delete(key))
    );

    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirstApi(req));
    return;
  }

  if (url.pathname.startsWith('/img')) {
    event.respondWith(cacheFirstImage(req));
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(networkFirstPage(req));
    return;
  }

  event.respondWith(staleWhileRevalidateStatic(req));
});

async function staleWhileRevalidateStatic(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);

  const networkFetch = fetch(request, { cache: 'no-store' })
    .then((response) => {
      if (response && response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    networkFetch;
    return cached;
  }

  const response = await networkFetch;
  if (response) return response;

  return caches.match(OFFLINE_PAGE);
}

async function networkFirstPage(request) {
  const cache = await caches.open(STATIC_CACHE);

  try {
    const response = await fetch(request, { cache: 'no-store' });

    if (response && response.ok) {
      cache.put('/index.html', response.clone());
    }

    return response;
  } catch {
    const cached = await cache.match('/index.html');
    if (cached) return cached;
    return caches.match(OFFLINE_PAGE);
  }
}

async function networkFirstApi(request) {
  const cache = await caches.open(API_CACHE);

  try {
    const response = await fetch(request, { cache: 'no-store' });

    if (response.ok) {
      cache.put(request, response.clone());
    }

    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;

    return new Response(
      JSON.stringify({
        ok: false,
        offline: true,
        error: 'Нет сети и нет сохраненных данных'
      }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

async function cacheFirstImage(request) {
  const cache = await caches.open(IMAGE_CACHE);
  const cached = await cache.match(request);

  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('', { status: 404 });
  }
}
