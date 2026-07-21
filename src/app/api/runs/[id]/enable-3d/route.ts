// Metriq — SONRADAN 3B: yerel motorla işlenmiş (buluta hiç gitmemiş) bir metrajın
// kaynak NWD'sini talep üzerine Autodesk'e çevirtir → 3B görüntüleme açılır.
// Satırlara DOKUNMAZ (yerel/kalibre satırlar üstündür); yalnız run.aps yazılır.
// Maliyet: 0.5 token/dosya — aylık sert tavan burada da uygulanır.
import { NextRequest, NextResponse } from 'next/server';
import { apsEnabled, apsSubmit, apsManifestPhase } from '@/lib/aps';
import { getRun, listRuns, fetchStoredFile, updateRunMeta } from '@/lib/store';
import { requireApiSession } from '@/lib/session';
import { isUuid, storageKeyName } from '@/lib/upload-policy';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireApiSession();
  if (denied) return denied;
  if (!apsEnabled) return NextResponse.json({ error: 'APS yapılandırılmamış.' }, { status: 404 });
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: 'geçersiz id' }, { status: 400 });
  const run = await getRun(id);
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (run.status !== 'done') return NextResponse.json({ error: 'Metraj tamamlanmış olmalı.' }, { status: 409 });
  if (run.aps?.urn) return NextResponse.json({ ok: true, already: true });

  // 💰 aylık sert tavan (processRun ile aynı semantik)
  const cap = Number(process.env.APS_MONTHLY_TRANSLATION_CAP ?? 30);
  const monthStart = new Date();
  monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const apsThisMonth = (await listRuns())
    .filter(r => r.aps?.submittedAt && new Date(r.aps.submittedAt) >= monthStart).length;
  if (apsThisMonth >= cap) {
    return NextResponse.json({ error: `Aylık bulut çeviri tavanına ulaşıldı (${cap}) — gelecek ay sıfırlanır.` }, { status: 429 });
  }

  try {
    const buf = await fetchStoredFile(`${id}/${storageKeyName(run.fileName)}`);
    const objectKey = `${id}-${storageKeyName(run.fileName)}`;
    const { urn } = await apsSubmit(objectKey, buf);
    await updateRunMeta(id, { aps: { urn, objectKey, submittedAt: new Date().toISOString() } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('enable-3d failed', e);
    const msg = e instanceof Error && /not found|file/i.test(e.message)
      ? 'Kaynak NWD depoda bulunamadı (eski bir metraj olabilir) — dosyayı yeniden yüklemen gerekir.'
      : '3B etkinleştirilemedi — tekrar dene.';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// çeviri durumu poll'u — hafif (property indirmez)
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireApiSession();
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: 'geçersiz id' }, { status: 400 });
  const run = await getRun(id);
  if (!run?.aps?.urn) return NextResponse.json({ phase: 'none' });
  try {
    const state = await apsManifestPhase(run.aps.urn, run.aps.guid);
    if (state.phase === 'ready' && !run.aps.guid) {
      await updateRunMeta(id, { aps: { ...run.aps, guid: state.guid } });
    }
    return NextResponse.json(state.phase === 'ready' ? { phase: 'ready' } : state);
  } catch (e) {
    console.error('enable-3d poll failed', e);
    return NextResponse.json({ phase: 'retry' });
  }
}
