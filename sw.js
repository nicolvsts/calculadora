// sw.js — Service Worker para ejecución 100% Offline de Own Calc (PWA)
const CACHE_NAME = 'own-calc-cas-v1.13';

// Archivos ligeros del shell principal (se cachean al instante en install)
const APP_SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './cas.worker.js?v=13'
];

// Motor simbólico Wasm, librerías 2D y tipografías locales (se pre-cachean sin bloquear la activación)
const HEAVY_AND_VENDOR_ASSETS = [
  './giac.js?v=5',
  './giac.wasm',
  './vendor/katex.min.css',
  './vendor/katex.min.js',
  './vendor/mathlive-static.css',
  './vendor/mathlive.min.js',
  './vendor/fonts/KaTeX_AMS-Regular.woff2',
  './vendor/fonts/KaTeX_Caligraphic-Bold.woff2',
  './vendor/fonts/KaTeX_Caligraphic-Regular.woff2',
  './vendor/fonts/KaTeX_Fraktur-Bold.woff2',
  './vendor/fonts/KaTeX_Fraktur-Regular.woff2',
  './vendor/fonts/KaTeX_Main-Bold.woff2',
  './vendor/fonts/KaTeX_Main-BoldItalic.woff2',
  './vendor/fonts/KaTeX_Main-Italic.woff2',
  './vendor/fonts/KaTeX_Main-Regular.woff2',
  './vendor/fonts/KaTeX_Math-BoldItalic.woff2',
  './vendor/fonts/KaTeX_Math-Italic.woff2',
  './vendor/fonts/KaTeX_SansSerif-Bold.woff2',
  './vendor/fonts/KaTeX_SansSerif-Italic.woff2',
  './vendor/fonts/KaTeX_SansSerif-Regular.woff2',
  './vendor/fonts/KaTeX_Script-Regular.woff2',
  './vendor/fonts/KaTeX_Size1-Regular.woff2',
  './vendor/fonts/KaTeX_Size2-Regular.woff2',
  './vendor/fonts/KaTeX_Size3-Regular.woff2',
  './vendor/fonts/KaTeX_Size4-Regular.woff2',
  './vendor/fonts/KaTeX_Typewriter-Regular.woff2'
];

async function cacheAppShell() {
  const cache = await caches.open(CACHE_NAME);
  await Promise.allSettled(
    APP_SHELL_ASSETS.map(async (url) => {
      const res = await fetch(url, { cache: 'no-cache' });
      if (res && res.ok) {
        await cache.put(url, res.clone());
        if (url === './index.html') {
          await cache.put('./', res.clone());
        }
      }
    })
  );
}

async function preCacheRemainingAssets() {
  const cache = await caches.open(CACHE_NAME);
  await Promise.allSettled(
    HEAVY_AND_VENDOR_ASSETS.map(async (url) => {
      const existing = await cache.match(url, { ignoreSearch: true });
      if (existing) return;
      const res = await fetch(url);
      if (res && res.ok) {
        await cache.put(url, res);
      }
    })
  );
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const client of clients) {
    client.postMessage({ type: 'SW_OFFLINE_READY' });
  }
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(cacheAppShell());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
      await self.clients.claim();
      await preCacheRemainingAssets();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'ENSURE_CACHED') {
    event.waitUntil(
      cacheAppShell().then(() => preCacheRemainingAssets())
    );
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const isNavigate =
        event.request.mode === 'navigate' || event.request.destination === 'document';

      // Para el documento principal (index.html): si hay internet, traer la última versión al instante;
      // si no hay internet (abierto desde Pantalla de Inicio offline), servir index.html desde la caché local.
      if (isNavigate) {
        try {
          const freshDoc = await fetch(event.request, { cache: 'no-cache' });
          if (freshDoc && freshDoc.status === 200) {
            await cache.put('./index.html', freshDoc.clone());
            await cache.put('./', freshDoc.clone());
            return freshDoc;
          }
        } catch (_) {
          // Sin conexión a internet: entregar inmediatamente la copia guardada en el dispositivo
        }
        const cachedDoc =
          (await cache.match(event.request, { ignoreSearch: true })) ||
          (await cache.match('./index.html', { ignoreSearch: true })) ||
          (await cache.match('./', { ignoreSearch: true }));
        if (cachedDoc) return cachedDoc;
      }

      // Para todos los demás recursos (giac.wasm, cas.worker.js, vendor/MathLive/KaTeX): Cache-First
      let cached = await cache.match(event.request);
      if (!cached) {
        cached = await cache.match(event.request, { ignoreSearch: true });
      }
      if (cached) {
        return cached;
      }

      // Si aún no está en caché, descargarlo de la red y guardarlo inmediatamente para uso offline
      const networkRes = await fetch(event.request);
      if (networkRes && (networkRes.status === 200 || networkRes.type === 'opaque')) {
        const clone = networkRes.clone();
        event.waitUntil(cache.put(event.request, clone));
      }
      return networkRes;
    })()
  );
});
