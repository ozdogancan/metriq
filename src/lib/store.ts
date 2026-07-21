// Metriq — depolama katmanı: Supabase (prod) veya yerel JSON (dev fallback)
import 'server-only';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AnswerDiff, CalibrationRules, Run, RunTotals, MtoRow, SteelRow, Calibration } from './types';
import { isPg, kvGet, kvSet, kvDel, kvList, pgPutFile, pgGetFile, pgDelFiles } from './store-pg';
import { isSafeNwdFileName, isUuid, storageKeyName } from './upload-policy';

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_BUCKET || 'models';
const REST_PAGE_SIZE = 100;
const MAX_RESULT_ROWS = 10_000;

export const isSupabase = Boolean(SB_URL && SB_KEY);

export interface AccessScope {
  tenantKey: string;
  userKey: string;
}

const SCOPE_KEY_RE = /^(?:legacy-default|[0-9a-f]{64})$/;

function assertScope(scope: AccessScope): AccessScope {
  if (!scope || !SCOPE_KEY_RE.test(scope.tenantKey) || !/^[0-9a-f]{64}$/.test(scope.userKey)) {
    throw new Error('invalid tenant scope');
  }
  return scope;
}

function scopedName(scope: AccessScope, name: string): string {
  assertScope(scope);
  return `tenant-${scope.tenantKey}-${name}`;
}

function isSafeStorageKey(key: unknown): key is string {
  if (typeof key !== 'string') return false;
  const slash = key.indexOf('/');
  return slash > 0
    && key.indexOf('/', slash + 1) < 0
    && isUuid(key.slice(0, slash))
    && isSafeNwdFileName(key.slice(slash + 1));
}

let sb: SupabaseClient | null = null;
function client(): SupabaseClient {
  if (!sb) sb = createClient(SB_URL!, SB_KEY!, { auth: { persistSession: false } });
  return sb;
}

// ---------- Yerel dosya sürücüsü (dev; Vercel'de /tmp = geçici, Supabase gelene dek) ----------
const DATA_DIR = process.env.VERCEL
  ? path.join('/tmp', 'metriq-data')
  : path.join(process.cwd(), '.data');
async function readJson<T>(name: string, fallback: T): Promise<T> {
  if (isPg) return (await kvGet<T>(name)) ?? fallback;
  try { return JSON.parse(await fs.readFile(path.join(DATA_DIR, name), 'utf8')) as T; }
  catch { return fallback; }
}
async function writeJson(name: string, data: unknown) {
  if (isPg) { await kvSet(name, data); return; }
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(DATA_DIR, name), JSON.stringify(data, null, 1), 'utf8');
}

// ---------- Runs ----------
export async function listRuns(scope: AccessScope): Promise<Run[]> {
  assertScope(scope);
  if (isSupabase) {
    const { data, error } = await client().from('runs').select('*')
      .eq('tenant_key', scope.tenantKey).order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    return (data ?? []).map(dbRun);
  }
  // pg: her run kendi anahtarında — eşzamanlı yüklemelerde yarış yok
  if (isPg) {
    const runs = await kvList<Run>(scopedName(scope, 'run-'));
    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
  }
  const runs = await readJson<Run[]>(scopedName(scope, 'runs.json'), []);
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getRun(scope: AccessScope, id: string): Promise<Run | null> {
  assertScope(scope);
  if (isSupabase) {
    const { data, error } = await client().from('runs').select('*')
      .eq('tenant_key', scope.tenantKey).eq('id', id).maybeSingle();
    if (error) throw error;
    return data ? dbRun(data) : null;
  }
  if (isPg) return kvGet<Run>(scopedName(scope, `run-${id}`));
  return (await readJson<Run[]>(scopedName(scope, 'runs.json'), [])).find(r => r.id === id) ?? null;
}

export async function saveRun(scope: AccessScope, run: Run): Promise<void> {
  assertScope(scope);
  if (isSupabase) {
    const payload: Record<string, unknown> = {
      tenant_key: scope.tenantKey, created_by_key: scope.userKey,
      id: run.id, project_name: run.projectName, file_name: run.fileName, file_size: run.fileSize,
      vocab: run.vocab, calibration_id: run.calibrationId, status: run.status, error: run.error ?? null,
      calibration_snapshot: run.calibrationSnapshot ?? null,
      totals: run.totals, fasteners: run.fasteners, progress: run.progress ?? [], ai: run.ai ?? null,
      answer: run.answer ?? null, analysis: run.analysis ?? null, created_at: run.createdAt,
    };
    if (run.rowRevision !== undefined) payload.row_revision = run.rowRevision;
    if (run.rowsHash !== undefined) payload.rows_hash = run.rowsHash;
    if (run.comparisonRevision !== undefined) payload.comparison_revision = run.comparisonRevision;
    if (run.aps !== undefined) payload.aps = run.aps;
    // Global UUID PK üzerinde upsert tenant anahtarını başka kayda taşıyabilirdi.
    // Önce yalnız aynı tenant kaydını güncelle; yoksa INSERT et ve olası PK
    // çakışmasını güvenli biçimde hata olarak bırak.
    const updatePayload = { ...payload };
    delete updatePayload.tenant_key;
    delete updatePayload.created_by_key;
    const { data: updated, error: updateError } = await client().from('runs').update(updatePayload)
      .eq('tenant_key', scope.tenantKey).eq('id', run.id).select('id');
    if (updateError) throw updateError;
    if ((updated ?? []).length === 0) {
      const { error: insertError } = await client().from('runs').insert(payload);
      if (insertError) throw insertError;
    }
    return;
  }
  if (isPg) { await kvSet(scopedName(scope, `run-${run.id}`), run); return; }
  const localName = scopedName(scope, 'runs.json');
  const runs = await readJson<Run[]>(localName, []);
  const i = runs.findIndex(r => r.id === run.id);
  if (i >= 0) runs[i] = run; else runs.push(run);
  await writeJson(localName, runs);
}

export async function deleteRun(scope: AccessScope, id: string): Promise<void> {
  assertScope(scope);
  const run = await getRun(scope, id);
  if (!run) return;
  if (isSupabase) {
    if (!isSafeNwdFileName(run.fileName)) throw new Error('unsafe storage key');
    const path = `${id}/${storageKeyName(run.fileName)}`;
    // Postgres deletes the run (children cascade) and records the object path
    // in one transaction. Storage is external, so its cleanup is acknowledged
    // only after success and otherwise remains retryable in the outbox.
    const { error } = await client().rpc('delete_run_and_queue_storage_v2', {
      p_tenant_key: scope.tenantKey,
      p_run_id: id,
      p_path: path,
    });
    if (error) throw error;
    try { await drainStorageCleanup(scope, 5); }
    catch (cleanupError) { console.error('storage cleanup queued for retry', cleanupError); }
    return;
  }
  if (isPg) {
    await kvDel(scopedName(scope, `run-${id}`));
    await kvDel(scopedName(scope, `rows-${id}.json`));
    await kvDel(scopedName(scope, `steel-${id}.json`));
    await pgDelFiles(`${id}/`);
    return;
  }
  const localName = scopedName(scope, 'runs.json');
  await writeJson(localName, (await readJson<Run[]>(localName, [])).filter(r => r.id !== id));
  try { await fs.unlink(path.join(DATA_DIR, scopedName(scope, `rows-${id}.json`))); } catch {}
  try { await fs.unlink(path.join(DATA_DIR, scopedName(scope, `steel-${id}.json`))); } catch {}
}

// ---------- Rows ----------
export async function getRows(scope: AccessScope, runId: string): Promise<MtoRow[]> {
  assertScope(scope);
  if (isSupabase) {
    const all: Record<string, unknown>[] = [];
    for (let from = 0; from < MAX_RESULT_ROWS; from += REST_PAGE_SIZE) {
      const { data, error } = await client().from('mto_rows').select('*')
        .eq('tenant_key', scope.tenantKey).eq('run_id', runId).order('idx').order('id')
        .range(from, from + REST_PAGE_SIZE - 1);
      if (error) throw error;
      all.push(...((data ?? []) as Record<string, unknown>[]));
      if ((data?.length ?? 0) < REST_PAGE_SIZE) break;
      if (from + REST_PAGE_SIZE >= MAX_RESULT_ROWS) throw new Error('mto row safety limit exceeded');
    }
    return all.map((r: Record<string, unknown>) => ({
      id: r.id as string, line: r.line as string, code: r.code as string, sub: (r.sub as string) ?? '',
      s1: r.s1 as number | null, s2: (r.s2 as number) ?? 0, qty: Number(r.qty), unit: r.unit as 'M' | 'EA',
      remark: (r.remark as string) ?? '', scope: r.scope as 'MAIN' | 'INFO', edited: Boolean(r.edited),
    }));
  }
  return readJson<MtoRow[]>(scopedName(scope, `rows-${runId}.json`), []);
}

export async function saveRows(scope: AccessScope, runId: string, rows: MtoRow[]): Promise<void> {
  assertScope(scope);
  if (isSupabase) {
    const payload = rows.map((r, idx) => ({
      id: r.id, idx, line: r.line, code: r.code, sub: r.sub,
      s1: r.s1, s2: r.s2, qty: r.qty, unit: r.unit, remark: r.remark, scope: r.scope, edited: r.edited ?? false,
    }));
    // replace_mto_rows RPC satırlarla birlikte row_revision+1, rows_hash=null,
    // answer=null invalidasyonunu da atomik yapar
    const { error } = await client().rpc('replace_mto_rows_v2', {
      p_tenant_key: scope.tenantKey, p_run_id: runId, p_rows: payload,
    });
    if (error) throw error;
    return;
  }
  await writeJson(scopedName(scope, `rows-${runId}.json`), rows);
  // Supabase-dışı modlar da RPC ile AYNI invalidasyon semantiğini uygular —
  // yoksa bayat cevap karşılaştırmaları satır düzenlemesinden sonra geçerli kalırdı.
  const run = isPg
    ? await kvGet<Run>(scopedName(scope, `run-${runId}`))
    : (await readJson<Run[]>(scopedName(scope, 'runs.json'), [])).find(r => r.id === runId);
  if (run) {
    const bumped: Run = { ...run, rowRevision: (run.rowRevision ?? 0) + 1, rowsHash: null, answer: null };
    if (isPg) await kvSet(scopedName(scope, `run-${runId}`), bumped);
    else {
      const localName = scopedName(scope, 'runs.json');
      const runs = await readJson<Run[]>(localName, []);
      const i = runs.findIndex(r => r.id === runId);
      if (i >= 0) { runs[i] = bumped; await writeJson(localName, runs); }
    }
  }
}

export async function getSteel(scope: AccessScope, runId: string): Promise<SteelRow[]> {
  assertScope(scope);
  if (isSupabase) {
    const all: Record<string, unknown>[] = [];
    for (let from = 0; from < MAX_RESULT_ROWS; from += REST_PAGE_SIZE) {
      const { data, error } = await client().from('steel_rows').select('*')
        .eq('tenant_key', scope.tenantKey).eq('run_id', runId).order('length_mm', { ascending: false }).order('id')
        .range(from, from + REST_PAGE_SIZE - 1);
      if (error) throw error;
      all.push(...((data ?? []) as Record<string, unknown>[]));
      if ((data?.length ?? 0) < REST_PAGE_SIZE) break;
      if (from + REST_PAGE_SIZE >= MAX_RESULT_ROWS) throw new Error('steel row safety limit exceeded');
    }
    return all.map((r: Record<string, unknown>) => ({
      id: r.id as string, profile: r.profile as string, lengthMm: Number(r.length_mm),
      count: Number(r.count), totalKg: Number(r.total_kg),
    }));
  }
  return readJson<SteelRow[]>(scopedName(scope, `steel-${runId}.json`), []);
}

export async function saveSteel(scope: AccessScope, runId: string, rows: SteelRow[]): Promise<void> {
  assertScope(scope);
  if (isSupabase) {
    const payload = rows.map(r => ({
      id: r.id, profile: r.profile, length_mm: r.lengthMm, count: r.count, total_kg: r.totalKg,
    }));
    const { error } = await client().rpc('replace_steel_rows_v2', {
      p_tenant_key: scope.tenantKey, p_run_id: runId, p_rows: payload,
    });
    if (error) throw error;
    return;
  }
  await writeJson(scopedName(scope, `steel-${runId}.json`), rows);
}

// ---------- Calibrations ----------
export type CalibrationStatus = 'draft' | 'active' | 'archived';
export type CalibrationModelFamily = 'plant3d-local' | 'aps' | 'legacy';
export type ScopedCalibration = Calibration & {
  modelFamily: CalibrationModelFamily;
  clientKey: string;
  status: CalibrationStatus;
};

export interface CalibrationFilter {
  vocab?: Calibration['rules']['vocab'];
  modelFamily?: CalibrationModelFamily;
  clientKey?: string;
  status?: CalibrationStatus;
}

function calibrationScope(cal: Calibration & Partial<ScopedCalibration>): Pick<ScopedCalibration, 'modelFamily' | 'clientKey' | 'status'> {
  const modelFamily = cal.modelFamily ?? 'legacy';
  const clientKey = cal.clientKey?.trim().toLowerCase() || 'default';
  const status = cal.status ?? 'active';
  if (!['plant3d-local', 'aps', 'legacy'].includes(modelFamily)
    || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(clientKey)
    || !['draft', 'active', 'archived'].includes(status)) {
    throw new Error('invalid calibration scope');
  }
  return { modelFamily, clientKey, status };
}

export async function listCalibrations(scope: AccessScope, filter: CalibrationFilter = {}): Promise<ScopedCalibration[]> {
  assertScope(scope);
  if (isSupabase) {
    let query = client().from('calibrations').select('*').eq('tenant_key', scope.tenantKey);
    if (filter.vocab) query = query.eq('rules->>vocab', filter.vocab);
    if (filter.modelFamily) query = query.eq('model_family', filter.modelFamily);
    if (filter.clientKey) query = query.eq('client_key', filter.clientKey);
    if (filter.status) query = query.eq('status', filter.status);
    else query = query.neq('status', 'archived');
    const { data, error } = await query.order('updated_at', { ascending: false }).limit(500);
    if (error) throw error;
    return (data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string, name: r.name as string, rules: r.rules as Calibration['rules'],
      learnedFrom: (r.learned_from as string[]) ?? [], createdAt: r.created_at as string, updatedAt: r.updated_at as string,
      version: Number(r.version ?? 1),
      modelFamily: r.model_family as CalibrationModelFamily,
      clientKey: r.client_key as string,
      status: r.status as CalibrationStatus,
    }));
  }
  const all = await readJson<ScopedCalibration[]>(scopedName(scope, 'calibrations.json'), []);
  return all.filter(cal => (!filter.vocab || cal.rules.vocab === filter.vocab)
    && (!filter.modelFamily || cal.modelFamily === filter.modelFamily)
    && (!filter.clientKey || cal.clientKey === filter.clientKey)
    && (filter.status ? cal.status === filter.status : cal.status !== 'archived'));
}

export async function getCalibration(scope: AccessScope, id: string): Promise<ScopedCalibration | null> {
  assertScope(scope);
  if (isSupabase) {
    const { data, error } = await client().from('calibrations').select('*')
      .eq('tenant_key', scope.tenantKey).eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      id: data.id as string, name: data.name as string, rules: data.rules as Calibration['rules'],
      learnedFrom: (data.learned_from as string[]) ?? [], createdAt: data.created_at as string,
      updatedAt: data.updated_at as string, version: Number(data.version ?? 1),
      modelFamily: data.model_family as CalibrationModelFamily,
      clientKey: data.client_key as string, status: data.status as CalibrationStatus,
    };
  }
  return (await listCalibrations(scope)).find(cal => cal.id === id) ?? null;
}

export async function findLatestCalibration(
  scope: AccessScope,
  filter: Required<Pick<CalibrationFilter, 'vocab' | 'modelFamily' | 'clientKey'>>,
): Promise<ScopedCalibration | null> {
  return (await listCalibrations(scope, { ...filter, status: 'active' }))[0] ?? null;
}

export async function saveCalibration(
  scope: AccessScope,
  cal: Calibration & Partial<ScopedCalibration>,
  expectedVersion: number,
  actor: string,
): Promise<ScopedCalibration> {
  assertScope(scope);
  const calScope = calibrationScope(cal);
  if (isSupabase) {
    const { data, error } = await client().rpc('save_calibration_version_v2', {
      p_tenant_key: scope.tenantKey,
      p_user_key: scope.userKey,
      p_calibration_id: cal.id,
      p_expected_version: expectedVersion,
      p_name: cal.name,
      p_rules: cal.rules,
      p_learned_from: cal.learnedFrom,
      p_actor_label: actor,
      p_model_family: calScope.modelFamily,
      p_client_key: calScope.clientKey,
      p_status: calScope.status,
    });
    if (error) throw error;
    return { ...cal, ...calScope, version: Number((data as { version?: number } | null)?.version ?? expectedVersion + 1) };
  }
  const localName = scopedName(scope, 'calibrations.json');
  const cals = await readJson<ScopedCalibration[]>(localName, []);
  const i = cals.findIndex(c => c.id === cal.id);
  const actualVersion = i >= 0 ? (cals[i].version ?? 1) : 0;
  if (actualVersion !== expectedVersion) throw new Error('PROFILE_VERSION_CONFLICT');
  const saved: ScopedCalibration = { ...cal, ...calScope, version: actualVersion + 1 };
  if (i >= 0) cals[i] = saved; else cals.push(saved);
  await writeJson(localName, cals);
  return saved;
}

export async function deleteCalibration(scope: AccessScope, id: string, expectedVersion: number, actor: string): Promise<void> {
  assertScope(scope);
  if (isSupabase) {
    const { error } = await client().rpc('archive_calibration_v2', {
      p_tenant_key: scope.tenantKey,
      p_user_key: scope.userKey,
      p_calibration_id: id,
      p_expected_version: expectedVersion,
      p_actor_label: actor,
    });
    if (error) throw error;
    return;
  }
  const localName = scopedName(scope, 'calibrations.json');
  await writeJson(localName, (await readJson<ScopedCalibration[]>(localName, [])).filter(c => c.id !== id));
}

export interface AnswerComparisonRecord {
  id: string;
  runId: string;
  baseRowRevision: number;
  baseRowsHash: string;
  answerSha256: string;
  sourceFileName: string;
  sourceSheet: string;
  diff: AnswerDiff;
  createdBy: string;
}

export async function recordAnswerComparison(scope: AccessScope, input: AnswerComparisonRecord & {
  expectedComparisonRevision: number;
  learningEventId: string;
}): Promise<void> {
  assertScope(scope);
  if (isSupabase) {
    const { error } = await client().rpc('record_answer_comparison_v2', {
      p_tenant_key: scope.tenantKey,
      p_user_key: scope.userKey,
      p_run_id: input.runId,
      p_comparison_id: input.id,
      p_expected_row_revision: input.baseRowRevision,
      p_expected_comparison_revision: input.expectedComparisonRevision,
      p_base_rows_hash: input.baseRowsHash,
      p_answer_sha256: input.answerSha256,
      p_source_file_name: input.sourceFileName,
      p_source_sheet: input.sourceSheet,
      p_diff: input.diff,
      p_actor_label: input.createdBy,
      p_learning_event_id: input.learningEventId,
    });
    if (error) throw error;
    return;
  }
  const run = await getRun(scope, input.runId);
  if (!run) throw new Error('run not found');
  if ((run.rowRevision ?? 0) !== input.baseRowRevision
    || (run.comparisonRevision ?? 0) !== input.expectedComparisonRevision
    || (run.rowsHash && run.rowsHash !== input.baseRowsHash)) {
    throw new Error('RUN_REVISION_CONFLICT');
  }
  const localName = scopedName(scope, 'answer-comparisons.json');
  const all = await readJson<AnswerComparisonRecord[]>(localName, []);
  const existing = all.find(value => value.id === input.id);
  if (existing && JSON.stringify(existing.diff) !== JSON.stringify(input.diff)) {
    throw new Error('COMPARISON_ID_REUSED');
  }
  if (!existing) {
    all.push(input);
    await writeJson(localName, all);
  }
  run.answer = input.diff;
  run.rowsHash = input.baseRowsHash;
  run.comparisonRevision = (run.comparisonRevision ?? 0) + 1;
  await saveRun(scope, run);
}

export async function getAnswerComparison(scope: AccessScope, id: string): Promise<AnswerComparisonRecord | null> {
  assertScope(scope);
  if (isSupabase) {
    const { data, error } = await client().from('answer_comparisons').select('*')
      .eq('tenant_key', scope.tenantKey).eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      id: data.id as string,
      runId: data.run_id as string,
      baseRowRevision: Number(data.base_row_revision),
      baseRowsHash: data.base_rows_hash as string,
      answerSha256: data.answer_sha256 as string,
      sourceFileName: data.source_file_name as string,
      sourceSheet: data.source_sheet as string,
      diff: data.diff as AnswerDiff,
      createdBy: data.created_by as string,
    };
  }
  return (await readJson<AnswerComparisonRecord[]>(scopedName(scope, 'answer-comparisons.json'), []))
    .find(value => value.id === id) ?? null;
}

export interface ApplyAnswerCalibrationInput {
  runId: string;
  comparisonId: string;
  commitId: string;
  requestHash: string;
  expectedRowRevision: number;
  expectedProfileVersion: number;
  calibrationId: string;
  calibrationName: string;
  rules: CalibrationRules;
  learnedFrom: string[];
  decisions: unknown[];
  rows: MtoRow[];
  rowsAfterHash: string;
  totals: RunTotals;
  answerAfter: AnswerDiff;
  metricsAfter: Record<string, unknown>;
  actor: string;
  learningEventId: string;
  calibrationModelFamily?: CalibrationModelFamily;
  calibrationClientKey?: string;
  calibrationStatus?: CalibrationStatus;
}

export interface ApplyAnswerCalibrationResult {
  commitId: string;
  calibrationId: string;
  calibrationVersion: number;
  rowRevision: number;
  answer: AnswerDiff;
  idempotent: boolean;
}

export async function getCalibrationCommitResult(
  scope: AccessScope,
  commitId: string,
  requestHash: string,
  runId: string,
): Promise<ApplyAnswerCalibrationResult | null> {
  assertScope(scope);
  if (isSupabase) {
    const { data, error } = await client().from('calibration_commits').select('*')
      .eq('tenant_key', scope.tenantKey).eq('id', commitId).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    if (data.request_hash !== requestHash || data.run_id !== runId) throw new Error('IDEMPOTENCY_KEY_REUSED');
    const run = await getRun(scope, runId);
    if (!run) throw new Error('run not found');
    return {
      commitId,
      calibrationId: data.calibration_id as string,
      calibrationVersion: Number(data.new_profile_version),
      rowRevision: Number(data.new_row_revision),
      answer: run.answer!,
      idempotent: true,
    };
  }
  const commits = await readJson<Array<ApplyAnswerCalibrationInput & { result: ApplyAnswerCalibrationResult }>>(
    scopedName(scope, 'calibration-commits.json'), [],
  );
  const existing = commits.find(value => value.commitId === commitId);
  if (!existing) return null;
  if (existing.requestHash !== requestHash || existing.runId !== runId) throw new Error('IDEMPOTENCY_KEY_REUSED');
  return { ...existing.result, idempotent: true };
}

export async function applyAnswerCalibration(scope: AccessScope, input: ApplyAnswerCalibrationInput): Promise<ApplyAnswerCalibrationResult> {
  assertScope(scope);
  const payloadRows = input.rows.map((row, idx) => ({
    id: row.id, idx, line: row.line, code: row.code, sub: row.sub,
    s1: row.s1, s2: row.s2, qty: row.qty, unit: row.unit,
    remark: row.remark, scope: row.scope, edited: row.edited ?? false,
  }));
  if (isSupabase) {
    const { data, error } = await client().rpc('apply_answer_calibration_v2', {
      p_tenant_key: scope.tenantKey,
      p_user_key: scope.userKey,
      p_run_id: input.runId,
      p_comparison_id: input.comparisonId,
      p_commit_id: input.commitId,
      p_request_hash: input.requestHash,
      p_expected_row_revision: input.expectedRowRevision,
      p_expected_profile_version: input.expectedProfileVersion,
      p_calibration_id: input.calibrationId,
      p_calibration_name: input.calibrationName,
      p_rules: input.rules,
      p_learned_from: input.learnedFrom,
      p_decisions: input.decisions,
      p_rows: payloadRows,
      p_rows_after_hash: input.rowsAfterHash,
      p_totals: input.totals,
      p_answer_after: input.answerAfter,
      p_metrics_after: input.metricsAfter,
      p_actor_label: input.actor,
      p_learning_event_id: input.learningEventId,
      p_model_family: input.calibrationModelFamily ?? 'legacy',
      p_client_key: input.calibrationClientKey ?? 'default',
      p_status: input.calibrationStatus ?? 'active',
    });
    if (error) throw error;
    return data as ApplyAnswerCalibrationResult;
  }

  const commitsName = scopedName(scope, 'calibration-commits.json');
  const commits = await readJson<Array<ApplyAnswerCalibrationInput & { result: ApplyAnswerCalibrationResult }>>(commitsName, []);
  const existingCommit = commits.find(value => value.commitId === input.commitId);
  if (existingCommit) {
    if (existingCommit.requestHash !== input.requestHash) throw new Error('IDEMPOTENCY_KEY_REUSED');
    return { ...existingCommit.result, idempotent: true };
  }
  const run = await getRun(scope, input.runId);
  const comparison = await getAnswerComparison(scope, input.comparisonId);
  if (!run || !comparison || comparison.runId !== input.runId) throw new Error('comparison not found');
  if ((run.rowRevision ?? 0) !== input.expectedRowRevision
    || run.rowsHash !== comparison.baseRowsHash || run.answer?.id !== input.comparisonId) {
    throw new Error('COMPARISON_STALE');
  }
  const calsName = scopedName(scope, 'calibrations.json');
  const cals = await readJson<ScopedCalibration[]>(calsName, []);
  const index = cals.findIndex(value => value.id === input.calibrationId);
  const actualVersion = index >= 0 ? (cals[index].version ?? 1) : 0;
  if (actualVersion !== input.expectedProfileVersion) throw new Error('PROFILE_VERSION_CONFLICT');
  const now = new Date().toISOString();
  const calibration: ScopedCalibration = {
    id: input.calibrationId,
    name: input.calibrationName,
    rules: input.rules,
    learnedFrom: input.learnedFrom,
    version: actualVersion + 1,
    createdAt: index >= 0 ? cals[index].createdAt : now,
    updatedAt: now,
    modelFamily: input.calibrationModelFamily ?? 'legacy',
    clientKey: input.calibrationClientKey ?? 'default',
    status: input.calibrationStatus ?? 'active',
  };
  if (index >= 0) cals[index] = calibration; else cals.push(calibration);
  await writeJson(scopedName(scope, `rows-${input.runId}.json`), input.rows);
  await writeJson(calsName, cals);
  run.totals = input.totals;
  run.answer = input.answerAfter;
  run.calibrationId = input.calibrationId;
  run.rowRevision = (run.rowRevision ?? 0) + 1;
  run.rowsHash = input.rowsAfterHash;
  await saveRun(scope, run);
  const result: ApplyAnswerCalibrationResult = {
    commitId: input.commitId,
    calibrationId: input.calibrationId,
    calibrationVersion: actualVersion + 1,
    rowRevision: run.rowRevision,
    answer: input.answerAfter,
    idempotent: false,
  };
  commits.push({ ...input, result });
  await writeJson(commitsName, commits);
  return result;
}

export interface ApplyRunFeedbackInput {
  runId: string;
  expectedRowRevision: number;
  expectedRowsHash: string;
  rows: MtoRow[];
  rowsAfterHash: string;
  totals: RunTotals;
  actor: string;
  events: LearningEvent[];
  calibration?: {
    value: Calibration & Partial<ScopedCalibration>;
    expectedVersion: number;
  };
}

export interface ApplyRunFeedbackResult {
  rowRevision: number;
  calibrationId: string | null;
  calibrationVersion: number | null;
}

// Feedback satırları, profil revizyonu ve öğrenme olayları Supabase'te tek kısa
// transaction içinde yazılır. Böylece AI çağrısı sürerken kilit tutulmaz; RPC
// yalnız önceden doğrulanmış sonucu optimistic revision/hash ile commit eder.
export async function applyRunFeedback(
  scope: AccessScope,
  input: ApplyRunFeedbackInput,
): Promise<ApplyRunFeedbackResult> {
  assertScope(scope);
  const payloadRows = input.rows.map((row, idx) => ({
    id: row.id, idx, line: row.line, code: row.code, sub: row.sub,
    s1: row.s1, s2: row.s2, qty: row.qty, unit: row.unit,
    remark: row.remark, scope: row.scope, edited: row.edited ?? false,
  }));
  const cal = input.calibration;
  const calScope = cal ? calibrationScope(cal.value) : null;
  if (isSupabase) {
    const { data, error } = await client().rpc('apply_run_feedback_v1', {
      p_tenant_key: scope.tenantKey,
      p_user_key: scope.userKey,
      p_run_id: input.runId,
      p_expected_row_revision: input.expectedRowRevision,
      p_expected_rows_hash: input.expectedRowsHash,
      p_rows: payloadRows,
      p_rows_after_hash: input.rowsAfterHash,
      p_totals: input.totals,
      p_actor_label: input.actor,
      p_events: input.events,
      p_calibration_id: cal?.value.id ?? null,
      p_expected_profile_version: cal?.expectedVersion ?? null,
      p_calibration_name: cal?.value.name ?? null,
      p_rules: cal?.value.rules ?? null,
      p_learned_from: cal?.value.learnedFrom ?? null,
      p_model_family: calScope?.modelFamily ?? null,
      p_client_key: calScope?.clientKey ?? null,
      p_status: calScope?.status ?? null,
    });
    if (error) throw error;
    const result = data as Record<string, unknown>;
    return {
      rowRevision: Number(result.rowRevision),
      calibrationId: (result.calibrationId as string | null) ?? null,
      calibrationVersion: result.calibrationVersion == null ? null : Number(result.calibrationVersion),
    };
  }

  const run = await getRun(scope, input.runId);
  if (!run || run.status !== 'done') throw new Error('RUN_NOT_DONE');
  if ((run.rowRevision ?? 0) !== input.expectedRowRevision
    || (run.rowsHash && run.rowsHash !== input.expectedRowsHash)) {
    throw new Error('RUN_REVISION_CONFLICT');
  }
  let savedCalibration: ScopedCalibration | null = null;
  if (cal) savedCalibration = await saveCalibration(scope, cal.value, cal.expectedVersion, input.actor);
  await writeJson(scopedName(scope, `rows-${input.runId}.json`), input.rows);
  run.totals = input.totals;
  run.answer = null;
  run.rowRevision = (run.rowRevision ?? 0) + 1;
  run.rowsHash = input.rowsAfterHash;
  if (savedCalibration) run.calibrationId = savedCalibration.id;
  await saveRun(scope, run);
  await addLearningEvents(scope, input.events);
  return {
    rowRevision: run.rowRevision,
    calibrationId: savedCalibration?.id ?? run.calibrationId,
    calibrationVersion: savedCalibration?.version ?? null,
  };
}

// ---------- Dosya depolama ----------
export async function storeFile(scope: AccessScope, runId: string, fileName: string, buf: Buffer): Promise<string> {
  assertScope(scope);
  if (!isUuid(runId) || !isSafeNwdFileName(fileName)) throw new Error('unsafe storage key');
  // Depolama anahtarında ham ad KULLANILMAZ: Supabase köşeli parantez/Türkçe
  // karakterde "Invalid key" atıyordu (görünen ad run.fileName'de aynen kalır).
  const safeName = storageKeyName(fileName);
  if (isSupabase) {
    const key = `${runId}/${safeName}`;
    const { error } = await client().storage.from(BUCKET).upload(key, buf, { upsert: true, contentType: 'application/octet-stream' });
    if (error) throw error;
    return key;
  }
  if (isPg) {
    const key = `${runId}/${safeName}`;
    await pgPutFile(key, buf);
    return key;
  }
  const dir = path.join(DATA_DIR, 'files', `tenant-${scope.tenantKey}`, runId);
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, safeName);
  await fs.writeFile(p, buf);
  return p;
}

export async function deleteStoredFile(scope: AccessScope, runId: string, fileName: string): Promise<void> {
  assertScope(scope);
  if (!isUuid(runId) || !isSafeNwdFileName(fileName)) throw new Error('unsafe storage key');
  const key = `${runId}/${storageKeyName(fileName)}`;
  if (isSupabase) {
    const { data: ownedRun, error: runError } = await client().from('runs').select('id')
      .eq('tenant_key', scope.tenantKey).eq('id', runId).maybeSingle();
    if (runError) throw runError;
    const { data: ownedLease, error: leaseError } = ownedRun
      ? { data: null, error: null }
      : await client().from('storage_cleanup').select('path')
        .eq('tenant_key', scope.tenantKey).eq('path', key)
        .in('kind', ['reservation', 'finalizing', 'delete', 'deleting']).maybeSingle();
    if (leaseError) throw leaseError;
    if (!ownedRun && !ownedLease) throw new Error('file not found');
    const { error } = await client().storage.from(BUCKET).remove([key]);
    if (error) throw error;
    return;
  }
  if (isPg) {
    if (!await getRun(scope, runId)) return;
    await pgDelFiles(key);
    return;
  }
  try {
    await fs.unlink(path.join(DATA_DIR, 'files', `tenant-${scope.tenantKey}`, runId, storageKeyName(fileName)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function drainStorageCleanup(scope: AccessScope, limit = 5): Promise<void> {
  assertScope(scope);
  if (!isSupabase) return;
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 20)) : 5;
  const now = new Date().toISOString();
  const { data, error } = await client().from('storage_cleanup').select('path,kind')
    .eq('tenant_key', scope.tenantKey)
    .lte('not_before', now)
    .order('queued_at', { ascending: true }).limit(safeLimit);
  if (error) throw error;
  for (const row of data ?? []) {
    const key = row.path as string;
    const kind = row.kind as string;
    if (!isSafeStorageKey(key)) {
      console.error('unsafe path left in storage cleanup outbox');
      continue;
    }
    if (!['reservation', 'finalizing', 'delete', 'deleting'].includes(kind)) {
      console.error('unsafe kind left in storage cleanup outbox');
      continue;
    }
    // Compare-and-swap claims this exact generation/state. A finalizer can no
    // longer claim a reservation after this succeeds.
    const { data: claimed, error: claimError } = await client().from('storage_cleanup')
      .update({ kind: 'deleting', queued_at: now })
      .eq('tenant_key', scope.tenantKey).eq('path', key).eq('kind', kind).lte('not_before', now)
      .select('path').maybeSingle();
    if (claimError) throw claimError;
    if (!claimed) continue;
    const runId = key.slice(0, key.indexOf('/'));
    const { data: liveRun, error: runError } = await client().from('runs').select('id')
      .eq('tenant_key', scope.tenantKey).eq('id', runId).maybeSingle();
    if (runError) throw runError;
    if (liveRun) {
      // A finalization succeeded but acknowledging its reservation did not.
      // The live run owns the object; clear only the stale reservation.
      const { error: ackError } = await client().from('storage_cleanup').delete()
        .eq('tenant_key', scope.tenantKey).eq('path', key).eq('kind', 'deleting');
      if (ackError) throw ackError;
      continue;
    }
    const { error: storageError } = await client().storage.from(BUCKET).remove([key]);
    if (storageError) {
      console.error('storage cleanup deferred', storageError.message);
      continue;
    }
    const { error: ackError } = await client().from('storage_cleanup').delete()
      .eq('tenant_key', scope.tenantKey).eq('path', key).eq('kind', 'deleting');
    if (ackError) throw ackError;
  }
}

// ---- Run artefaktları (ör. 3B viewer satır→nesne eşlemesi) ----
// runs.aps jsonb'sine KOYULMAZ: büyük model ölçeğinde ~45k id ≈ 300KB olur ve her
// slim-poll / liste sorgusunu şişirirdi. Depo katmanında ayrı nesne olarak durur.
const ARTIFACT_NAMES = new Set(['objectmap.json', 'candidates.json']);

export async function putRunArtifact(scope: AccessScope, runId: string, name: string, data: unknown): Promise<void> {
  assertScope(scope);
  if (!isUuid(runId) || !ARTIFACT_NAMES.has(name)) throw new Error('unsafe artifact key');
  if (!await getRun(scope, runId)) throw new Error('run not found');
  const buf = Buffer.from(JSON.stringify(data), 'utf8');
  if (isSupabase) {
    // bucket MIME-kısıtlı (NWD yüklemeleri için octet-stream'e izinli) — json reddedilir
    const { error } = await client().storage.from(BUCKET).upload(`${runId}/${name}`, buf, { upsert: true, contentType: 'application/octet-stream' });
    if (error) throw error;
    return;
  }
  if (isPg) { await pgPutFile(`${runId}/${name}`, buf); return; }
  const dir = path.join(DATA_DIR, 'files', `tenant-${scope.tenantKey}`, runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), buf);
}

export async function getRunArtifact<T>(scope: AccessScope, runId: string, name: string): Promise<T | null> {
  assertScope(scope);
  if (!isUuid(runId) || !ARTIFACT_NAMES.has(name)) throw new Error('unsafe artifact key');
  if (!await getRun(scope, runId)) return null;
  try {
    let buf: Buffer;
    if (isSupabase) {
      const { data, error } = await client().storage.from(BUCKET).download(`${runId}/${name}`);
      if (error || !data) return null;
      buf = Buffer.from(await data.arrayBuffer());
    } else if (isPg) {
      buf = await pgGetFile(`${runId}/${name}`);
    } else {
      buf = await fs.readFile(path.join(DATA_DIR, 'files', `tenant-${scope.tenantKey}`, runId, name));
    }
    return JSON.parse(buf.toString('utf8')) as T;
  } catch {
    return null;
  }
}

export async function fetchStoredFile(scope: AccessScope, key: string): Promise<Buffer> {
  assertScope(scope);
  if (!isSafeStorageKey(key)) throw new Error('unsafe storage key');
  const runId = key.slice(0, key.indexOf('/'));
  if (isSupabase) {
    const { data: ownedRun, error: runError } = await client().from('runs').select('id')
      .eq('tenant_key', scope.tenantKey).eq('id', runId).maybeSingle();
    if (runError) throw runError;
    if (!ownedRun) {
      const { data: reservation, error: reservationError } = await client().from('storage_cleanup').select('path')
        .eq('tenant_key', scope.tenantKey).eq('path', key).in('kind', ['reservation', 'finalizing']).maybeSingle();
      if (reservationError) throw reservationError;
      if (!reservation) throw new Error('file not found');
    }
    const { data, error } = await client().storage.from(BUCKET).download(key);
    if (error || !data) throw error ?? new Error('file not found');
    return Buffer.from(await data.arrayBuffer());
  }
  if (!await getRun(scope, runId)) throw new Error('file not found');
  if (isPg) return pgGetFile(key);
  return fs.readFile(path.join(DATA_DIR, 'files', `tenant-${scope.tenantKey}`, runId, key.slice(key.indexOf('/') + 1)));
}

// Bucket gizlilik/MIME/boyut politikasını hem yazar hem geri okuyarak doğrular.
// Model IP'si söz konusu olduğundan yanlış/public bucket ile fail-open ilerlenmez.
let bucketLimitSynced = false;
export async function ensureBucketLimit(maxBytes: number): Promise<void> {
  if (!isSupabase || bucketLimitSynced) return;
  const { error: updateError } = await client().storage.updateBucket(BUCKET, {
    public: false,
    fileSizeLimit: maxBytes,
    allowedMimeTypes: ['application/octet-stream'],
  });
  if (updateError) throw updateError;
  const { data, error: readError } = await client().storage.getBucket(BUCKET);
  if (readError || !data) throw readError ?? new Error('storage bucket not found');
  const limit = Number(data.file_size_limit ?? 0);
  const mime = data.allowed_mime_types ?? [];
  if (data.public || limit !== maxBytes
    || mime.length !== 1 || mime[0] !== 'application/octet-stream') {
    throw new Error('storage bucket policy mismatch');
  }
  bucketLimitSynced = true;
}

export async function signedUploadUrl(scope: AccessScope, runId: string, fileName: string): Promise<{ path: string; token: string } | null> {
  assertScope(scope);
  if (!isSupabase) return null;
  if (!isUuid(runId) || !isSafeNwdFileName(fileName)) throw new Error('unsafe storage key');
  const key = `${runId}/${storageKeyName(fileName)}`;
  const { data, error } = await client().storage.from(BUCKET).createSignedUploadUrl(key);
  if (error || !data) throw error ?? new Error('signed url failed');
  return { path: key, token: data.token };
}

export async function reserveStoredUpload(scope: AccessScope, runId: string, fileName: string): Promise<void> {
  assertScope(scope);
  if (!isSupabase) return;
  if (!isUuid(runId) || !isSafeNwdFileName(fileName)) throw new Error('unsafe storage key');
  const now = new Date();
  const { error } = await client().from('storage_cleanup').insert({
    tenant_key: scope.tenantKey,
    user_key: scope.userKey,
    path: `${runId}/${storageKeyName(fileName)}`,
    queued_at: now.toISOString(),
    not_before: new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString(),
    kind: 'reservation',
  });
  if (error) throw error;
}

export async function beginFinalizeStoredUpload(scope: AccessScope, runId: string, fileName: string): Promise<boolean> {
  assertScope(scope);
  if (!isSupabase) return true;
  if (!isUuid(runId) || !isSafeNwdFileName(fileName)) throw new Error('unsafe storage key');
  const { data, error } = await client().from('storage_cleanup')
    .update({
      kind: 'finalizing',
      not_before: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    })
    .eq('tenant_key', scope.tenantKey).eq('path', `${runId}/${storageKeyName(fileName)}`).eq('kind', 'reservation')
    .select('path').maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function claimStoredUpload(scope: AccessScope, runId: string, fileName: string): Promise<void> {
  assertScope(scope);
  if (!isSupabase) return;
  if (!isUuid(runId) || !isSafeNwdFileName(fileName)) throw new Error('unsafe storage key');
  const { error } = await client().from('storage_cleanup').delete()
    .eq('tenant_key', scope.tenantKey).eq('path', `${runId}/${storageKeyName(fileName)}`).eq('kind', 'finalizing');
  if (error) throw error;
}

export async function cancelStoredUpload(scope: AccessScope, runId: string, fileName: string): Promise<void> {
  assertScope(scope);
  if (!isSupabase) return;
  if (!isUuid(runId) || !isSafeNwdFileName(fileName)) throw new Error('unsafe storage key');
  const { error } = await client().from('storage_cleanup').delete()
    .eq('tenant_key', scope.tenantKey).eq('path', `${runId}/${storageKeyName(fileName)}`).in('kind', ['reservation', 'finalizing']);
  if (error) throw error;
}

function dbRun(r: Record<string, unknown>): Run {
  return {
    id: r.id as string, projectName: r.project_name as string, fileName: r.file_name as string,
    fileSize: Number(r.file_size), vocab: r.vocab as Run['vocab'], calibrationId: r.calibration_id as string | null,
    calibrationSnapshot: (r.calibration_snapshot as Run['calibrationSnapshot']) ?? null,
    status: r.status as Run['status'], error: (r.error as string) ?? undefined,
    totals: r.totals as Run['totals'], fasteners: r.fasteners as Run['fasteners'],
    progress: (r.progress as Run['progress']) ?? [], ai: (r.ai as Run['ai']) ?? null,
    answer: (r.answer as Run['answer']) ?? null,
    rowRevision: Number(r.row_revision ?? 0),
    rowsHash: (r.rows_hash as string | null) ?? null,
    comparisonRevision: Number(r.comparison_revision ?? 0),
    aps: (r.aps as Run['aps']) ?? null,
    analysis: (r.analysis as Run['analysis']) ?? ((r.aps as Run['aps'])?.analysis ?? null),
    createdAt: r.created_at as string,
  };
}

// ---------- Çalışma ilerlemesi + AI (v2) ----------
export async function updateRunMeta(scope: AccessScope, runId: string, patch: { progress?: import('./types').StageEvent[]; ai?: import('./types').AiAudit | null; status?: Run['status']; error?: string; totals?: Run['totals']; fasteners?: Run['fasteners']; vocab?: Run['vocab']; answer?: Run['answer']; calibrationId?: Run['calibrationId']; calibrationSnapshot?: Run['calibrationSnapshot']; aps?: Run['aps']; analysis?: Run['analysis'] }): Promise<void> {
  assertScope(scope);
  if (isSupabase) {
    const db: Record<string, unknown> = {};
    if (patch.progress !== undefined) db.progress = patch.progress;
    if (patch.ai !== undefined) db.ai = patch.ai;
    if (patch.status !== undefined) db.status = patch.status;
    if (patch.error !== undefined) db.error = patch.error;
    if (patch.totals !== undefined) db.totals = patch.totals;
    if (patch.fasteners !== undefined) db.fasteners = patch.fasteners;
    if (patch.vocab !== undefined) db.vocab = patch.vocab;
    if (patch.answer !== undefined) db.answer = patch.answer;
    if (patch.calibrationId !== undefined) db.calibration_id = patch.calibrationId;
    if (patch.calibrationSnapshot !== undefined) db.calibration_snapshot = patch.calibrationSnapshot;
    if (patch.aps !== undefined) db.aps = patch.aps;
    if (patch.analysis !== undefined) db.analysis = patch.analysis;
    const { error } = await client().from('runs').update(db)
      .eq('tenant_key', scope.tenantKey).eq('id', runId);
    if (error) throw error;
    return;
  }
  if (isPg) {
    const key = scopedName(scope, `run-${runId}`);
    const r = await kvGet<Run>(key);
    if (r) await kvSet(key, { ...r, ...patch });
    return;
  }
  const localName = scopedName(scope, 'runs.json');
  const runs = await readJson<Run[]>(localName, []);
  const i = runs.findIndex(r => r.id === runId);
  if (i >= 0) { runs[i] = { ...runs[i], ...patch }; await writeJson(localName, runs); }
}

// ---------- Bayat işlem bekçisi (watchdog) ----------
// APS ready-tamamlama kilidi: koşullu UPDATE ile tek instance kazanır (advance
// route'unun process-bellek inFlight seti lambda'lar arası korumaz). TTL geçince
// kilit doğal düşer — tamamlama yarıda kalırsa sonraki poll yeniden dener.
export async function claimApsRun(scope: AccessScope, runId: string, ttlMs = 120_000): Promise<boolean> {
  assertScope(scope);
  const now = Date.now();
  const run = await getRun(scope, runId);
  if (!run || run.status !== 'processing' || !run.aps) return false;
  const cu = run.aps.claimedUntil;
  if (cu && new Date(cu).getTime() > now) return false;
  const claimed = { ...run.aps, claimedUntil: new Date(now + ttlMs).toISOString() };
  if (isSupabase) {
    let q = client().from('runs').update({ aps: claimed })
      .eq('tenant_key', scope.tenantKey).eq('id', runId).eq('status', 'processing');
    // yalnız okuduğumuz claimedUntil hâlâ yerindeyse yaz (compare-and-set)
    q = cu ? q.eq('aps->>claimedUntil', cu) : q.is('aps->claimedUntil', null);
    const { data, error } = await q.select('id');
    if (error) throw error;
    return (data ?? []).length > 0;
  }
  // pg/local: tek instance çalışır — okuma-kontrolü yeterli
  await updateRunMeta(scope, runId, { aps: claimed });
  return true;
}

const STALE_PROCESSING_MS = 15 * 60 * 1000; // 15 dk
const STALE_APS_MS = 60 * 60 * 1000;        // bulut çevirisi (APS) dakikalar sürer — 60 dk tavan

// Süresi aşan 'processing' run'ı hataya çevirir (pipeline sessizce ölmüşse kullanıcı sonsuz beklemesin)
export async function resolveStaleRun(scope: AccessScope, run: Run): Promise<Run> {
  assertScope(scope);
  if (run.status !== 'processing') return run;
  const limit = run.aps ? STALE_APS_MS : STALE_PROCESSING_MS;
  const age = Date.now() - new Date(run.createdAt).getTime();
  if (!Number.isFinite(age) || age <= limit) return run;
  const error = run.aps
    ? 'Bulut çevirisi zaman aşımına uğradı (60 dk) — dosyayı yeniden yükleyin'
    : 'İşlem zaman aşımına uğradı (15 dk) — dosyayı yeniden yükleyin';
  await updateRunMeta(scope, run.id, { status: 'error', error });
  return { ...run, status: 'error', error };
}

// ---------- Bildirimler ----------
import type { AppNotification, LearningEvent } from './types';

export async function listNotifications(scope: AccessScope, limit = 30): Promise<AppNotification[]> {
  assertScope(scope);
  if (isSupabase) {
    const { data, error } = await client().from('notifications').select('*')
      .eq('tenant_key', scope.tenantKey).order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return (data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string, kind: r.kind as AppNotification['kind'], title: r.title as string,
      body: (r.body as string) ?? '', url: (r.url as string) ?? '/', read: Boolean(r.read), createdAt: r.created_at as string,
    }));
  }
  const all = await readJson<AppNotification[]>(scopedName(scope, 'notifications.json'), []);
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

export async function addNotification(scope: AccessScope, n: AppNotification): Promise<void> {
  assertScope(scope);
  if (isSupabase) {
    const { error } = await client().from('notifications').insert({
      tenant_key: scope.tenantKey, user_key: scope.userKey,
      id: n.id, kind: n.kind, title: n.title, body: n.body, url: n.url, read: n.read, created_at: n.createdAt,
    });
    if (error) throw error;
    return;
  }
  const localName = scopedName(scope, 'notifications.json');
  const all = await readJson<AppNotification[]>(localName, []);
  all.push(n);
  await writeJson(localName, all.slice(-200));
}

export async function markNotificationsRead(scope: AccessScope, ids: string[] | 'all'): Promise<void> {
  assertScope(scope);
  if (isSupabase) {
    const q = client().from('notifications').update({ read: true }).eq('tenant_key', scope.tenantKey);
    const { error } = ids === 'all' ? await q.eq('read', false) : await q.in('id', ids);
    if (error) throw error;
    return;
  }
  const localName = scopedName(scope, 'notifications.json');
  const all = await readJson<AppNotification[]>(localName, []);
  for (const n of all) if (ids === 'all' || ids.includes(n.id)) n.read = true;
  await writeJson(localName, all);
}

export async function deleteNotifications(scope: AccessScope, ids: string[] | 'all'): Promise<void> {
  assertScope(scope);
  if (isSupabase) {
    const q = client().from('notifications').delete().eq('tenant_key', scope.tenantKey);
    const { error } = ids === 'all' ? await q.gte('created_at', '1970-01-01') : await q.in('id', ids);
    if (error) throw error;
    return;
  }
  const localName = scopedName(scope, 'notifications.json');
  const all = await readJson<AppNotification[]>(localName, []);
  await writeJson(localName, ids === 'all' ? [] : all.filter(n => !ids.includes(n.id)));
}

// ---------- Öğrenme günlüğü (ML-uyumlu) ----------
export async function addLearningEvents(scope: AccessScope, events: LearningEvent[]): Promise<void> {
  assertScope(scope);
  if (!events.length) return;
  if (isSupabase) {
    const { error } = await client().from('learning_events').insert(events.map(e => ({
      tenant_key: scope.tenantKey, actor_user_key: scope.userKey,
      id: e.id, run_id: e.runId, ts: e.ts, kind: e.kind, before: e.before, after: e.after, context: e.context,
    })));
    if (error) throw error;
    return;
  }
  const localName = scopedName(scope, 'learning-events.json');
  const all = await readJson<LearningEvent[]>(localName, []);
  all.push(...events);
  await writeJson(localName, all);
}

export async function listLearningEvents(scope: AccessScope, limit = 500): Promise<LearningEvent[]> {
  assertScope(scope);
  if (isSupabase) {
    const { data, error } = await client().from('learning_events').select('*')
      .eq('tenant_key', scope.tenantKey).order('ts', { ascending: false }).limit(limit);
    if (error) throw error;
    return (data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string, runId: r.run_id as string, ts: r.ts as string, kind: r.kind as LearningEvent['kind'],
      before: r.before as LearningEvent['before'], after: r.after as LearningEvent['after'],
      context: r.context as LearningEvent['context'],
    }));
  }
  return (await readJson<LearningEvent[]>(scopedName(scope, 'learning-events.json'), [])).slice(-limit).reverse();
}

// ---------- Web Push abonelikleri ----------
export async function addPushSubscription(scope: AccessScope, sub: { endpoint: string; keys: Record<string, string> }): Promise<void> {
  assertScope(scope);
  if (isSupabase) {
    const { error } = await client().from('push_subscriptions').upsert({
      tenant_key: scope.tenantKey, user_key: scope.userKey, endpoint: sub.endpoint, subscription: sub,
    }, { onConflict: 'tenant_key,endpoint' });
    if (error) throw error;
    return;
  }
  const localName = scopedName(scope, 'push-subs.json');
  const all = await readJson<Record<string, unknown>[]>(localName, []);
  if (!all.some(s => (s as { endpoint?: string }).endpoint === sub.endpoint)) all.push(sub);
  await writeJson(localName, all);
}

export async function listPushSubscriptions(scope: AccessScope): Promise<{ endpoint: string; keys: Record<string, string> }[]> {
  assertScope(scope);
  if (isSupabase) {
    const { data, error } = await client().from('push_subscriptions').select('subscription')
      .eq('tenant_key', scope.tenantKey);
    if (error) throw error;
    return (data ?? []).map((r: Record<string, unknown>) => r.subscription as { endpoint: string; keys: Record<string, string> });
  }
  return readJson(scopedName(scope, 'push-subs.json'), []);
}

export async function removePushSubscription(scope: AccessScope, endpoint: string): Promise<void> {
  assertScope(scope);
  if (isSupabase) {
    const { error } = await client().from('push_subscriptions').delete()
      .eq('tenant_key', scope.tenantKey).eq('endpoint', endpoint);
    if (error) throw error;
    return;
  }
  const localName = scopedName(scope, 'push-subs.json');
  const all = await readJson<{ endpoint: string }[]>(localName, []);
  await writeJson(localName, all.filter(s => s.endpoint !== endpoint));
}
