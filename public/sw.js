// DİQQƏT: gsr-shim.js keş-əvvəl strategiya ilə saxlanılır. Shim dəyişəndə bu adı MÜTLƏQ qaldır,
// yoxsa quraşdırılmış PWA-lar köhnə shim-i işlədəcək (açar göndərilməyəcək → API sorğuları rədd olunacaq).
const CACHE = 'coffeemoon-v3';
const STATIC = ['/gsr-shim.js', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  var url = new URL(e.request.url);

  // /mycode səhifəsini şəbəkədən al, keşə yaz; offline isə keşdən ver
  if (url.pathname === '/mycode') {
    e.respondWith(
      fetch(e.request).then(function(res) {
        var clone = res.clone();
        caches.open(CACHE).then(function(c) { c.put(e.request, clone); });
        return res;
      }).catch(function() {
        return caches.match(e.request);
      })
    );
    return;
  }

  // Statik resurslar üçün keş-əvvəl strategiyası
  if (STATIC.some(function(s) { return url.pathname === s; })) {
    e.respondWith(
      caches.match(e.request).then(function(cached) {
        return cached || fetch(e.request);
      })
    );
    return;
  }

  // Digər GET sorğular üçün şəbəkə-əvvəl
  e.respondWith(
    fetch(e.request).catch(function() {
      return caches.match(e.request);
    })
  );
});

// ── PUSH BİLDİRİŞLƏR ──────────────────────────────────────────────

self.addEventListener('push', function(e) {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch(_) {}

  const title   = data.title || '☕ Coffeemoon';
  const options = {
    body:    data.body    || '',
    icon:    data.icon    || '/icon-192.png',
    badge:   data.badge   || '/icon-192.png',
    tag:     data.tag     || 'coffeemoon',
    data:    data.url     ? { url: data.url } : {},
    vibrate: [100, 50, 100],
    requireInteraction: data.requireInteraction || false,
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

// Bildirişə klikləndikdə tətbiqi aç
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/mycode';

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      // Açıq pəncərə varsa ona fokuslan
      for (var c of list) {
        if (c.url.includes('/mycode') && 'focus' in c) return c.focus();
      }
      // Yoxdursa yeni pəncərə aç
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
