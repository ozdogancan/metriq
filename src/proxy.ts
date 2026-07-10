// Metriq — oturum kapısı (Next 16 proxy). Token doğrulama Web Crypto ile (lib importsuz).
import { NextResponse, type NextRequest } from 'next/server';

const SESSION_COOKIE = 'metriq_session';
// Prod'da AUTH_SECRET zorunlu (fail-closed) — fallback yalnız dev içindir
const SECRET = process.env.AUTH_SECRET
  || (process.env.NODE_ENV === 'production' ? '' : 'metriq-dev-secret-degistir');

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64url(buf: ArrayBuffer): string {
  let bin = '';
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function verifyToken(token: string | undefined): Promise<boolean> {
  if (!token || !SECRET) return false; // secret yoksa fail-closed → login'e yönlendirir
  const dot = token.lastIndexOf('.');
  if (dot < 0) return false;
  let payload: string;
  try { payload = new TextDecoder().decode(b64urlToBytes(token.slice(0, dot))); } catch { return false; }
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  if (bytesToB64url(sig) !== token.slice(dot + 1)) return false;
  const [email, expStr] = payload.split('|');
  return Boolean(email) && Number(expStr) > Date.now();
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const ok = await verifyToken(req.cookies.get(SESSION_COOKIE)?.value);

  if (pathname === '/login') {
    if (ok) return NextResponse.redirect(new URL('/', req.url));
    return NextResponse.next();
  }
  if (ok) return NextResponse.next();

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const login = new URL('/login', req.url);
  if (pathname !== '/') login.searchParams.set('next', pathname);
  return NextResponse.redirect(login);
}

export const config = {
  // statikler, login API'si ve marka varlıkları hariç her şey korumalı
  matcher: [
    '/((?!_next/|api/auth/login|favicon\\.ico|icon\\.png|apple-icon\\.png|opengraph-image|logo\\.png|login-hero\\.jpg|robots\\.txt).*)',
  ],
};
