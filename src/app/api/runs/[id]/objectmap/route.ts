// Metriq — "modelde göster" satır→dbId eşlemesi. runs.aps'e gömülmez (poll şişer);
// viewer paneli ilk açılışta bir kez çeker.
import { NextRequest, NextResponse } from 'next/server';
import { getRun, getRunArtifact } from '@/lib/store';
import { requireApiSession } from '@/lib/session';
import { isUuid } from '@/lib/upload-policy';

export const runtime = 'nodejs';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireApiSession();
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: 'geçersiz id' }, { status: 400 });
  const run = await getRun(id);
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!run.aps?.urn) return NextResponse.json({ error: 'Bu metraj bulut (3B) verisi taşımıyor.' }, { status: 404 });
  const map = await getRunArtifact<Record<string, number[]>>(id, 'objectmap.json');
  return NextResponse.json({
    urn: run.aps.urn,
    map: map ?? {},
  }, { headers: { 'cache-control': 'private, max-age=300' } });
}
