// Metriq — "Buluttan devam et": bulut aşamasında hata almış metrajı, BİTMİŞ
// Autodesk çevirisini yeniden kullanarak ücretsiz diriltir (yeni token yakılmaz).
// Gerçek vaka: property veritabanı Autodesk tarafında geç hazırlanınca 1 saatlik
// duvar run'ı düşürüyordu; oysa çeviri tamamdı ve veriler sonradan 200 dönüyordu.
import { NextRequest, NextResponse } from 'next/server';
import { start } from 'workflow/api';
import { processRunWorkflow } from '@/workflows/process-run';
import { getRun, updateRunMeta } from '@/lib/store';
import { isApiDenial, requireApiIdentity } from '@/lib/session';
import { isUuid } from '@/lib/upload-policy';
import { STAGE_ORDER, type StageEvent } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const identity = await requireApiIdentity();
  if (isApiDenial(identity)) return identity;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: 'geçersiz id' }, { status: 400 });

  const lang = (await req.json().catch(() => null))?.lang === 'en' ? 'en' as const : 'tr' as const;
  const run = await getRun(identity, id);
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 });
  // Yalnız bulut aşamasına ULAŞMIŞ hatalı işler devam ettirilebilir; çeviri
  // hiç başlamadıysa devam edilecek bir şey yoktur (yeniden yükleme gerekir).
  if (run.status !== 'error' || !run.aps?.urn) {
    return NextResponse.json({
      error: lang === 'tr'
        ? 'Yalnız bulut aşamasında hata almış metrajlar devam ettirilebilir.'
        : 'Only take-offs that failed during the cloud phase can be resumed.',
    }, { status: 409 });
  }

  const progress: StageEvent[] = (run.progress?.length
    ? run.progress
    : STAGE_ORDER.map(key => ({ key, status: 'pending' as const }))
  ).map(stage => stage.key === 'scan'
    ? { ...stage, status: 'active' as const, metrics: { bulut: 'buluttan devam ediliyor' } }
    : stage);

  await updateRunMeta(identity, id, {
    status: 'processing',
    error: '',
    progress,
    aps: {
      ...run.aps,
      // Süre pencereleri bu andan sayılır — createdAt eski diye anında düşmesin
      resumedAt: new Date().toISOString(),
      claimedUntil: new Date(0).toISOString(),
    },
  });

  try {
    const wf = await start(processRunWorkflow, [{
      scope: { tenantKey: identity.tenantKey, userKey: identity.userKey },
      runId: id,
      lang,
      autoDetect: false, // vocab ilk işlemede seçildi; resume yeniden karar VERMEZ
    }]);
    return NextResponse.json({ id, status: 'processing', workflowRunId: wf.runId });
  } catch (error) {
    // Workflow başlatılamadıysa run'ı yeniden dürüst hataya çevir (asılı processing kalmasın)
    console.error('resume workflow start failed', error);
    await updateRunMeta(identity, id, {
      status: 'error',
      error: lang === 'tr'
        ? 'Devam ettirme başlatılamadı; biraz sonra tekrar dene.'
        : 'Resume could not be started; try again shortly.',
    }).catch(() => undefined);
    return NextResponse.json({ error: 'resume başlatılamadı' }, { status: 500 });
  }
}
