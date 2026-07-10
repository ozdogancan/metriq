import { NextRequest, NextResponse } from 'next/server';
import { verifyCredentials, createSessionToken, SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const { email, password } = await req.json().catch(() => ({}));
  if (typeof email !== 'string' || typeof password !== 'string' || !verifyCredentials(email, password)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, createSessionToken(email), sessionCookieOptions);
  return res;
}
