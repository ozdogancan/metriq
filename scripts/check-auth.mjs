import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';

const salt = Buffer.alloc(16, 7);
const hash = scryptSync('correct horse', salt, 64);
process.env.AUTH_SECRET = 'test-only-session-secret-with-sufficient-entropy';
process.env.AUTH_USERS = `operator@example.com:scrypt:${salt.toString('base64url')}:${hash.toString('base64url')};reviewer@example.com:scrypt:${salt.toString('base64url')}:${hash.toString('base64url')}`;
process.env.AUTH_USER_TENANTS = 'operator@example.com=client-a';
process.env.AUTH_LEGACY_OWNER = 'reviewer@example.com';

const auth = await import('../src/lib/auth.ts');
assert.equal(auth.verifyCredentials('OPERATOR@example.com', 'correct horse'), true);
assert.equal(auth.verifyCredentials('operator@example.com', 'wrong horse'), false);

const identity = auth.identityForEmail('operator@example.com');
assert.ok(identity);
assert.match(identity.tenantKey, /^[0-9a-f]{64}$/);
assert.match(identity.userKey, /^[0-9a-f]{64}$/);
assert.equal(auth.identityForEmail('reviewer@example.com')?.tenantKey, auth.LEGACY_TENANT_KEY);
process.env.AUTH_LEGACY_OWNER = '';
assert.notEqual(auth.identityForEmail('reviewer@example.com')?.tenantKey, auth.LEGACY_TENANT_KEY,
  'multiple unmapped users must never share the legacy tenant implicitly');
process.env.AUTH_LEGACY_OWNER = 'reviewer@example.com';

const token = auth.createSessionToken('operator@example.com');
assert.deepEqual(auth.verifySessionToken(token), identity);
process.env.AUTH_USER_TENANTS = 'operator@example.com=client-b';
assert.equal(auth.verifySessionToken(token), null, 'tenant reassignment must revoke old cookies');

console.log('Auth hardening checks passed');

// Ortak-calisma regresyonu: iki kullanici + AUTH_LEGACY_OWNER listesi ->
// IKISI DE mevcut legacy veriyi gorur (deploy sonrasi "gecmis kayboldu" vakasi).
{
  process.env.AUTH_USERS = 'a@x.com:sifre1;b@x.com:sifre2';
  process.env.AUTH_LEGACY_OWNER = 'a@x.com;b@x.com';
  delete process.env.AUTH_USER_TENANTS;
  const mod = await import(`../src/lib/auth.ts?legacy-list=${Date.now()}`);
  const a = mod.identityForEmail('a@x.com');
  const b = mod.identityForEmail('b@x.com');
  assert.equal(a.tenantKey, mod.LEGACY_TENANT_KEY, 'ilk sahip legacy tenant gormeli');
  assert.equal(b.tenantKey, mod.LEGACY_TENANT_KEY, 'ikinci sahip de legacy tenant gormeli');
  assert.notEqual(a.userKey, b.userKey, 'kullanici anahtarlari ayri kalmali');

  // Liste yoksa iki kullanici ASLA ayni tenant'a dusmemeli (izolasyon korunur)
  process.env.AUTH_LEGACY_OWNER = '';
  const mod2 = await import(`../src/lib/auth.ts?no-legacy=${Date.now()}`);
  const a2 = mod2.identityForEmail('a@x.com');
  const b2 = mod2.identityForEmail('b@x.com');
  assert.notEqual(a2.tenantKey, b2.tenantKey, 'esleme yokken tenantlar ayrilmali');
  assert.notEqual(a2.tenantKey, mod2.LEGACY_TENANT_KEY, 'esleme yokken legacy veri gorunmemeli');
}
console.log('Auth legacy-owner list: shared workspace + isolation verified');
