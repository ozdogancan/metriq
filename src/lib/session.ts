import 'server-only';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySessionToken } from './auth';

export async function getSessionUser(): Promise<string | null> {
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value);
}

export async function requireApiSession(): Promise<Response | null> {
  if (await getSessionUser()) return null;
  return Response.json(
    { error: 'unauthorized' },
    { status: 401, headers: { 'cache-control': 'no-store' } },
  );
}
