// Metriq — masaüstü web-push gönderimi (runs + advance route'ları paylaşır)
import 'server-only';
import { listPushSubscriptions, removePushSubscription } from '@/lib/store';
import type { AccessScope } from '@/lib/store';

// force: sekme görünür olsa bile OS bildirimi göster (sw.js bastırmayı atlar) — test için
export async function sendPush(scope: AccessScope, payload: { title: string; body: string; url: string; tag?: string; force?: boolean }) {
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!pub || !priv || !subject) return;
  const subs = await listPushSubscriptions(scope);
  if (!subs.length) return;
  const webpush = (await import('web-push')).default;
  webpush.setVapidDetails(subject, pub, priv);
  await Promise.allSettled(subs.map(async s => {
    try {
      await webpush.sendNotification(s as unknown as import('web-push').PushSubscription, JSON.stringify({ ...payload, icon: '/icon.png' }));
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await removePushSubscription(scope, s.endpoint);
    }
  }));
}
