// Metriq — oturum kapısı (Next 16 proxy). Token doğrulama Web Crypto ile (lib importsuz).
import { NextResponse, type NextRequest } from 'next/server';

const SESSION_COOKIE = 'metriq_session';
const SECRET = process.env.AUTH_SECRET || '';

function contentSecurityPolicy(nonce: string): string {
  const isDev = process.env.NODE_ENV === 'development';
  let supabaseOrigin = '';
  try {
    const url = new URL(process.env.SUPABASE_URL || '');
    if (url.protocol === 'https:') supabaseOrigin = url.origin;
  } catch { /* Supabase is optional in local development. */ }
  const apsViewerOrigin = 'https://developer.api.autodesk.com';
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'unsafe-inline' ${apsViewerOrigin}`,
    `img-src 'self' data: blob: ${apsViewerOrigin}`,
    `font-src 'self' data: ${apsViewerOrigin}`,
    `connect-src 'self'${supabaseOrigin ? ` ${supabaseOrigin}` : ''}${isDev ? ' ws:' : ''}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

function nextWithCsp(req: NextRequest, nonce: string, csp: string): NextResponse {
  const requestHeaders = new Headers(req.headers);
  // Next.js reads the nonce from the request CSP and applies it to its own
  // bootstrap scripts. x-nonce is also available to future Server Components.
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

function withCsp(response: NextResponse, csp: string): NextResponse {
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

function activeUsers(): Set<string> {
  const out = new Set<string>();
  for (const pair of (process.env.AUTH_USERS || '').split(';')) {
    const i = pair.indexOf(':');
    if (i > 0) out.add(pair.slice(0, i).trim().toLowerCase());
  }
  return out;
}

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
  return Boolean(email) && Number(expStr) > Date.now() && activeUsers().has(email.toLowerCase());
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(nonce);
  const ok = await verifyToken(req.cookies.get(SESSION_COOKIE)?.value);

  if (pathname === '/login') {
    if (ok) return withCsp(NextResponse.redirect(new URL('/', req.url)), csp);
    return nextWithCsp(req, nonce, csp);
  }
  if (ok) return nextWithCsp(req, nonce, csp);

  if (pathname.startsWith('/api/')) {
    return withCsp(NextResponse.json({ error: 'unauthorized' }, { status: 401 }), csp);
  }
  const login = new URL('/login', req.url);
  if (pathname !== '/') login.searchParams.set('next', pathname);
  return withCsp(NextResponse.redirect(login), csp);
}

export const config = {
  // statikler, login API'si ve marka varlıkları hariç her şey korumalı
  matcher: [
    '/((?!_next/|\\.well-known/workflow/|api/auth/login|favicon\\.ico|icon\\.png|apple-icon\\.png|opengraph-image|logo\\.png|login-hero\\.jpg|robots\\.txt).*)',
  ],
};
