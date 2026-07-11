import { NextResponse } from 'next/server';
import { SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth';
import { requireApiSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function POST() {
  const denied = await requireApiSession();
  if (denied) return denied;
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', { ...sessionCookieOptions, maxAge: 0 });
  return res;
}
