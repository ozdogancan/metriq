// Geriye dönük Viewer bootstrap route'u. Gerçek APS token'ı artık hiçbir
// koşulda tarayıcıya verilmez; tüm model verisi tenant/run kontrollü proxy'den
// akar. Eski istemciler de run + URN sahipliği doğrulanmadan yanıt alamaz.
import { NextRequest, NextResponse } from 'next/server';
import { apsEnabled } from '@/lib/aps';
import { getRun } from '@/lib/store';
import { isApiDenial, requireApiIdentity } from '@/lib/session';
import { isUuid } from '@/lib/upload-policy';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const identity = await requireApiIdentity();
  if (isApiDenial(identity)) return identity;
  if (!apsEnabled) return NextResponse.json({ error: 'APS yapılandırılmamış' }, { status: 404 });
  const runId = req.nextUrl.searchParams.get('runId');
  const requestedUrn = req.nextUrl.searchParams.get('urn');
  if (!isUuid(runId)) return NextResponse.json({ error: 'geçersiz runId' }, { status: 400 });
  const run = await getRun(identity, runId);
  if (!run?.aps?.urn) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (requestedUrn && requestedUrn !== run.aps.urn) {
    return NextResponse.json({ error: 'URN bu metraja ait değil' }, { status: 403 });
  }
  return NextResponse.json(
    { mode: 'tenant-run-proxy', expires_in: 300 },
    { headers: { 'cache-control': 'no-store' } },
  );
}
