// Metriq — APS bulut işini İLERLET. Autodesk çevirisi dakikalar sürer ve Vercel
// fonksiyonu bunu bekleyemez; işleme ekranındaki istemci bu endpoint'i periyodik
// çağırır, her çağrı durumu bir adım öteler. 'ready' olduğunda çıkarım + denetim
// + bildirim burada tamamlanır (processRun'ın bulut karşılığı).
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { apsAdvance, apsRetryTranslate } from '@/lib/aps';
import { extractFromApsProps } from '@/lib/parser/aps-extract';
import { getRun, saveRows, saveSteel, updateRunMeta, addNotification, listCalibrations, claimApsRun, putRunArtifact } from '@/lib/store';
import { sendPush } from '@/lib/notify';
import { computeComplexity, runAudit, aiEnabled } from '@/lib/ai';
import { DEFAULT_RULES, type CalibrationRules, type Run, type StageEvent } from '@/lib/types';
import { langFromCookie } from '@/lib/i18n';
import { requireApiSession } from '@/lib/session';
import { isUuid } from '@/lib/upload-policy';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Aynı lambda içinde eşzamanlı çift-tamamlama koruması (poll üst üste binerse)
const inFlight = new Set<string>();

function stageSet(stages: StageEvent[], key: StageEvent['key'], status: StageEvent['status'], metrics?: StageEvent['metrics']): StageEvent[] {
  return stages.map(s => s.key === key
    ? { ...s, status, startedAt: s.startedAt ?? new Date().toISOString(), metrics: metrics ?? s.metrics }
    : s);
}

// Bulut yolunda da "sonraki dosyada kurallar kendiliğinden" sözü geçerli:
// açık profil yoksa aynı vokabülün EN GÜNCEL öğrenilmiş profili otomatik uygulanır
// (yerel yoldaki processRun autoDetect kalıbının birebir karşılığı).
async function resolveRules(run: Run): Promise<{ rules: CalibrationRules; appliedId: string | null; appliedName: string | null }> {
  const cals = await listCalibrations();
  if (run.calibrationId) {
    const cal = cals.find(c => c.id === run.calibrationId);
    if (cal) return { rules: cal.rules, appliedId: cal.id, appliedName: cal.name };
  }
  const learned = cals
    .filter(c => c.rules.vocab === run.vocab)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (learned) return { rules: learned.rules, appliedId: learned.id, appliedName: learned.name };
  return { rules: DEFAULT_RULES[run.vocab] ?? DEFAULT_RULES['steel-plant'], appliedId: null, appliedName: null };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireApiSession();
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: 'geçersiz id' }, { status: 400 });
  const run = await getRun(id);
  if (!run) return NextResponse.json({ error: 'run yok' }, { status: 404 });
  if (run.status !== 'processing' || !run.aps) return NextResponse.json({ phase: 'noop' });
  if (inFlight.has(id)) return NextResponse.json({ phase: 'busy' });
  inFlight.add(id);
  const lang = langFromCookie(req.cookies.get('lang')?.value);
  let stages = run.progress ?? [];
  try {
    const state = await apsAdvance(run.aps.urn, run.aps.guid);

    if (state.phase === 'translating') {
      stages = stageSet(stages, 'scan', 'active', { 'bulut': `Autodesk çevirisi ${state.progress || 'sürüyor'}` });
      await updateRunMeta(id, { progress: stages });
      return NextResponse.json({ phase: 'translating', progress: state.progress });
    }

    if (state.phase === 'extracting') {
      if (!run.aps.guid) await updateRunMeta(id, { aps: { ...run.aps, guid: state.guid } });
      stages = stageSet(stages, 'scan', 'active', { 'bulut': 'özellik veritabanı hazırlanıyor' });
      await updateRunMeta(id, { progress: stages });
      return NextResponse.json({ phase: 'extracting' });
    }

    if (state.phase === 'failed') {
      // Autodesk motoru bazen geçici çöker (-777) — TEK otomatik yeniden deneme
      // (gerçek vaka: 124MB ENQ-129 ilk çeviri failed, retry success)
      if (!run.aps.retriedAt) {
        const ok = await apsRetryTranslate(run.aps.urn).catch(() => false);
        if (ok) {
          await updateRunMeta(id, {
            aps: { ...run.aps, retriedAt: new Date().toISOString() },
            progress: stageSet(stages, 'scan', 'active', { 'bulut': 'çeviri yeniden denendi (otomatik)' }),
          });
          return NextResponse.json({ phase: 'translating', progress: 'retry' });
        }
      }
      await updateRunMeta(id, { status: 'error', error: state.message, progress: stages });
      const title = lang === 'tr' ? `Metraj başarısız: ${run.projectName}` : `Take-off failed: ${run.projectName}`;
      await addNotification({
        id: randomUUID(), kind: 'run_error', title, body: state.message,
        url: `/runs/${id}`, read: false, createdAt: new Date().toISOString(),
      }).catch(e => console.error('aps error notification failed', e));
      return NextResponse.json({ phase: 'failed', error: state.message });
    }

    // ready → tam çıkarım + tamamlama. Önce DB-seviyesi claim: iki lambda/sekme
    // aynı işi paralel bitirmesin (çift bildirim + çift AI maliyeti önlenir).
    if (!(await claimApsRun(id))) return NextResponse.json({ phase: 'busy' });
    const t0 = Date.now();
    const { rules, appliedId, appliedName } = await resolveRules(run);
    if (appliedId && appliedId !== run.calibrationId) {
      await updateRunMeta(id, { calibrationId: appliedId }); // izlenebilirlik: hangi profil uygulandı
      run.calibrationId = appliedId;
    }
    const ex = extractFromApsProps(state.collection, rules);
    if (ex.family === 'none' || ex.rows.length === 0) {
      // asla uydurma: mesh/dumb-solid modellerde yapısal MTO verisi yoktur
      const msg = lang === 'tr'
        ? 'Modelde yapısal MTO verisi yok (mesh/dumb geometri) — bu dosya tipinden güvenilir metraj çıkarılamaz.'
        : 'No structured MTO data in model (mesh/dumb geometry) — a reliable take-off cannot be extracted from this file type.';
      await updateRunMeta(id, { status: 'error', error: msg, progress: stages });
      await addNotification({
        id: randomUUID(), kind: 'run_error',
        title: lang === 'tr' ? `Metraj başarısız: ${run.projectName}` : `Take-off failed: ${run.projectName}`,
        body: msg, url: `/runs/${id}`, read: false, createdAt: new Date().toISOString(),
      }).catch(e => console.error('aps none notification failed', e));
      return NextResponse.json({ phase: 'failed', error: msg });
    }

    const famLabel = ex.family === 'revit' ? 'Revit' : ex.family === 'plant3d-dwg' ? 'Plant3D-DWG' : 'karışık';
    stages = stageSet(stages, 'scan', 'done', { 'bulut': famLabel, 'obje': ex.totalCount });
    stages = stageSet(stages, 'extract', 'done', { 'komponent': ex.structuredCount });
    const sized = ex.rows.filter(r => r.s1 != null).length;
    stages = stageSet(stages, 'size', 'done', { 'boyutlu': sized });
    stages = stageSet(stages, 'lines', 'done', { 'hat': ex.lineCount });
    const main = ex.rows.filter(r => r.scope === 'MAIN');
    stages = stageSet(stages, 'rules', 'done', appliedName
      ? { 'satır': main.length, 'boru m': +ex.totals.pipeM.toFixed(1), 'profil': appliedName.slice(0, 24) }
      : { 'satır': main.length, 'boru m': +ex.totals.pipeM.toFixed(1) });
    stages = stageSet(stages, 'steel', 'done', { 'profil': 0 });
    stages = stageSet(stages, 'audit', 'active');
    await updateRunMeta(id, { progress: stages });

    await saveRows(id, ex.rows);
    await saveSteel(id, []);
    // "modelde göster": satır→dbId eşlemesi (viewer izole+zoom) — fail-soft, metraj bundan bağımsız
    try { await putRunArtifact(id, 'objectmap.json', ex.objectMap); }
    catch (e) { console.error('objectmap artifact yazılamadı (fail-soft)', e); }

    const complexity = computeComplexity({
      fileMb: run.fileSize / 1e6,
      components: ex.structuredCount,
      distinctClasses: new Set(ex.rows.map(r => r.code)).size,
      lines: ex.lineCount,
      unknownSizeRatio: main.length ? main.filter(r => r.s1 == null).length / main.length : 0,
      steelMembers: 0,
      fastenerCount: ex.fasteners.gaskets + ex.fasteners.boltSets + ex.fasteners.stubEnds,
    });
    const ai = aiEnabled
      ? await runAudit({ rows: ex.rows, steel: [], fasteners: ex.fasteners, vocab: rules.vocab, fileName: run.fileName, complexity, lang })
      : null;
    const criticals = ai?.findings.filter(f => f.severity === 'critical').length ?? 0;
    const warns = ai?.findings.filter(f => f.severity === 'warn').length ?? 0;
    stages = stageSet(stages, 'audit', 'done', ai ? { 'seviye': ai.tier, 'kritik': criticals, 'uyarı': warns } : { 'durum': 'atlandı' });
    stages = stageSet(stages, 'finalize', 'done', { 'sn': +((Date.now() - t0) / 1000).toFixed(1) });

    // çift-tamamlama emniyeti: hâlâ processing mi?
    const fresh = await getRun(id);
    if (!fresh || fresh.status !== 'processing') return NextResponse.json({ phase: 'done' });
    await updateRunMeta(id, { progress: stages, ai, status: 'done', totals: ex.totals, fasteners: ex.fasteners });

    const title = lang === 'tr' ? `Metraj hazır: ${run.projectName}` : `Take-off ready: ${run.projectName}`;
    const body = lang === 'tr'
      ? `${main.length} satır · boru ${ex.totals.pipeM.toFixed(1)} m (bulut/${famLabel})${criticals ? ` · ⚠ ${criticals} kritik bulgu` : ''}`
      : `${main.length} rows · pipe ${ex.totals.pipeM.toFixed(1)} m (cloud/${famLabel})${criticals ? ` · ⚠ ${criticals} critical` : ''}`;
    try {
      await addNotification({
        id: randomUUID(), kind: 'run_done', title, body,
        url: `/runs/${id}`, read: false, createdAt: new Date().toISOString(),
      });
      await sendPush({ title, body, url: `/runs/${id}`, tag: `run-${id}` });
    } catch (notificationError) {
      console.error('aps completion notification failed', notificationError);
    }
    return NextResponse.json({ phase: 'done' });
  } catch (e) {
    // geçici APS/ağ hatası: run'ı öldürme, sıradaki poll yeniden dener (watchdog 60 dk tavan)
    console.error('aps advance error', e);
    return NextResponse.json({ phase: 'retry', error: e instanceof Error ? e.message : 'aps hata' }, { status: 200 });
  } finally {
    inFlight.delete(id);
  }
}
