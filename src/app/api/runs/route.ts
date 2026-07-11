import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { randomUUID } from 'node:crypto';
import {
  listRuns, saveRun, saveRows, saveSteel, storeFile, fetchStoredFile, deleteStoredFile,
  beginFinalizeStoredUpload, claimStoredUpload, cancelStoredUpload, listCalibrations,
  updateRunMeta, addNotification, listPushSubscriptions, removePushSubscription, resolveStaleRun,
  isSupabase, getRun, drainStorageCleanup,
} from '@/lib/store';
import { parseNwd } from '@/lib/parser/nwd';
import { applyRules, detectVocab } from '@/lib/vocab';
import { computeComplexity, runAudit, aiEnabled } from '@/lib/ai';
import { DEFAULT_RULES, STAGE_ORDER, type Run, type StageEvent, type VocabProfileId, type CalibrationRules } from '@/lib/types';
import { langFromCookie } from '@/lib/i18n';
import {
  MAX_PROJECT_NAME_CHARS,
  hasNwdDataMarker,
  isAllowedNwdSize,
  isSafeNwdFileName,
  isUuid,
  storageKeyName,
} from '@/lib/upload-policy';
import { requireApiSession } from '@/lib/session';

export const runtime = 'nodejs';
export const maxDuration = 300;

type RunCreateMeta = {
  projectName: string;
  vocab: VocabProfileId | 'auto';
  calibrationId: string | null;
  fileName: string;
};

function normalizeMeta(raw: unknown, uploadedFileName?: string): RunCreateMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  const fileName = uploadedFileName ?? input.fileName;
  if (!isSafeNwdFileName(fileName)) return null;
  const vocab = input.vocab == null ? 'auto' : input.vocab;
  if (vocab !== 'auto' && vocab !== 'steel-plant' && vocab !== 'hygienic') return null;
  const calibrationId = input.calibrationId == null || input.calibrationId === '' ? null : input.calibrationId;
  if (calibrationId !== null && !isUuid(calibrationId)) return null;
  const defaultProject = fileName.replace(/\.nwd$/i, '');
  const projectName = (typeof input.projectName === 'string' ? input.projectName.trim() : defaultProject)
    .slice(0, MAX_PROJECT_NAME_CHARS) || defaultProject;
  return { projectName, vocab, calibrationId, fileName };
}

async function resolveRuleSelection(meta: RunCreateMeta): Promise<{
  rules: CalibrationRules;
  autoDetect: boolean;
} | null> {
  let autoDetect = meta.vocab === 'auto';
  let rules = autoDetect
    ? DEFAULT_RULES['steel-plant']
    : DEFAULT_RULES[meta.vocab as VocabProfileId];
  if (meta.calibrationId) {
    const cal = (await listCalibrations()).find(c => c.id === meta.calibrationId);
    if (!cal) return null;
    rules = cal.rules;
    autoDetect = false;
  }
  return { rules, autoDetect };
}

export async function GET() {
  const denied = await requireApiSession();
  if (denied) return denied;
  const runs = await listRuns();
  // 15 dk'yı aşan 'processing' run'ları hataya çevir (watchdog)
  const resolved = await Promise.all(
    runs.map(r => (r.status === 'processing' ? resolveStaleRun(r) : r)),
  );
  after(async () => {
    try { await drainStorageCleanup(5); }
    catch (error) { console.error('storage cleanup retry failed', error); }
  });
  return NextResponse.json(resolved);
}

// ---- aşama yardımcıları ----
function freshStages(): StageEvent[] {
  return STAGE_ORDER.map(key => ({ key, status: 'pending' as const }));
}
function stageSet(stages: StageEvent[], key: StageEvent['key'], status: StageEvent['status'], metrics?: StageEvent['metrics']): StageEvent[] {
  return stages.map(s => s.key === key
    ? { ...s, status, startedAt: s.startedAt ?? new Date().toISOString(), metrics: metrics ?? s.metrics }
    : s);
}

async function sendPush(payload: { title: string; body: string; url: string; tag?: string }) {
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!pub || !priv || !subject) return;
  const subs = await listPushSubscriptions();
  if (!subs.length) return;
  const webpush = (await import('web-push')).default;
  webpush.setVapidDetails(subject, pub, priv);
  await Promise.allSettled(subs.map(async s => {
    try {
      await webpush.sendNotification(s as unknown as import('web-push').PushSubscription, JSON.stringify({ ...payload, icon: '/icon.png' }));
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await removePushSubscription(s.endpoint);
    }
  }));
}

// ---- arka plan pipeline: aşama aşama gerçek metriklerle ilerleme yazar ----
async function processRun(run: Run, buf: Buffer, rules: CalibrationRules, lang: 'tr' | 'en', autoDetect = false) {
  let stages = run.progress ?? freshStages();
  const push = async () => updateRunMeta(run.id, { progress: stages });
  const t0 = Date.now();
  try {
    stages = stageSet(stages, 'upload', 'done', { 'MB': +(run.fileSize / 1e6).toFixed(1) });
    stages = stageSet(stages, 'scan', 'active');
    await push();

    const parsed = parseNwd(buf);
    if (parsed.stats.blobCount === 0 || parsed.stats.recordCount === 0) {
      throw new Error('Geçerli NWD veri akışı bulunamadı.');
    }

    // otomatik tesisat algılama: kural seti dosyanın kendi imzasından seçilir
    // (hijyenik: TRU-BORE/DIN 11850 · çelik: ASME/WELD NECK/A105)
    if (autoDetect) {
      const det = detectVocab(parsed);
      rules = DEFAULT_RULES[det.vocab];
      run.vocab = det.vocab;
      await updateRunMeta(run.id, { vocab: det.vocab });
      console.log(`[detect] tesisat=${det.vocab} (hijyenik:${det.hygienicHits} çelik:${det.steelHits})`);
    }

    stages = stageSet(stages, 'scan', 'done', { 'veri akışı': parsed.stats.blobCount, 'kayıt': parsed.stats.recordCount });
    stages = stageSet(stages, 'extract', 'done', { 'komponent': parsed.components.length });
    const sized = parsed.components.filter(c => c.s1 != null).length;
    stages = stageSet(stages, 'size', 'done', { 'boyutlu': sized });
    const lines = new Set(parsed.components.map(c => c.line).filter(l => l && l !== '?'));
    stages = stageSet(stages, 'lines', 'done', { 'hat': lines.size });
    stages = stageSet(stages, 'rules', 'active');
    await push();

    const { rows, steel, totals } = applyRules(parsed, rules);
    const main = rows.filter(r => r.scope === 'MAIN');
    stages = stageSet(stages, 'rules', 'done', { 'satır': main.length, 'boru m': +totals.pipeM.toFixed(1) });
    stages = stageSet(stages, 'steel', 'done', steel.length
      ? { 'profil': steel.length, 'kg': +totals.steelKg.toFixed(0) }
      : { 'profil': 0 });
    await push();

    // kayıtları erken yaz — denetim uzasa bile veri güvende
    await saveRows(run.id, rows);
    await saveSteel(run.id, steel);

    // AI denetçi: komplexity → model seçimi (kullanıcı talebi)
    stages = stageSet(stages, 'audit', 'active');
    await push();
    const complexity = computeComplexity({
      fileMb: run.fileSize / 1e6,
      components: parsed.components.length,
      distinctClasses: new Set(parsed.components.map(c => c.klass)).size,
      lines: lines.size,
      unknownSizeRatio: main.length ? main.filter(r => r.s1 == null).length / main.length : 0,
      steelMembers: parsed.steelMembers.length,
      fastenerCount: parsed.fasteners.gaskets + parsed.fasteners.boltSets + parsed.fasteners.stubEnds,
    });
    const ai = aiEnabled
      ? await runAudit({ rows, steel, fasteners: parsed.fasteners, vocab: rules.vocab, fileName: run.fileName, complexity, lang })
      : null;
    const criticals = ai?.findings.filter(f => f.severity === 'critical').length ?? 0;
    const warns = ai?.findings.filter(f => f.severity === 'warn').length ?? 0;
    stages = stageSet(stages, 'audit', 'done', ai
      ? { 'seviye': ai.tier, 'kritik': criticals, 'uyarı': warns }
      : { 'durum': 'atlandı' });
    stages = stageSet(stages, 'finalize', 'done', { 'sn': +((Date.now() - t0) / 1000).toFixed(1) });

    await updateRunMeta(run.id, { progress: stages, ai, status: 'done', totals, fasteners: parsed.fasteners });

    const title = lang === 'tr' ? `Metraj hazır: ${run.projectName}` : `Take-off ready: ${run.projectName}`;
    const body = lang === 'tr'
      ? `${main.length} satır · boru ${totals.pipeM.toFixed(1)} m${criticals ? ` · ⚠ ${criticals} kritik bulgu` : ''}`
      : `${main.length} rows · pipe ${totals.pipeM.toFixed(1)} m${criticals ? ` · ⚠ ${criticals} critical` : ''}`;
    try {
      await addNotification({
        id: randomUUID(), kind: 'run_done', title, body,
        url: `/runs/${run.id}`, read: false, createdAt: new Date().toISOString(),
      });
      await sendPush({ title, body, url: `/runs/${run.id}`, tag: `run-${run.id}` });
    } catch (notificationError) {
      // The take-off is already durable and complete; notification transport
      // failure must be visible in logs without corrupting the run status.
      console.error('completion notification failed', notificationError);
    }
  } catch (e) {
    console.error('pipeline hata', e);
    const msg = e instanceof Error ? e.message : 'işleme hatası';
    await updateRunMeta(run.id, { status: 'error', error: msg, progress: stages });
    const title = lang === 'tr' ? `Metraj başarısız: ${run.projectName}` : `Take-off failed: ${run.projectName}`;
    try {
      await addNotification({
        id: randomUUID(), kind: 'run_error', title, body: msg,
        url: `/runs/${run.id}`, read: false, createdAt: new Date().toISOString(),
      });
      await sendPush({ title, body: msg, url: `/runs/${run.id}`, tag: `run-${run.id}` });
    } catch (notificationError) {
      console.error('error notification failed', notificationError);
    }
  }
}

export async function POST(req: NextRequest) {
  const denied = await requireApiSession();
  if (denied) return denied;
  let meta: RunCreateMeta | null = null;
  let runId: string = randomUUID();
  let fileStored = false;
  let runSaved = false;
  let directUpload = false;
  const cleanupUnclaimedFile = async () => {
    if (!fileStored || !meta) return;
    try {
      await deleteStoredFile(runId, meta.fileName);
      await cancelStoredUpload(runId, meta.fileName);
    } catch (cleanupError) {
      console.error('unclaimed upload cleanup failed', cleanupError);
    } finally {
      fileStored = false;
    }
  };
  try {
    let buf: Buffer;
    let fileSize = 0;

    const ctype = req.headers.get('content-type') || '';
    if (ctype.includes('multipart/form-data')) {
      const fd = await req.formData();
      const file = fd.get('file') as File | null;
      if (!file) return NextResponse.json({ error: 'file missing' }, { status: 400 });
      if (!isAllowedNwdSize(file.size)) {
        return NextResponse.json({ error: 'NWD dosyası 50 MB sınırını aşıyor.' }, { status: 413 });
      }
      const rawMeta = (() => {
        try { return JSON.parse(String(fd.get('meta') || '{}')) as unknown; }
        catch { return null; }
      })();
      const normalized = normalizeMeta(rawMeta, file.name);
      if (!normalized) return NextResponse.json({ error: 'Geçersiz yükleme bilgisi.' }, { status: 400 });
      meta = normalized;
      buf = Buffer.from(await file.arrayBuffer());
      fileSize = buf.length;
      if (!hasNwdDataMarker(buf)) {
        return NextResponse.json({ error: 'Dosya geçerli bir NWD veri akışı içermiyor.' }, { status: 400 });
      }
    } else {
      const body = await req.json().catch(() => null) as Record<string, unknown> | null;
      const normalized = normalizeMeta(body);
      if (!body || !normalized || !isSupabase || !isUuid(body.runId)) {
        return NextResponse.json({ error: 'Geçersiz yükleme isteği.' }, { status: 400 });
      }
      meta = normalized;
      runId = body.runId;
      directUpload = true;
      if (await getRun(runId)) {
        return NextResponse.json({ error: 'Bu yükleme kimliği zaten kullanılmış.' }, { status: 409 });
      }
      const expectedPath = `${runId}/${storageKeyName(meta.fileName)}`;
      if (body.storagePath !== expectedPath) {
        fileStored = true;
        await cleanupUnclaimedFile();
        return NextResponse.json({ error: 'Yükleme yolu doğrulanamadı.' }, { status: 400 });
      }
      // The signed-upload endpoint issued this exact runId/fileName pair. From
      // here on, any rejected request must remove the unclaimed private object.
      fileStored = true;
      buf = await fetchStoredFile(expectedPath);
      fileSize = buf.length;
      if (!isAllowedNwdSize(fileSize)) {
        await cleanupUnclaimedFile();
        return NextResponse.json({ error: 'NWD dosyası 50 MB sınırını aşıyor.' }, { status: 413 });
      }
      if (!hasNwdDataMarker(buf)) {
        await cleanupUnclaimedFile();
        return NextResponse.json({ error: 'Dosya geçerli bir NWD veri akışı içermiyor.' }, { status: 400 });
      }
    }

    // kurallar: kalibrasyon > açık profil > otomatik algılama (parse sonrası)
    const selection = await resolveRuleSelection(meta);
    if (!selection) {
      await cleanupUnclaimedFile();
      return NextResponse.json({ error: 'Seçilen kalibrasyon artık mevcut değil.' }, { status: 400 });
    }
    const { rules, autoDetect } = selection;

    if (!fileStored) {
      await storeFile(runId, meta.fileName, buf);
      fileStored = true;
    }
    if (directUpload) {
      const acquired = await beginFinalizeStoredUpload(runId, meta.fileName);
      if (!acquired) {
        // A cleanup worker already owns this expired reservation. It is no
        // longer safe for this request to create a run that references it.
        fileStored = false;
        return NextResponse.json({ error: 'Yükleme rezervasyonu sona ermiş; dosyayı yeniden yükleyin.' }, { status: 409 });
      }
    }

    const lang = langFromCookie(req.cookies.get('lang')?.value);
    const run: Run = {
      id: runId,
      projectName: meta.projectName || meta.fileName,
      fileName: meta.fileName,
      fileSize,
      vocab: rules.vocab,
      calibrationId: meta.calibrationId,
      status: 'processing',
      totals: { pipeM: 0, fittingsEa: 0, flangesEa: 0, valvesEa: 0, steelM: 0, steelKg: 0, lines: [] },
      fasteners: { gaskets: 0, boltSets: 0, stubEnds: 0 },
      progress: freshStages(),
      ai: null,
      createdAt: new Date().toISOString(),
    };
    await saveRun(run);
    runSaved = true;
    try { if (directUpload) await claimStoredUpload(runId, meta.fileName); }
    catch (claimError) {
      // The sweeper checks for a live run before deleting, so a failed ack is
      // safe and will reconcile without touching the owned source object.
      console.error('upload reservation acknowledgement deferred', claimError);
    }

    // yanıttan SONRA işle — istemci /runs/[id]'de canlı pipeline'ı izler
    after(() => processRun(run, buf, rules, lang, autoDetect));

    return NextResponse.json({ id: runId, status: 'processing' });
  } catch (e) {
    console.error('run create failed', e);
    if (!runSaved) await cleanupUnclaimedFile();
    return NextResponse.json({ error: 'Yükleme işleme alınamadı.' }, { status: 500 });
  }
}
