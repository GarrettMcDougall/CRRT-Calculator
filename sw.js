'use strict';

/**
 * sw.js — service worker with version-keyed caching.
 *
 * The cache name is derived from version.json at install time, so every
 * time you bump version.json and push, the new service worker installs
 * with a fresh cache name, the old cache is deleted on activate, and all
 * connected clients reload automatically. No manual cache-busting needed.
 *
 * Network-first fetch: the live file is always attempted first; the cache
 * is only used as a fallback when the network is unavailable. This means
 * users always get the latest files when online, even between version bumps.
 */

const CACHE_PREFIX = 'crrt-prescribe-learn-';

// APP_SHELL lists every file to pre-cache on install.
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './version.json',
  './css/tokens.css',
  './css/app.css',
  './js/calc.js',
  './js/store.js',
  './js/schematic.js',
  './js/ui-calculator.js',
  './js/ui-theory.js',
  './js/ui-teaching.js',
  './js/app.js',
  './config/local-protocol.json',
  './data/cases.json',
  './data/quiz.json',
  './data/solutions.json',
  './data/theory.json',
  './data/troubleshooting.json',
];

// Fetch version.json (bypassing any existing cache) and return the version
// string to use as the cache key. Falls back to a timestamp so a network
// failure during install never blocks the service worker.
async function getVersionedCacheName() {
  try {
    const res = await fetch('./version.json', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data && data.version) {
        return `${CACHE_PREFIX}${data.version}`;
      }
    }
  } catch (_) { /* fall through */ }
  // Fallback: use a timestamp so each install still gets a unique name.
  return `${CACHE_PREFIX}fallback-${Date.now()}`;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cacheName = await getVersionedCacheName();
    const cache = await caches.open(cacheName);
    // cache: 'reload' bypasses the HTTP cache when pre-caching the shell,
    // so we always cache the files from the origin server, not a stale CDN copy.
    await cache.addAll(APP_SHELL.map(url => new Request(url, { cache: 'reload' })));
    // Take control immediately rather than waiting for all tabs to close.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const currentCache = await getVersionedCacheName();
    // Delete every crrt-* cache except the one we just installed.
    const names = await caches.keys();
    await Promise.all(
      names
        .filter(name => name.startsWith(CACHE_PREFIX) && name !== currentCache)
        .map(name => caches.delete(name))
    );
    // Claim all clients (open tabs) so they immediately use the new worker.
    await self.clients.claim();
    // Tell every open tab to reload so they pick up the new files right away.
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(client => client.navigate(client.url));
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // version.json is always fetched from the network — it is the signal that
  // tells the app (and this service worker) whether a new version is available.
  if (url.pathname.endsWith('version.json')) {
    event.respondWith(fetch(request, { cache: 'no-store' }));
    return;
  }

  // Everything else: network-first with cache fallback.
  event.respondWith((async () => {
    const cacheName = await getVersionedCacheName();
    const cache = await caches.open(cacheName);
    try {
      const response = await fetch(request, { cache: 'no-store' });
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch (error) {
      const cached = await cache.match(request);
      if (cached) return cached;
      if (request.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      throw error;
    }
  })());
});
