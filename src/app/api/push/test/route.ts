// Metriq — masaüstü bildirim TESTİ: kullanıcı "çalışıyor mu?"yu tek tıkla görsün.
// force:true → sekme açık/görünür olsa bile OS bildirimi gösterilir (normalde
// uygulamaya bakarken bastırılır — "açık ama çalışmıyor" hissinin ana sebebi).
import { NextResponse } from 'next/server';
import { listPushSubscriptions } from '@/lib/store';
import { sendPush } from '@/lib/notify';
import { requireApiSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function POST() {
  const denied = await requireApiSession();
  if (denied) return denied;
  const subs = await listPushSubscriptions();
  if (subs.length === 0) {
    return NextResponse.json({ subscriptions: 0 });
  }
  await sendPush({
    title: 'Metriq — test bildirimi ✓',
    body: 'Masaüstü bildirimleri çalışıyor. Metraj bitince böyle haber alacaksın.',
    url: '/', tag: 'push-test', force: true,
  });
  return NextResponse.json({ subscriptions: subs.length });
}
