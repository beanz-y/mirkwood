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

// A push from the Worker: the app is closed (or the whole browser is), so this
// is the only thing of ours still running. The payload arrives encrypted and
// is decrypted by the browser before we see it (see worker/push.js).
// userVisibleOnly is part of the subscription contract: every push MUST show a
// notification, so a malformed payload still rings rather than silently
// spending the player's trust.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* show the fallback */ }
  const title = data.title || 'Mirkwood';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || 'The saga awaits your decision.',
    // shares the tag with the local tier, so a returning player never finds
    // two notifications for the same decision
    tag: data.tag || 'mk-turn',
    icon: '/icon-192.png',   // full colour: the large icon in the notification
    // The badge is the small status-bar icon, and Android builds it from the
    // ALPHA CHANNEL ALONE — colour is thrown away. Handing it an app icon (an
    // opaque square) makes the mask the whole square: a solid white blob.
    // badge-96.png is a white rune on transparency, which is the only thing
    // this option ever wanted. See tools/mk-icons.py.
    badge: '/badge-96.png',
    renotify: true,
    data: { url: data.url || '/' },
  }));
});

// tapping a turn notification brings the saga back into focus (or reopens it)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if ('focus' in c) return c.focus();
      // nothing running: a push carries the saga code, so the app reopens
      // straight into the room rather than the lobby
      return self.clients.openWindow(url);
    }),
  );
});
