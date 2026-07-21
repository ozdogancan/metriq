import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  addNotification,
  claimApsRun,
  fetchStoredFile,
  findLatestCalibration,
  getCalibration,
  getRun,
  listRuns,
  putRunArtifact,
  saveRows,
  saveSteel,
  updateRunMeta,
  type AccessScope,
  type CalibrationModelFamily,
} from './store';
import { sendPush } from './notify';
import { parseNwd } from './parser/nwd';
import { extractFromApsProps } from './parser/aps-extract';
import { apsEnabled, apsFetchProperties, apsManifestPhase, apsRetryTranslate, apsSubmit } from './aps';
import { applyRules, detectVocab } from './vocab';
import { aiEnabled, computeComplexity, runAudit } from './ai';
import { DEFAULT_RULES, STAGE_ORDER, type CalibrationRules, type ExtractionQuality, type Run, type RunCalibrationSnapshot, type StageEvent } from './types';
import { storageKeyName } from './upload-policy';

export interface RunWorkflowPhase {
  phase: 'done' | 'review' | 'failed' | 'aps' | 'translating' | 'extracting' | 'busy' | 'retry' | 'noop';
  terminal: boolean;
  waitSeconds?: number;
  message?: string;
}

export interface StoredRunInput {
  scope: AccessScope;
  runId: string;
  lang: 'tr' | 'en';
  autoDetect: boolean;
}

const phase = (
  name: RunWorkflowPhase['phase'],
  terminal: boolean,
  extra: Pick<RunWorkflowPhase, 'waitSeconds' | 'message'> = {},
): RunWorkflowPhase => ({ phase: name, terminal, ...extra });

function freshStages(): StageEvent[] {
  return STAGE_ORDER.map(key => ({ key, status: 'pending' as const }));
}

function stageSet(
  stages: StageEvent[],
  key: StageEvent['key'],
  status: StageEvent['status'],
  metrics?: StageEvent['metrics'],
): StageEvent[] {
  return stages.map(stage => stage.key === key
    ? { ...stage, status, startedAt: stage.startedAt ?? new Date().toISOString(), metrics: metrics ?? stage.metrics }
    : stage);
}

async function notify(
  scope: AccessScope,
  run: Run,
  lang: 'tr' | 'en',
  kind: 'run_done' | 'run_error',
  body: string,
): Promise<void> {
  const title = kind === 'run_done'
    ? (lang === 'tr' ? `Metraj hazır: ${run.projectName}` : `Take-off ready: ${run.projectName}`)
    : (lang === 'tr' ? `Metraj başarısız: ${run.projectName}` : `Take-off failed: ${run.projectName}`);
  try {
    await addNotification(scope, {
      id: randomUUID(), kind, title, body, url: `/runs/${run.id}`,
      read: false, createdAt: new Date().toISOString(),
    });
    await sendPush(scope, { title, body, url: `/runs/${run.id}`, tag: `run-${run.id}` });
  } catch (error) {
    // Sonuç zaten kalıcıdır; bildirim taşıma hatası sonucu geri almamalı.
    console.error('run notification failed', error);
  }
}

async function failRun(
  scope: AccessScope,
  run: Run,
  lang: 'tr' | 'en',
  message: string,
  stages: StageEvent[],
): Promise<RunWorkflowPhase> {
  await updateRunMeta(scope, run.id, { status: 'error', error: message.slice(0, 500), progress: stages });
  await notify(scope, run, lang, 'run_error', message.slice(0, 300));
  return phase('failed', true, { message });
}

async function resolveRules(
  scope: AccessScope,
  run: Run,
  modelFamily: CalibrationModelFamily,
): Promise<{
  rules: CalibrationRules;
  appliedId: string | null;
  appliedName: string | null;
  snapshot: RunCalibrationSnapshot | null;
}> {
  const frozen = run.calibrationSnapshot;
  if (frozen && (frozen.modelFamily === modelFamily || frozen.modelFamily === 'legacy')
    && frozen.rules.vocab === run.vocab) {
    return { rules: frozen.rules, appliedId: frozen.id, appliedName: frozen.name, snapshot: frozen };
  }
  if (run.calibrationId) {
    const explicit = await getCalibration(scope, run.calibrationId);
    if (explicit && explicit.status !== 'archived'
      && (explicit.modelFamily === modelFamily || explicit.modelFamily === 'legacy')) {
      const snapshot: RunCalibrationSnapshot = {
        id: explicit.id, name: explicit.name, version: explicit.version ?? 1,
        rules: explicit.rules, modelFamily: explicit.modelFamily, clientKey: explicit.clientKey,
      };
      return { rules: explicit.rules, appliedId: explicit.id, appliedName: explicit.name, snapshot };
    }
  }
  const learned = await findLatestCalibration(scope, {
    vocab: run.vocab,
    modelFamily,
    clientKey: 'default',
  });
  if (learned) {
    const snapshot: RunCalibrationSnapshot = {
      id: learned.id, name: learned.name, version: learned.version ?? 1,
      rules: learned.rules, modelFamily: learned.modelFamily, clientKey: learned.clientKey,
    };
    return { rules: learned.rules, appliedId: learned.id, appliedName: learned.name, snapshot };
  }
  const defaultRules = DEFAULT_RULES[run.vocab] ?? DEFAULT_RULES['steel-plant'];
  return {
    rules: defaultRules,
    appliedId: null,
    appliedName: null,
    snapshot: {
      id: `default-${modelFamily}-${run.vocab}`,
      name: 'Metriq default',
      version: 0,
      rules: defaultRules,
      modelFamily,
      clientKey: 'default',
    },
  };
}

function localExtractionQuality(
  parsed: ReturnType<typeof parseNwd>,
  output: ReturnType<typeof applyRules>,
): ExtractionQuality {
  const totalObjects = parsed.components.length;
  const measurableObjects = parsed.components.filter(component => component.s1 != null).length;
  const measurableRatio = totalObjects ? measurableObjects / totalObjects : 0;
  const structured = output.rows.some(row => row.scope === 'MAIN') && measurableRatio >= 0.8;
  return {
    family: 'plant3d-local',
    quality: structured ? 'structured' : 'partial',
    confidence: Math.min(0.95, Math.max(0.35, 0.45 + measurableRatio * 0.5)),
    // Confidence is schema confidence, not holdout accuracy. The current mixed
    // corpus does not yet satisfy the strict >=90 release gate for this whole
    // family, so an answer workbook remains mandatory for quote export.
    releaseEligible: false,
    coverage: {
      totalObjects,
      recognizedObjects: totalObjects,
      measurableObjects,
      candidateObjects: Math.max(0, totalObjects - measurableObjects),
      recognizedRatio: totalObjects ? 1 : 0,
      measurableRatio,
    },
    provenance: [{
      extractor: 'plant3d-local',
      objects: totalObjects,
      rows: output.rows.length,
      candidates: Math.max(0, totalObjects - measurableObjects),
      confidence: Math.min(0.95, Math.max(0.35, 0.45 + measurableRatio * 0.5)),
      limitations: ['Bağımsız corpus release kapısı henüz %90 üzerini doğrulamadı; cevap Excel’i gerekir.'],
    }],
  };
}

/** First durable step: fetch the owned source object and run the local parser. */
export async function processStoredRun(input: StoredRunInput): Promise<RunWorkflowPhase> {
  const { scope, runId, lang, autoDetect } = input;
  const run = await getRun(scope, runId);
  if (!run || run.status !== 'processing') return phase('noop', true);
  // A retried workflow sees the persisted APS submission and continues instead
  // of uploading/translating the model a second time.
  if (run.aps?.urn) return phase('aps', false, { waitSeconds: 2 });

  let stages = run.progress?.length ? run.progress : freshStages();
  const t0 = Date.now();
  try {
    stages = stageSet(stages, 'upload', 'done', { MB: +(run.fileSize / 1e6).toFixed(1) });
    stages = stageSet(stages, 'scan', 'active');
    await updateRunMeta(scope, run.id, { progress: stages });

    const key = `${run.id}/${storageKeyName(run.fileName)}`;
    const buffer = await fetchStoredFile(scope, key);
    let parsed: ReturnType<typeof parseNwd> | null = null;
    try {
      parsed = parseNwd(buffer);
      if (parsed.stats.blobCount === 0 || parsed.stats.recordCount === 0) parsed = null;
    } catch (error) {
      if (!apsEnabled) throw error;
    }
    if ((!parsed || parsed.components.length === 0) && !apsEnabled) {
      return failRun(scope, run, lang, 'Geçerli NWD veri akışı bulunamadı.', stages);
    }

    const sizedRatio = parsed?.components.length
      ? parsed.components.filter(component => component.s1 != null).length / parsed.components.length
      : 0;
    if (apsEnabled && (!parsed || parsed.components.length === 0 || sizedRatio < 0.3)) {
      const cap = Number(process.env.APS_MONTHLY_TRANSLATION_CAP ?? 30);
      const monthStart = new Date();
      monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
      const used = (await listRuns(scope))
        .filter(value => value.aps?.submittedAt && new Date(value.aps.submittedAt) >= monthStart).length;
      if (!Number.isFinite(cap) || cap < 1 || used >= cap) {
        return failRun(scope, run, lang,
          `Aylık bulut çeviri tavanına ulaşıldı (${Number.isFinite(cap) ? cap : 0}).`, stages);
      }
      const reason = !parsed || parsed.components.length === 0
        ? 'yerel yapısal veri yok'
        : `boyutlu oran %${Math.round(sizedRatio * 100)}`;
      stages = stageSet(stages, 'scan', 'active', { bulut: 'Autodesk çevirisi başlatıldı', sebep: reason });
      if (autoDetect && parsed) run.vocab = detectVocab(parsed).vocab;
      const selection = await resolveRules(scope, run, 'aps');
      run.calibrationId = selection.appliedId;
      run.calibrationSnapshot = selection.snapshot;
      const objectKey = `${run.id}-${storageKeyName(run.fileName)}`;
      const submitted = await apsSubmit(objectKey, buffer);
      await updateRunMeta(scope, run.id, {
        progress: stages,
        vocab: run.vocab,
        calibrationId: selection.appliedId,
        calibrationSnapshot: selection.snapshot,
        aps: { urn: submitted.urn, objectKey, submittedAt: new Date().toISOString() },
      });
      return phase('aps', false, { waitSeconds: 5 });
    }
    if (!parsed) return failRun(scope, run, lang, 'Geçerli NWD veri akışı bulunamadı.', stages);

    let rules: CalibrationRules;
    let appliedId: string | null = null;
    let appliedName: string | null = null;
    let calibrationSnapshot: RunCalibrationSnapshot | null = null;
    if (autoDetect) {
      const detected = detectVocab(parsed);
      run.vocab = detected.vocab;
      const selection = await resolveRules(scope, run, 'plant3d-local');
      ({ rules, appliedId, appliedName, snapshot: calibrationSnapshot } = selection);
      run.calibrationId = appliedId;
      run.calibrationSnapshot = calibrationSnapshot;
      await updateRunMeta(scope, run.id, {
        vocab: run.vocab, calibrationId: appliedId, calibrationSnapshot,
      });
    } else {
      ({ rules, appliedId, appliedName, snapshot: calibrationSnapshot } = await resolveRules(scope, run, 'plant3d-local'));
      if (appliedId !== run.calibrationId || calibrationSnapshot !== run.calibrationSnapshot) {
        run.calibrationId = appliedId;
        run.calibrationSnapshot = calibrationSnapshot;
        await updateRunMeta(scope, run.id, { calibrationId: appliedId, calibrationSnapshot });
      }
    }

    stages = stageSet(stages, 'scan', 'done', { 'veri akışı': parsed.stats.blobCount, kayıt: parsed.stats.recordCount });
    stages = stageSet(stages, 'extract', 'done', { komponent: parsed.components.length });
    stages = stageSet(stages, 'size', 'done', { boyutlu: parsed.components.filter(c => c.s1 != null).length });
    const lines = new Set(parsed.components.map(c => c.line).filter(line => line && line !== '?'));
    stages = stageSet(stages, 'lines', 'done', { hat: lines.size });
    stages = stageSet(stages, 'rules', 'active');
    await updateRunMeta(scope, run.id, { progress: stages });

    const output = applyRules(parsed, rules);
    const analysis = localExtractionQuality(parsed, output);
    const main = output.rows.filter(row => row.scope === 'MAIN');
    stages = stageSet(stages, 'rules', 'done', appliedName
      ? { satır: main.length, 'boru m': +output.totals.pipeM.toFixed(1), profil: appliedName.slice(0, 24) }
      : { satır: main.length, 'boru m': +output.totals.pipeM.toFixed(1) });
    stages = stageSet(stages, 'steel', 'done', output.steel.length
      ? { profil: output.steel.length, kg: +output.totals.steelKg.toFixed(0) }
      : { profil: 0 });
    await saveRows(scope, run.id, output.rows);
    await saveSteel(scope, run.id, output.steel);

    stages = stageSet(stages, 'audit', 'active');
    await updateRunMeta(scope, run.id, { progress: stages });
    const complexity = computeComplexity({
      fileMb: run.fileSize / 1e6,
      components: parsed.components.length,
      distinctClasses: new Set(parsed.components.map(component => component.klass)).size,
      lines: lines.size,
      unknownSizeRatio: main.length ? main.filter(row => row.s1 == null).length / main.length : 0,
      steelMembers: parsed.steelMembers.length,
      fastenerCount: parsed.fasteners.gaskets + parsed.fasteners.boltSets + parsed.fasteners.stubEnds,
    });
    const ai = aiEnabled
      ? await runAudit({ rows: output.rows, steel: output.steel, fasteners: parsed.fasteners,
        vocab: rules.vocab, fileName: run.fileName, complexity, lang })
      : null;
    const criticals = ai?.findings.filter(finding => finding.severity === 'critical').length ?? 0;
    const warnings = ai?.findings.filter(finding => finding.severity === 'warn').length ?? 0;
    stages = stageSet(stages, 'audit', 'done', ai
      ? { seviye: ai.tier, kritik: criticals, uyarı: warnings }
      : { durum: 'atlandı' });
    stages = stageSet(stages, 'finalize', 'done', { sn: +((Date.now() - t0) / 1000).toFixed(1) });
    await updateRunMeta(scope, run.id, {
      progress: stages, ai, status: 'done', totals: output.totals, fasteners: parsed.fasteners,
      analysis,
    });
    await notify(scope, run, lang, 'run_done', lang === 'tr'
      ? `${main.length} satır · boru ${output.totals.pipeM.toFixed(1)} m${criticals ? ` · ${criticals} kritik bulgu` : ''}`
      : `${main.length} rows · pipe ${output.totals.pipeM.toFixed(1)} m${criticals ? ` · ${criticals} critical finding(s)` : ''}`);
    return phase('done', true);
  } catch (error) {
    console.error('durable local processing failed', error);
    const message = error instanceof Error ? error.message : 'işleme hatası';
    return failRun(scope, run, lang, message, stages);
  }
}

function extractionQuality(output: ReturnType<typeof extractFromApsProps>): ExtractionQuality {
  return {
    family: output.family,
    quality: output.quality,
    confidence: output.confidence,
    // Structured APS properties prove where values came from, not that this
    // model family clears the independent >=90 answer-workbook benchmark.
    releaseEligible: false,
    coverage: output.coverage,
    provenance: output.provenance.map(value => ({
      extractor: value.extractor,
      objects: value.objects,
      rows: value.rows,
      candidates: value.candidates,
      confidence: value.confidence,
      limitations: value.limitations,
    })),
    candidates: output.candidates.slice(0, 200).map(candidate => ({
      kind: candidate.kind,
      code: candidate.code,
      label: candidate.label,
      count: candidate.count,
      s1: candidate.s1,
      s2: candidate.s2,
      ...(candidate.lengthM !== undefined ? { lengthM: candidate.lengthM } : {}),
      ...(candidate.weightKg !== undefined ? { weightKg: candidate.weightKg } : {}),
      confidence: candidate.confidence,
    })),
  };
}

/** One durable APS tick. The heavy property stream starts only after DB claim. */
export async function advanceApsRun(
  scope: AccessScope,
  id: string,
  lang: 'tr' | 'en',
): Promise<RunWorkflowPhase> {
  const run = await getRun(scope, id);
  if (!run || run.status !== 'processing' || !run.aps) return phase('noop', true);
  let stages = run.progress ?? freshStages();
  const deadline = new Date(run.createdAt).getTime() + 60 * 60 * 1000;
  if (!Number.isFinite(deadline) || Date.now() >= deadline) {
    const message = lang === 'tr'
      ? 'Bulut çevirisi bir saat içinde tamamlanmadı; güvenli biçimde durduruldu.'
      : 'Cloud translation did not complete within one hour and was stopped safely.';
    return failRun(scope, run, lang, message, stages);
  }
  try {
    const manifest = await apsManifestPhase(run.aps.urn, run.aps.guid);
    if (manifest.phase === 'translating') {
      stages = stageSet(stages, 'scan', 'active', { bulut: `Autodesk çevirisi ${manifest.progress || 'sürüyor'}` });
      await updateRunMeta(scope, id, { progress: stages });
      return phase('translating', false, { waitSeconds: 10 });
    }
    if (manifest.phase === 'failed') {
      if (!run.aps.retriedAt && await apsRetryTranslate(run.aps.urn).catch(() => false)) {
        await updateRunMeta(scope, id, {
          aps: { ...run.aps, retriedAt: new Date().toISOString() },
          progress: stageSet(stages, 'scan', 'active', { bulut: 'çeviri otomatik yeniden denendi' }),
        });
        return phase('retry', false, { waitSeconds: 15 });
      }
      return failRun(scope, run, lang, manifest.message, stages);
    }

    const aps = run.aps.guid === manifest.guid ? run.aps : { ...run.aps, guid: manifest.guid };
    if (aps !== run.aps) await updateRunMeta(scope, id, { aps });
    // Claim precedes the expensive property request. Ten minutes covers the
    // largest verified stream while avoiding a permanently wedged lock.
    if (!await claimApsRun(scope, id, 10 * 60_000)) {
      return phase('busy', false, { waitSeconds: 15 });
    }

    const propertyState = await apsFetchProperties(aps.urn, manifest.guid);
    if (propertyState.phase === 'extracting') {
      await updateRunMeta(scope, id, {
        aps: { ...aps, guid: propertyState.guid, claimedUntil: new Date(0).toISOString() },
        progress: stageSet(stages, 'scan', 'active', { bulut: 'özellik veritabanı hazırlanıyor' }),
      });
      return phase('extracting', false, { waitSeconds: 10 });
    }
    if (propertyState.phase === 'failed') {
      const transient = /properties\s+(?:408|409|425|429|5\d\d)|geçici|timeout/i.test(propertyState.message);
      if (transient) {
        await updateRunMeta(scope, id, { aps: { ...aps, claimedUntil: new Date(0).toISOString() } });
        return phase('retry', false, { waitSeconds: 20, message: propertyState.message });
      }
      return failRun(scope, run, lang, propertyState.message, stages);
    }

    const selection = await resolveRules(scope, run, 'aps');
    if (selection.appliedId !== run.calibrationId || selection.snapshot !== run.calibrationSnapshot) {
      run.calibrationId = selection.appliedId;
      run.calibrationSnapshot = selection.snapshot;
      await updateRunMeta(scope, id, {
        calibrationId: selection.appliedId,
        calibrationSnapshot: selection.snapshot,
      });
    }
    const output = extractFromApsProps(propertyState.collection, selection.rules, propertyState.totalCount);
    const analysis = extractionQuality(output);
    const finalAps = { ...aps, claimedUntil: new Date(0).toISOString(), analysis };
    if (output.quality === 'none') {
      await updateRunMeta(scope, id, { aps: finalAps });
      const message = lang === 'tr'
        ? 'Modelde güvenilir yapısal MTO kanıtı bulunamadı; geometriye bakarak miktar uydurulmadı.'
        : 'No reliable structured MTO evidence was found; quantities were not inferred from geometry.';
      return failRun(scope, { ...run, aps: finalAps }, lang, message, stages);
    }

    const familyLabel = output.family.replace(/-/g, ' ');
    stages = stageSet(stages, 'scan', 'done', { bulut: familyLabel, obje: output.totalCount });
    stages = stageSet(stages, 'extract', 'done', {
      komponent: output.structuredCount,
      aday: output.coverage.candidateObjects,
    });
    stages = stageSet(stages, 'size', 'done', { boyutlu: output.rows.filter(row => row.s1 != null).length });
    stages = stageSet(stages, 'lines', 'done', { hat: output.lineCount });
    const main = output.rows.filter(row => row.scope === 'MAIN');
    stages = stageSet(stages, 'rules', 'done', selection.appliedName
      ? { satır: main.length, 'boru m': +output.totals.pipeM.toFixed(1), profil: selection.appliedName.slice(0, 24) }
      : { satır: main.length, 'boru m': +output.totals.pipeM.toFixed(1) });
    stages = stageSet(stages, 'steel', 'done', { aday: output.candidates.filter(value => value.kind === 'steel-profile').length });
    await saveRows(scope, id, output.rows);
    await saveSteel(scope, id, []);
    await putRunArtifact(scope, id, 'objectmap.json', output.objectMap).catch(error => console.error('objectmap write failed', error));
    await putRunArtifact(scope, id, 'candidates.json', output.candidates).catch(error => console.error('candidate artifact write failed', error));

    stages = stageSet(stages, 'audit', 'active');
    await updateRunMeta(scope, id, { progress: stages, aps: finalAps });
    const complexity = computeComplexity({
      fileMb: run.fileSize / 1e6,
      components: output.structuredCount,
      distinctClasses: new Set(output.rows.map(row => row.code)).size,
      lines: output.lineCount,
      unknownSizeRatio: main.length ? main.filter(row => row.s1 == null).length / main.length : 0,
      steelMembers: 0,
      fastenerCount: output.fasteners.gaskets + output.fasteners.boltSets + output.fasteners.stubEnds,
    });
    const ai = aiEnabled && output.rows.length
      ? await runAudit({ rows: output.rows, steel: [], fasteners: output.fasteners,
        vocab: selection.rules.vocab, fileName: run.fileName, complexity, lang })
      : null;
    stages = stageSet(stages, 'audit', 'done', ai
      ? { seviye: ai.tier, kritik: ai.findings.filter(finding => finding.severity === 'critical').length }
      : { durum: output.quality === 'partial' ? 'insan doğrulaması gerekli' : 'atlandı' });
    stages = stageSet(stages, 'finalize', 'done', {
      güven: Math.round(output.confidence * 100),
      durum: analysis.releaseEligible ? 'teklif adayı' : 'doğrulama gerekli',
    });
    await updateRunMeta(scope, id, {
      progress: stages, ai, status: 'done', totals: output.totals,
      fasteners: output.fasteners, aps: finalAps, analysis,
    });
    const review = !analysis.releaseEligible;
    await notify(scope, run, lang, 'run_done', lang === 'tr'
      ? review
        ? `${output.rows.length} satır · ${output.coverage.candidateObjects} aday · cevap Excel’iyle doğrulama gerekli`
        : `${main.length} satır · boru ${output.totals.pipeM.toFixed(1)} m (bulut/${familyLabel})`
      : review
        ? `${output.rows.length} rows · ${output.coverage.candidateObjects} candidates · answer validation required`
        : `${main.length} rows · pipe ${output.totals.pipeM.toFixed(1)} m (cloud/${familyLabel})`);
    return phase(review ? 'review' : 'done', true);
  } catch (error) {
    // Ağ/APS kesintisi terminal değildir; Workflow aynı durable adımı tekrarlar.
    console.error('durable APS tick failed', error);
    const fresh = await getRun(scope, id);
    if (fresh?.aps) {
      await updateRunMeta(scope, id, {
        aps: { ...fresh.aps, claimedUntil: new Date(0).toISOString() },
      }).catch(() => undefined);
    }
    return phase('retry', false, {
      waitSeconds: 20,
      message: error instanceof Error ? error.message.slice(0, 200) : 'APS geçici hata',
    });
  }
}

export async function expireRunWorkflow(
  scope: AccessScope,
  id: string,
  lang: 'tr' | 'en',
): Promise<RunWorkflowPhase> {
  const run = await getRun(scope, id);
  if (!run || run.status !== 'processing') return phase('noop', true);
  const message = lang === 'tr'
    ? 'Bulut çevirisi bir saat içinde tamamlanmadı; güvenli biçimde durduruldu.'
    : 'Cloud translation did not complete within one hour and was stopped safely.';
  return failRun(scope, run, lang, message, run.progress ?? freshStages());
}
