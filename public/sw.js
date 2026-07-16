// Minimal service worker: its only job is to make Mirkwood installable as a
// standalone app (home-screen icon, no browser chrome). The game is live-only
// (WebSockets to a Durable Object room), so we deliberately do NOT cache
// assets: every launch fetches the latest client, which must always match the
// deployed engine (a stale cached client could not rejoin its room after a
// deploy). The navigate handler exists so browsers recognise a functional
// fetch handler.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request));
  }
});

// tapping a turn notification brings the saga back into focus (or reopens it)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if ('focus' in c) return c.focus();
      return self.clients.openWindow('/');
    }),
  );
});
