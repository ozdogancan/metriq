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
