import { NextRequest, NextResponse } from 'next/server';
import { addPushSubscription, removePushSubscription } from '@/lib/store';
import { requireApiSession } from '@/lib/session';

export const runtime = 'nodejs';

function allowedPushHost(host: string): boolean {
  return host === 'fcm.googleapis.com'
    || host === 'updates.push.services.mozilla.com'
    || host === 'web.push.apple.com'
    || host.endsWith('.push.apple.com')
    || host.endsWith('.notify.windows.com');
}

function validEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && (url.port === '' || url.port === '443')
      && allowedPushHost(url.hostname.toLowerCase());
  } catch { return false; }
}

function validKey(value: unknown, max: number): value is string {
  return typeof value === 'string'
    && value.length >= 8
    && value.length <= max
    && /^[A-Za-z0-9_-]+$/.test(value);
}

export async function POST(req: NextRequest) {
  const denied = await requireApiSession();
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  const sub = body?.subscription;
  if (!validEndpoint(sub?.endpoint)
    || !validKey(sub?.keys?.p256dh, 256)
    || !validKey(sub?.keys?.auth, 128)) {
    return NextResponse.json({ error: 'bad subscription' }, { status: 400 });
  }
  await addPushSubscription({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const denied = await requireApiSession();
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  if (!validEndpoint(body?.endpoint)) return NextResponse.json({ error: 'endpoint missing' }, { status: 400 });
  await removePushSubscription(body.endpoint);
  return NextResponse.json({ ok: true });
}
