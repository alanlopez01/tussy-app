// Service Worker - Tussy
// Handles push notifications and scheduled self-check

self.addEventListener('push', function(event) {
  var data = event.data ? event.data.json() : {};
  var title = data.title || 'Tussy';
  var options = {
    body: data.body || '',
    icon: '/logo.png',
    badge: '/logo.png',
    data: { url: data.url || '/' },
    vibrate: [200, 100, 200]
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var url = event.notification.data.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        if ('focus' in clientList[i]) {
          clientList[i].navigate(url);
          return clientList[i].focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});

// Periodic sync to check for daily summary (runs when browser allows)
self.addEventListener('periodicsync', function(event) {
  if (event.tag === 'tussy-resumen') {
    event.waitUntil(fetchAndNotify());
  }
});

// Also triggered by message from the app
self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'CHECK_RESUMEN') {
    fetchAndNotify();
  }
});

function fetchAndNotify() {
  return fetch('/api/resumen-diario?secret=tussy2026')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.ok) return;
      var fmt = function(n) { return '$' + n.toLocaleString('es-AR'); };
      var body = fmt(data.totalHoy) + ' (' + data.opsHoy + ' ventas) | ' + data.diff + ' vs ayer | Mejor: ' + data.mejor;
      return self.registration.showNotification('Resumen Tussy ' + data.fechaFmt, {
        body: body,
        icon: '/logo.png',
        badge: '/logo.png',
        data: { url: '/' },
        vibrate: [200, 100, 200]
      });
    })
    .catch(function() {});
}
