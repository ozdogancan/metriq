/* Metriq — Web Push service worker.
   Sekme kapalıyken bile işlem-bitti push'larını yakalar, masaüstü bildirimi gösterir.
   Kullanıcı zaten platforma bakıyorsa OS bildirimi bastırılır (çift bildirim olmaz). */

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'Metriq';
  const options = {
    body: data.body || '',
    icon: data.icon || '/icon.png',
    badge: '/icon.png',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    data: { url: data.url || '/' },
    timestamp: Date.now(),
  };
  event.waitUntil((async () => {
    if (!data.force) {
      const cls = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const activelyViewing = cls.some((c) => c.focused && c.visibilityState === 'visible');
      if (activelyViewing) return; // uygulama-içi çan yeterli
    }
    await self.registration.showNotification(title, options);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || '/';
  const targetUrl = new URL(raw, self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url === targetUrl && 'focus' in w) return w.focus();
    }
    for (const w of wins) {
      if ('focus' in w) {
        try { await w.focus(); } catch { /* yoksay */ }
        if ('navigate' in w) {
          try { return await w.navigate(targetUrl); } catch { /* openWindow'a düş */ }
        }
        return;
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
  })());
});
