import { NextRequest, NextResponse } from 'next/server';
import { listNotifications, markNotificationsRead } from '@/lib/store';

export const runtime = 'nodejs';

export async function GET() {
  const items = await listNotifications(30);
  return NextResponse.json({ items, unread: items.filter(n => !n.read).length });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (body.markRead === 'all' || Array.isArray(body.markRead)) {
    await markNotificationsRead(body.markRead);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: 'bad request' }, { status: 400 });
}
