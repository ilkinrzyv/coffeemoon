const CACHE = 'coffeemoon-v4';
// Şəkillər dəyişmir → keş-əvvəl (sürətli, offline işləyir)
const STATIC = ['/icon-192.png', '/icon-512.png'];
// Tətbiq skriptləri → ŞƏBƏKƏ-ƏVVƏL, keş ehtiyat.
// Səbəb: əvvəl keş-əvvəl idi və shim dəyişəndə quraşdırılmış PWA-lar köhnə nüsxəni
// işlədirdi (açar göndərilmirdi → sorğular rədd olunurdu). İndi həmişə ən yenisi gəlir,
// yalnız internet yoxdursa keşdən verilir.
const APP_JS = ['/gsr-shim.js', '/common.js'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(STATIC.concat(APP_JS)))   // offline üçün skriptləri də bir dəfə yığ
      .then(() => self.skipWaiting())
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

  // Tətbiq skriptləri: şəbəkə-əvvəl, keşi yenilə; internet yoxdursa keşdən ver
  if (APP_JS.some(function(s) { return url.pathname === s; })) {
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

  // Şəkillər: keş-əvvəl
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
