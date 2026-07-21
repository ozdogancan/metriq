import 'server-only';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySessionToken, type SessionIdentity } from './auth';

export async function getSessionIdentity(): Promise<SessionIdentity | null> {
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value);
}

export async function getSessionUser(): Promise<string | null> {
  return (await getSessionIdentity())?.email ?? null;
}

export async function requireApiSession(): Promise<Response | null> {
  if (await getSessionIdentity()) return null;
  return Response.json(
    { error: 'unauthorized' },
    { status: 401, headers: { 'cache-control': 'no-store' } },
  );
}

export async function requireApiIdentity(): Promise<SessionIdentity | Response> {
  const identity = await getSessionIdentity();
  if (identity) return identity;
  return Response.json(
    { error: 'unauthorized' },
    { status: 401, headers: { 'cache-control': 'no-store' } },
  );
}

export function isApiDenial(value: SessionIdentity | Response): value is Response {
  return value instanceof Response;
}
