'use strict';

const CACHE_PREFIX = 'crrt-prescribe-learn-';
const CACHE_NAME = `${CACHE_PREFIX}runtime-v1`;
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
  './data/troubleshooting.json'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL.map(url => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
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
