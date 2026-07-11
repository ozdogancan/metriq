// Metriq — hafif oturum katmanı: HMAC imzalı cookie, env-tanımlı kullanıcılar
import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';

// AUTH_SECRET every ortamda zorunlu: bilinen bir dev fallback'i imzalı cookie'yi
// dışarı açılan geliştirme sunucularında forge edilebilir hâle getirirdi.
const SECRET = process.env.AUTH_SECRET || '';
export const SESSION_COOKIE = 'metriq_session';
const MAX_AGE_S = 60 * 60 * 12; // 12 saat

// Kullanıcılar: AUTH_USERS="email:sifre;email2:sifre2" (env) — yoksa boş (giriş kapalı)
function users(): Map<string, string> {
  const m = new Map<string, string>();
  for (const pair of (process.env.AUTH_USERS || '').split(';')) {
    const i = pair.indexOf(':');
    if (i > 0) m.set(pair.slice(0, i).trim().toLowerCase(), pair.slice(i + 1).trim());
  }
  return m;
}

function sign(payload: string): string {
  if (!SECRET) throw new Error('AUTH_SECRET tanımlı değil — production ortamında zorunlu');
  return createHmac('sha256', SECRET).update(payload).digest('base64url');
}

export function verifyCredentials(email: string, password: string): boolean {
  const stored = users().get(email.trim().toLowerCase());
  if (!stored) return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(password);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createSessionToken(email: string): string {
  const payload = `${email.trim().toLowerCase()}|${Date.now() + MAX_AGE_S * 1000}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

export function verifySessionToken(token: string | undefined): string | null {
  if (!token || !SECRET) return null; // secret yoksa fail-closed
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  let payload: string;
  try { payload = Buffer.from(token.slice(0, dot), 'base64url').toString(); } catch { return null; }
  const expected = sign(payload);
  const got = token.slice(dot + 1);
  const a = Buffer.from(expected); const b = Buffer.from(got);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const [email, expStr] = payload.split('|');
  if (!email || Number(expStr) < Date.now()) return null;
  if (!users().has(email.toLowerCase())) return null;
  return email;
}

export const sessionCookieOptions = {
  httpOnly: true as const,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: '/',
  maxAge: MAX_AGE_S,
};
