// Metriq — hafif oturum katmanı: HMAC imzalı cookie, env-tanımlı kullanıcılar
import 'server-only';
import { createHash, createHmac, scryptSync, timingSafeEqual } from 'node:crypto';

// AUTH_SECRET every ortamda zorunlu: bilinen bir dev fallback'i imzalı cookie'yi
// dışarı açılan geliştirme sunucularında forge edilebilir hâle getirirdi.
const SECRET = process.env.AUTH_SECRET || '';
export const SESSION_COOKIE = 'metriq_session';
const MAX_AGE_S = 60 * 60 * 12; // 12 saat
export const LEGACY_TENANT_KEY = 'legacy-default';

export interface SessionIdentity {
  email: string;
  tenantKey: string;
  userKey: string;
}

// Kullanıcılar: AUTH_USERS="email:sifre;email2:sifre2" (env) — yoksa boş (giriş kapalı)
function users(): Map<string, string> {
  const m = new Map<string, string>();
  for (const pair of (process.env.AUTH_USERS || '').split(';')) {
    const i = pair.indexOf(':');
    const email = pair.slice(0, i).trim().toLowerCase();
    if (i > 0 && email.length <= 254 && /^[^\s|:;=]+@[^\s|:;=]+$/.test(email)) {
      m.set(email, pair.slice(i + 1).trim());
    }
  }
  return m;
}

// Çok kiracılı kurulum için opsiyonel eşleme:
// AUTH_USER_TENANTS="user@example.com=acme;other@example.com=globex"
// Eşleme bulunmayan mevcut hesaplar migration ile aynı güvenli legacy tenant'a
// düşer. Tenant anahtarı AUTH_SECRET'ten bağımsızdır; secret rotasyonu veri
// sahipliğini değiştirmez.
function tenantAliases(): Map<string, string> {
  const result = new Map<string, string>();
  for (const pair of (process.env.AUTH_USER_TENANTS || '').split(';')) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const email = pair.slice(0, i).trim().toLowerCase();
    const alias = pair.slice(i + 1).trim().toLowerCase();
    if (users().has(email) && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(alias)) result.set(email, alias);
  }
  return result;
}

function stableKey(namespace: 'tenant' | 'user', value: string): string {
  return createHash('sha256').update(`metriq:${namespace}:${value}`).digest('hex');
}

export function identityForEmail(rawEmail: string): SessionIdentity | null {
  const email = rawEmail.trim().toLowerCase();
  const configuredUsers = users();
  if (!configuredUsers.has(email)) return null;
  const alias = tenantAliases().get(email);
  // AUTH_LEGACY_OWNER tek e-posta ya da ";"/"," ile ayrılmış LİSTE olabilir.
  // Metriq gibi ortak çalışılan kurulumlarda mevcut tüm veri tek legacy tenant'ta
  // durur; birden fazla sahip tanımlanmazsa ekip deploy sonrası kendi geçmişini
  // göremez (gerçek vaka: 2 kullanıcı, migration sonrası 0 metraj).
  const legacyOwners = new Set(
    (process.env.AUTH_LEGACY_OWNER || '')
      .split(/[;,]/).map(value => value.trim().toLowerCase())
      .filter(value => value.length > 0 && configuredUsers.has(value)),
  );
  const ownsLegacyData = legacyOwners.size
    ? legacyOwners.has(email)
    : configuredUsers.size === 1;
  return {
    email,
    // Birden fazla unmapped hesap ASLA aynı tenant'a düşmez. Eski veriyi yalnız
    // açık AUTH_LEGACY_OWNER (veya tek-kullanıcılı geriye uyum) görebilir.
    tenantKey: alias
      ? stableKey('tenant', alias)
      : ownsLegacyData ? LEGACY_TENANT_KEY : stableKey('tenant', `user:${email}`),
    userKey: stableKey('user', email),
  };
}

function sign(payload: string): string {
  if (!SECRET) throw new Error('AUTH_SECRET tanımlı değil — production ortamında zorunlu');
  return createHmac('sha256', SECRET).update(payload).digest('base64url');
}

export function verifyCredentials(email: string, password: string): boolean {
  if (email.length > 254 || password.length > 1024) return false;
  const stored = users().get(email.trim().toLowerCase());
  if (!stored) return false;
  // Tercih edilen biçim: "scrypt:<base64url-salt>:<base64url-hash>".
  // Eski sha256 ve düz metin kayıtları yalnız kesintisiz migration içindir.
  if (stored.startsWith('scrypt:')) {
    const [, saltText, hashText, ...extra] = stored.split(':');
    if (!saltText || !hashText || extra.length) return false;
    try {
      const salt = Buffer.from(saltText, 'base64url');
      const expected = Buffer.from(hashText, 'base64url');
      if (salt.length < 16 || expected.length !== 64) return false;
      const actual = scryptSync(password, salt, expected.length);
      return timingSafeEqual(expected, actual);
    } catch {
      return false;
    }
  }
  if (stored.startsWith('sha256:')) {
    const a = Buffer.from(stored.slice(7), 'hex');
    const b = createHash('sha256').update(password).digest();
    return a.length === b.length && timingSafeEqual(a, b);
  }
  const a = Buffer.from(stored);
  const b = Buffer.from(password);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createSessionToken(email: string): string {
  const identity = identityForEmail(email);
  if (!identity) throw new Error('unknown auth user');
  // İlk iki alan legacy Proxy doğrulamasıyla uyumludur. Tenant/user alanları
  // imzalıdır ve verify sırasında güncel AUTH_USERS eşlemesiyle tekrar doğrulanır.
  const payload = `${identity.email}|${Date.now() + MAX_AGE_S * 1000}|${identity.tenantKey}|${identity.userKey}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

export function verifySessionToken(token: string | undefined): SessionIdentity | null {
  if (!token || !SECRET) return null; // secret yoksa fail-closed
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  let payload: string;
  try { payload = Buffer.from(token.slice(0, dot), 'base64url').toString(); } catch { return null; }
  const expected = sign(payload);
  const got = token.slice(dot + 1);
  const a = Buffer.from(expected); const b = Buffer.from(got);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const [email, expStr, tokenTenantKey, tokenUserKey] = payload.split('|');
  if (!email || Number(expStr) < Date.now()) return null;
  const identity = identityForEmail(email);
  if (!identity) return null;
  // Eski iki alanlı cookie'ler bir defalık geriye uyumla kabul edilir. Yeni
  // cookie tenant değiştirildiyse anında geçersiz olur; eski tenant'a erişemez.
  if (tokenTenantKey && tokenTenantKey !== identity.tenantKey) return null;
  if (tokenUserKey && tokenUserKey !== identity.userKey) return null;
  return identity;
}

export const sessionCookieOptions = {
  httpOnly: true as const,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: '/',
  maxAge: MAX_AGE_S,
};
