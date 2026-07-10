import { NextRequest, NextResponse } from 'next/server';
import { verifyCredentials, createSessionToken, SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth';

export const runtime = 'nodejs';

// Basit in-memory rate-limit: IP başına dakikada 5 deneme (tek Fluid instance için yeterli)
const RL_WINDOW_MS = 60_000;
const RL_MAX_ATTEMPTS = 5;
const rlAttempts = new Map<string, { count: number; resetAt: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  // sınırsız büyümesin: ara sıra süresi geçen kayıtları temizle
  if (rlAttempts.size > 1000) {
    for (const [k, v] of rlAttempts) if (now > v.resetAt) rlAttempts.delete(k);
  }
  const cur = rlAttempts.get(ip);
  if (!cur || now > cur.resetAt) {
    rlAttempts.set(ip, { count: 1, resetAt: now + RL_WINDOW_MS });
    return false;
  }
  cur.count += 1;
  return cur.count > RL_MAX_ATTEMPTS;
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'bilinmiyor';
  if (rateLimited(ip)) {
    return NextResponse.json(
      { ok: false, error: 'Çok fazla giriş denemesi — lütfen 1 dakika sonra tekrar deneyin.' },
      { status: 429 },
    );
  }
  const { email, password } = await req.json().catch(() => ({}));
  if (typeof email !== 'string' || typeof password !== 'string' || !verifyCredentials(email, password)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, createSessionToken(email), sessionCookieOptions);
  return res;
}
