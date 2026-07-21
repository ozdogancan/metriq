import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { randomUUID } from 'node:crypto';
import { start } from 'workflow/api';
import {
  listRuns, saveRun, storeFile, fetchStoredFile, deleteStoredFile,
  beginFinalizeStoredUpload, claimStoredUpload, cancelStoredUpload, getCalibration,
  updateRunMeta, reserveStoredUpload,
  isSupabase, getRun, drainStorageCleanup, type AccessScope,
} from '@/lib/store';
import { DEFAULT_RULES, STAGE_ORDER, type Run, type StageEvent, type VocabProfileId, type CalibrationRules, type RunCalibrationSnapshot } from '@/lib/types';
import { langFromCookie } from '@/lib/i18n';
import { processRunWorkflow } from '@/workflows/process-run';
import {
  MAX_PROJECT_NAME_CHARS,
  hasNwdDataMarker,
  isAllowedNwdSize,
  isSafeNwdFileName,
  isUuid,
  storageKeyName,
} from '@/lib/upload-policy';
import { isApiDenial, requireApiIdentity } from '@/lib/session';

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

async function resolveRuleSelection(scope: AccessScope, meta: RunCreateMeta): Promise<{
  rules: CalibrationRules;
  autoDetect: boolean;
  snapshot: RunCalibrationSnapshot | null;
} | null> {
  let autoDetect = meta.vocab === 'auto';
  let rules = autoDetect
    ? DEFAULT_RULES['steel-plant']
    : DEFAULT_RULES[meta.vocab as VocabProfileId];
  let snapshot: RunCalibrationSnapshot | null = null;
  if (meta.calibrationId) {
    const cal = await getCalibration(scope, meta.calibrationId);
    if (!cal || cal.status === 'archived') return null;
    rules = cal.rules;
    autoDetect = false;
    snapshot = {
      id: cal.id, name: cal.name, version: cal.version ?? 1, rules: cal.rules,
      modelFamily: cal.modelFamily, clientKey: cal.clientKey,
    };
  }
  return { rules, autoDetect, snapshot };
}

export async function GET() {
  const identity = await requireApiIdentity();
  if (isApiDenial(identity)) return identity;
  const runs = await listRuns(identity);
  after(async () => {
    try { await drainStorageCleanup(identity, 5); }
    catch (error) { console.error('storage cleanup retry failed', error); }
  });
  return NextResponse.json(runs);
}

function freshStages(): StageEvent[] {
  return STAGE_ORDER.map(key => ({ key, status: 'pending' as const }));
}

export async function POST(req: NextRequest) {
  const identity = await requireApiIdentity();
  if (isApiDenial(identity)) return identity;
  let meta: RunCreateMeta | null = null;
  let runId: string = randomUUID();
  let fileStored = false;
  let uploadReserved = false;
  let runSaved = false;
  let directUpload = false;
  const cleanupUnclaimedFile = async () => {
    if (!meta) return;
    try {
      if (fileStored) await deleteStoredFile(identity, runId, meta.fileName);
      if (uploadReserved || directUpload) await cancelStoredUpload(identity, runId, meta.fileName);
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
      if (await getRun(identity, runId)) {
        return NextResponse.json({ error: 'Bu yükleme kimliği zaten kullanılmış.' }, { status: 409 });
      }
      const expectedPath = `${runId}/${storageKeyName(meta.fileName)}`;
      if (body.storagePath !== expectedPath) {
        return NextResponse.json({ error: 'Yükleme yolu doğrulanamadı.' }, { status: 400 });
      }
      // The signed-upload endpoint issued this exact runId/fileName pair. From
      // here on, any rejected request must remove the unclaimed private object.
      fileStored = true;
      uploadReserved = true;
      buf = await fetchStoredFile(identity, expectedPath);
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
    const selection = await resolveRuleSelection(identity, meta);
    if (!selection) {
      await cleanupUnclaimedFile();
      return NextResponse.json({ error: 'Seçilen kalibrasyon artık mevcut değil.' }, { status: 400 });
    }
    const { rules, autoDetect, snapshot } = selection;

    if (!fileStored) {
      if (isSupabase) {
        await reserveStoredUpload(identity, runId, meta.fileName);
        uploadReserved = true;
      }
      await storeFile(identity, runId, meta.fileName, buf);
      fileStored = true;
    }
    if (isSupabase) {
      const acquired = await beginFinalizeStoredUpload(identity, runId, meta.fileName);
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
      calibrationSnapshot: snapshot,
      status: 'processing',
      totals: { pipeM: 0, fittingsEa: 0, flangesEa: 0, valvesEa: 0, steelM: 0, steelKg: 0, lines: [] },
      fasteners: { gaskets: 0, boltSets: 0, stubEnds: 0 },
      progress: freshStages(),
      ai: null,
      createdAt: new Date().toISOString(),
    };
    await saveRun(identity, run);
    runSaved = true;
    try {
      if (isSupabase) {
        await claimStoredUpload(identity, runId, meta.fileName);
        uploadReserved = false;
      }
    }
    catch (claimError) {
      // The sweeper checks for a live run before deleting, so a failed ack is
      // safe and will reconcile without touching the owned source object.
      console.error('upload reservation acknowledgement deferred', claimError);
    }

    // Dayanıklı workflow kaynak dosyayı private storage'dan kendi adımında alır;
    // tarayıcı kapanması, deploy veya function restart işi durdurmaz.
    let workflowRunId: string;
    try {
      const workflowRun = await start(processRunWorkflow, [{
        scope: { tenantKey: identity.tenantKey, userKey: identity.userKey },
        runId,
        lang,
        autoDetect,
      }]);
      workflowRunId = workflowRun.runId;
    } catch (workflowError) {
      await updateRunMeta(identity, runId, {
        status: 'error',
        error: 'Dayanıklı iş akışı başlatılamadı; dosyayı yeniden yükleyin.',
      });
      throw workflowError;
    }

    return NextResponse.json({ id: runId, status: 'processing', workflowRunId });
  } catch (e) {
    console.error('run create failed', e);
    if (!runSaved) await cleanupUnclaimedFile();
    return NextResponse.json({ error: 'Yükleme işleme alınamadı.' }, { status: 500 });
  }
}
