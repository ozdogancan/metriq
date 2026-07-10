import { NextRequest, NextResponse } from 'next/server';
import { addPushSubscription, removePushSubscription } from '@/lib/store';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const sub = body?.subscription;
  if (!sub?.endpoint || !sub?.keys) return NextResponse.json({ error: 'bad subscription' }, { status: 400 });
  await addPushSubscription(sub);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.endpoint) return NextResponse.json({ error: 'endpoint missing' }, { status: 400 });
  await removePushSubscription(body.endpoint);
  return NextResponse.json({ ok: true });
}
