import { NextRequest, NextResponse } from 'next/server';
import { listNotifications, markNotificationsRead, deleteNotifications } from '@/lib/store';
import { isApiDenial, requireApiIdentity } from '@/lib/session';

export const runtime = 'nodejs';

// hedef doğrulaması: 'all' ya da en fazla 100 kimlik (string)
function parseTargets(v: unknown): string[] | 'all' | null {
  if (v === 'all') return 'all';
  if (Array.isArray(v) && v.length > 0 && v.length <= 100 && v.every(x => typeof x === 'string' && x.length <= 64)) {
    return v as string[];
  }
  return null;
}

export async function GET() {
  const identity = await requireApiIdentity();
  if (isApiDenial(identity)) return identity;
  const items = await listNotifications(identity, 30);
  return NextResponse.json({ items, unread: items.filter(n => !n.read).length });
}

export async function POST(req: NextRequest) {
  const identity = await requireApiIdentity();
  if (isApiDenial(identity)) return identity;
  const body = await req.json().catch(() => ({}));
  const targets = parseTargets(body.markRead);
  if (targets) {
    await markNotificationsRead(identity, targets);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: 'bad request' }, { status: 400 });
}

export async function DELETE(req: NextRequest) {
  const identity = await requireApiIdentity();
  if (isApiDenial(identity)) return identity;
  const body = await req.json().catch(() => ({}));
  const targets = parseTargets(body.ids);
  if (targets) {
    await deleteNotifications(identity, targets);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: 'bad request' }, { status: 400 });
}
