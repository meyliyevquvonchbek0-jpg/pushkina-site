// Minimal service worker — enables "Add to Home Screen" / install prompt.
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { self.clients.claim(); });
self.addEventListener('fetch', (e) => {
  // Pass-through: always fetch from network, no offline caching yet.
});
