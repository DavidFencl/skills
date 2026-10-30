// A service worker that takes control at once and answers API calls itself, out of reach of
// page-level mocks. ui-changelog blocks service workers by default, so it must never take control.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (event.request.url.includes('/api/')) event.respondWith(new Response('{"from":"service worker"}', { headers: { 'content-type': 'application/json' } }));
});
