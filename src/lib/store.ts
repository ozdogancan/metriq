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
export async function listRuns(): Promise<Run[]> {
  if (isSupabase) {
    const { data, error } = await client().from('runs').select('*').order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    return (data ?? []).map(dbRun);
  }
  // pg: her run kendi anahtarında — eşzamanlı yüklemelerde yarış yok
  if (isPg) {
    const runs = await kvList<Run>('run-');
    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
  }
  const runs = await readJson<Run[]>('runs.json', []);
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getRun(id: string): Promise<Run | null> {
  if (isSupabase) {
    const { data, error } = await client().from('runs').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data ? dbRun(data) : null;
  }
  if (isPg) return kvGet<Run>(`run-${id}`);
  return (await readJson<Run[]>('runs.json', [])).find(r => r.id === id) ?? null;
}

export async function saveRun(run: Run): Promise<void> {
  if (isSupabase) {
    const payload: Record<string, unknown> = {
      id: run.id, project_name: run.projectName, file_name: run.fileName, file_size: run.fileSize,
      vocab: run.vocab, calibration_id: run.calibrationId, status: run.status, error: run.error ?? null,
      totals: run.totals, fasteners: run.fasteners, progress: run.progress ?? [], ai: run.ai ?? null,
      answer: run.answer ?? null, created_at: run.createdAt,
    };
    if (run.rowRevision !== undefined) payload.row_revision = run.rowRevision;
    if (run.rowsHash !== undefined) payload.rows_hash = run.rowsHash;
    if (run.comparisonRevision !== undefined) payload.comparison_revision = run.comparisonRevision;
    if (run.aps !== undefined) payload.aps = run.aps;
    const { error } = await client().from('runs').upsert(payload);
    if (error) throw error;
    return;
  }
  if (isPg) { await kvSet(`run-${run.id}`, run); return; }
  const runs = await readJson<Run[]>('runs.json', []);
  const i = runs.findIndex(r => r.id === run.id);
  if (i >= 0) runs[i] = run; else runs.push(run);
  await writeJson('runs.json', runs);
}

export async function deleteRun(id: string): Promise<void> {
  if (isSupabase) {
    const run = await getRun(id);
    if (!run) return;
    if (!isSafeNwdFileName(run.fileName)) throw new Error('unsafe storage key');
    const path = `${id}/${storageKeyName(run.fileName)}`;
    // Postgres deletes the run (children cascade) and records the object path
    // in one transaction. Storage is external, so its cleanup is acknowledged
    // only after success and otherwise remains retryable in the outbox.
    const { error } = await client().rpc('delete_run_and_queue_storage', {
      p_run_id: id,
      p_path: path,
    });
    if (error) throw error;
    try { await drainStorageCleanup(5); }
    catch (cleanupError) { console.error('storage cleanup queued for retry', cleanupError); }
    return;
  }
  if (isPg) {
    await kvDel(`run-${id}`);
    await kvDel(`rows-${id}.json`);
    await kvDel(`steel-${id}.json`);
    await pgDelFiles(`${id}/`);
    return;
  }
  await writeJson('runs.json', (await readJson<Run[]>('runs.json', [])).filter(r => r.id !== id));
  try { await fs.unlink(path.join(DATA_DIR, `rows-${id}.json`)); } catch {}
  try { await fs.unlink(path.join(DATA_DIR, `steel-${id}.json`)); } catch {}
}

// ---------- Rows ----------
export async function getRows(runId: string): Promise<MtoRow[]> {
  if (isSupabase) {
    const all: Record<string, unknown>[] = [];
    for (let from = 0; from < MAX_RESULT_ROWS; from += REST_PAGE_SIZE) {
      const { data, error } = await client().from('mto_rows').select('*')
        .eq('run_id', runId).order('idx').order('id')
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
  return readJson<MtoRow[]>(`rows-${runId}.json`, []);
}

export async function saveRows(runId: string, rows: MtoRow[]): Promise<void> {
  if (isSupabase) {
    const payload = rows.map((r, idx) => ({
      id: r.id, idx, line: r.line, code: r.code, sub: r.sub,
      s1: r.s1, s2: r.s2, qty: r.qty, unit: r.unit, remark: r.remark, scope: r.scope, edited: r.edited ?? false,
    }));
    // replace_mto_rows RPC satırlarla birlikte row_revision+1, rows_hash=null,
    // answer=null invalidasyonunu da atomik yapar
    const { error } = await client().rpc('replace_mto_rows', { p_run_id: runId, p_rows: payload });
    if (error) throw error;
    return;
  }
  await writeJson(`rows-${runId}.json`, rows);
  // Supabase-dışı modlar da RPC ile AYNI invalidasyon semantiğini uygular —
  // yoksa bayat cevap karşılaştırmaları satır düzenlemesinden sonra geçerli kalırdı.
  const run = isPg ? await kvGet<Run>(`run-${runId}`) : (await readJson<Run[]>('runs.json', [])).find(r => r.id === runId);
  if (run) {
    const bumped: Run = { ...run, rowRevision: (run.rowRevision ?? 0) + 1, rowsHash: null, answer: null };
    if (isPg) await kvSet(`run-${runId}`, bumped);
    else {
      const runs = await readJson<Run[]>('runs.json', []);
      const i = runs.findIndex(r => r.id === runId);
      if (i >= 0) { runs[i] = bumped; await writeJson('runs.json', runs); }
    }
  }
}

export async function getSteel(runId: string): Promise<SteelRow[]> {
  if (isSupabase) {
    const all: Record<string, unknown>[] = [];
    for (let from = 0; from < MAX_RESULT_ROWS; from += REST_PAGE_SIZE) {
      const { data, error } = await client().from('steel_rows').select('*')
        .eq('run_id', runId).order('length_mm', { ascending: false }).order('id')
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
  return readJson<SteelRow[]>(`steel-${runId}.json`, []);
}

export async function saveSteel(runId: string, rows: SteelRow[]): Promise<void> {
  if (isSupabase) {
    const payload = rows.map(r => ({
      id: r.id, profile: r.profile, length_mm: r.lengthMm, count: r.count, total_kg: r.totalKg,
    }));
    const { error } = await client().rpc('replace_steel_rows', { p_run_id: runId, p_rows: payload });
    if (error) throw error;
    return;
  }
  await writeJson(`steel-${runId}.json`, rows);
}

// ---------- Calibrations ----------
export async function listCalibrations(): Promise<Calibration[]> {
  if (isSupabase) {
    const { data, error } = await client().from('calibrations').select('*')
      .is('archived_at', null).order('updated_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string, name: r.name as string, rules: r.rules as Calibration['rules'],
      learnedFrom: (r.learned_from as string[]) ?? [], createdAt: r.created_at as string, updatedAt: r.updated_at as string,
      version: Number(r.version ?? 1),
    }));
  }
  return readJson<Calibration[]>('calibrations.json', []);
}

export async function saveCalibration(cal: Calibration, expectedVersion: number, actor: string): Promise<Calibration> {
  if (isSupabase) {
    const { data, error } = await client().rpc('save_calibration_version_v1', {
      p_calibration_id: cal.id,
      p_expected_version: expectedVersion,
      p_name: cal.name,
      p_rules: cal.rules,
      p_learned_from: cal.learnedFrom,
      p_actor_label: actor,
    });
    if (error) throw error;
    return { ...cal, version: Number((data as { version?: number } | null)?.version ?? expectedVersion + 1) };
  }
  const cals = await readJson<Calibration[]>('calibrations.json', []);
  const i = cals.findIndex(c => c.id === cal.id);
  const actualVersion = i >= 0 ? (cals[i].version ?? 1) : 0;
  if (actualVersion !== expectedVersion) throw new Error('PROFILE_VERSION_CONFLICT');
  const saved = { ...cal, version: actualVersion + 1 };
  if (i >= 0) cals[i] = saved; else cals.push(saved);
  await writeJson('calibrations.json', cals);
  return saved;
}

export async function deleteCalibration(id: string, expectedVersion: number, actor: string): Promise<void> {
  if (isSupabase) {
    const { error } = await client().rpc('archive_calibration_v1', {
      p_calibration_id: id,
      p_expected_version: expectedVersion,
      p_actor_label: actor,
    });
    if (error) throw error;
    return;
  }
  await writeJson('calibrations.json', (await readJson<Calibration[]>('calibrations.json', [])).filter(c => c.id !== id));
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

export async function recordAnswerComparison(input: AnswerComparisonRecord & {
  expectedComparisonRevision: number;
  learningEventId: string;
}): Promise<void> {
  if (isSupabase) {
    const { error } = await client().rpc('record_answer_comparison_v1', {
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
  const run = await getRun(input.runId);
  if (!run) throw new Error('run not found');
  if ((run.rowRevision ?? 0) !== input.baseRowRevision
    || (run.comparisonRevision ?? 0) !== input.expectedComparisonRevision
    || (run.rowsHash && run.rowsHash !== input.baseRowsHash)) {
    throw new Error('RUN_REVISION_CONFLICT');
  }
  const all = await readJson<AnswerComparisonRecord[]>('answer-comparisons.json', []);
  const existing = all.find(value => value.id === input.id);
  if (existing && JSON.stringify(existing.diff) !== JSON.stringify(input.diff)) {
    throw new Error('COMPARISON_ID_REUSED');
  }
  if (!existing) {
    all.push(input);
    await writeJson('answer-comparisons.json', all);
  }
  run.answer = input.diff;
  run.rowsHash = input.baseRowsHash;
  run.comparisonRevision = (run.comparisonRevision ?? 0) + 1;
  await saveRun(run);
}

export async function getAnswerComparison(id: string): Promise<AnswerComparisonRecord | null> {
  if (isSupabase) {
    const { data, error } = await client().from('answer_comparisons').select('*').eq('id', id).maybeSingle();
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
  return (await readJson<AnswerComparisonRecord[]>('answer-comparisons.json', []))
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
  commitId: string,
  requestHash: string,
  runId: string,
): Promise<ApplyAnswerCalibrationResult | null> {
  if (isSupabase) {
    const { data, error } = await client().from('calibration_commits').select('*').eq('id', commitId).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    if (data.request_hash !== requestHash || data.run_id !== runId) throw new Error('IDEMPOTENCY_KEY_REUSED');
    const run = await getRun(runId);
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
  const commits = await readJson<Array<ApplyAnswerCalibrationInput & { result: ApplyAnswerCalibrationResult }>>('calibration-commits.json', []);
  const existing = commits.find(value => value.commitId === commitId);
  if (!existing) return null;
  if (existing.requestHash !== requestHash || existing.runId !== runId) throw new Error('IDEMPOTENCY_KEY_REUSED');
  return { ...existing.result, idempotent: true };
}

export async function applyAnswerCalibration(input: ApplyAnswerCalibrationInput): Promise<ApplyAnswerCalibrationResult> {
  const payloadRows = input.rows.map((row, idx) => ({
    id: row.id, idx, line: row.line, code: row.code, sub: row.sub,
    s1: row.s1, s2: row.s2, qty: row.qty, unit: row.unit,
    remark: row.remark, scope: row.scope, edited: row.edited ?? false,
  }));
  if (isSupabase) {
    const { data, error } = await client().rpc('apply_answer_calibration_v1', {
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
    });
    if (error) throw error;
    return data as ApplyAnswerCalibrationResult;
  }

  const commits = await readJson<Array<ApplyAnswerCalibrationInput & { result: ApplyAnswerCalibrationResult }>>('calibration-commits.json', []);
  const existingCommit = commits.find(value => value.commitId === input.commitId);
  if (existingCommit) {
    if (existingCommit.requestHash !== input.requestHash) throw new Error('IDEMPOTENCY_KEY_REUSED');
    return { ...existingCommit.result, idempotent: true };
  }
  const run = await getRun(input.runId);
  const comparison = await getAnswerComparison(input.comparisonId);
  if (!run || !comparison || comparison.runId !== input.runId) throw new Error('comparison not found');
  if ((run.rowRevision ?? 0) !== input.expectedRowRevision
    || run.rowsHash !== comparison.baseRowsHash || run.answer?.id !== input.comparisonId) {
    throw new Error('COMPARISON_STALE');
  }
  const cals = await readJson<Calibration[]>('calibrations.json', []);
  const index = cals.findIndex(value => value.id === input.calibrationId);
  const actualVersion = index >= 0 ? (cals[index].version ?? 1) : 0;
  if (actualVersion !== input.expectedProfileVersion) throw new Error('PROFILE_VERSION_CONFLICT');
  const now = new Date().toISOString();
  const calibration: Calibration = {
    id: input.calibrationId,
    name: input.calibrationName,
    rules: input.rules,
    learnedFrom: input.learnedFrom,
    version: actualVersion + 1,
    createdAt: index >= 0 ? cals[index].createdAt : now,
    updatedAt: now,
  };
  if (index >= 0) cals[index] = calibration; else cals.push(calibration);
  await writeJson(`rows-${input.runId}.json`, input.rows);
  await writeJson('calibrations.json', cals);
  run.totals = input.totals;
  run.answer = input.answerAfter;
  run.calibrationId = input.calibrationId;
  run.rowRevision = (run.rowRevision ?? 0) + 1;
  run.rowsHash = input.rowsAfterHash;
  await saveRun(run);
  const result: ApplyAnswerCalibrationResult = {
    commitId: input.commitId,
    calibrationId: input.calibrationId,
    calibrationVersion: actualVersion + 1,
    rowRevision: run.rowRevision,
    answer: input.answerAfter,
    idempotent: false,
  };
  commits.push({ ...input, result });
  await writeJson('calibration-commits.json', commits);
  return result;
}

// ---------- Dosya depolama ----------
export async function storeFile(runId: string, fileName: string, buf: Buffer): Promise<string> {
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
  const dir = path.join(DATA_DIR, 'files', runId);
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, safeName);
  await fs.writeFile(p, buf);
  return p;
}

export async function deleteStoredFile(runId: string, fileName: string): Promise<void> {
  if (!isUuid(runId) || !isSafeNwdFileName(fileName)) throw new Error('unsafe storage key');
  const key = `${runId}/${storageKeyName(fileName)}`;
  if (isSupabase) {
    const { error } = await client().storage.from(BUCKET).remove([key]);
    if (error) throw error;
    return;
  }
  if (isPg) {
    await pgDelFiles(key);
    return;
  }
  try {
    await fs.unlink(path.join(DATA_DIR, 'files', runId, storageKeyName(fileName)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function drainStorageCleanup(limit = 5): Promise<void> {
  if (!isSupabase) return;
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 20)) : 5;
  const now = new Date().toISOString();
  const { data, error } = await client().from('storage_cleanup').select('path,kind')
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
      .eq('path', key).eq('kind', kind).lte('not_before', now)
      .select('path').maybeSingle();
    if (claimError) throw claimError;
    if (!claimed) continue;
    const runId = key.slice(0, key.indexOf('/'));
    const { data: liveRun, error: runError } = await client().from('runs').select('id')
      .eq('id', runId).maybeSingle();
    if (runError) throw runError;
    if (liveRun) {
      // A finalization succeeded but acknowledging its reservation did not.
      // The live run owns the object; clear only the stale reservation.
      const { error: ackError } = await client().from('storage_cleanup').delete()
        .eq('path', key).eq('kind', 'deleting');
      if (ackError) throw ackError;
      continue;
    }
    const { error: storageError } = await client().storage.from(BUCKET).remove([key]);
    if (storageError) {
      console.error('storage cleanup deferred', storageError.message);
      continue;
    }
    const { error: ackError } = await client().from('storage_cleanup').delete()
      .eq('path', key).eq('kind', 'deleting');
    if (ackError) throw ackError;
  }
}

export async function fetchStoredFile(key: string): Promise<Buffer> {
  if (!isSafeStorageKey(key)) throw new Error('unsafe storage key');
  if (isSupabase) {
    const { data, error } = await client().storage.from(BUCKET).download(key);
    if (error || !data) throw error ?? new Error('file not found');
    return Buffer.from(await data.arrayBuffer());
  }
  if (isPg) return pgGetFile(key);
  return fs.readFile(key);
}

export async function signedUploadUrl(runId: string, fileName: string): Promise<{ path: string; token: string } | null> {
  if (!isSupabase) return null;
  if (!isUuid(runId) || !isSafeNwdFileName(fileName)) throw new Error('unsafe storage key');
  const key = `${runId}/${storageKeyName(fileName)}`;
  const { data, error } = await client().storage.from(BUCKET).createSignedUploadUrl(key);
  if (error || !data) throw error ?? new Error('signed url failed');
  return { path: key, token: data.token };
}

export async function reserveStoredUpload(runId: string, fileName: string): Promise<void> {
  if (!isSupabase) return;
  if (!isUuid(runId) || !isSafeNwdFileName(fileName)) throw new Error('unsafe storage key');
  const now = new Date();
  const { error } = await client().from('storage_cleanup').insert({
    path: `${runId}/${storageKeyName(fileName)}`,
    queued_at: now.toISOString(),
    not_before: new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString(),
    kind: 'reservation',
  });
  if (error) throw error;
}

export async function beginFinalizeStoredUpload(runId: string, fileName: string): Promise<boolean> {
  if (!isSupabase) return true;
  if (!isUuid(runId) || !isSafeNwdFileName(fileName)) throw new Error('unsafe storage key');
  const { data, error } = await client().from('storage_cleanup')
    .update({
      kind: 'finalizing',
      not_before: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    })
    .eq('path', `${runId}/${storageKeyName(fileName)}`).eq('kind', 'reservation')
    .select('path').maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function claimStoredUpload(runId: string, fileName: string): Promise<void> {
  if (!isSupabase) return;
  if (!isUuid(runId) || !isSafeNwdFileName(fileName)) throw new Error('unsafe storage key');
  const { error } = await client().from('storage_cleanup').delete()
    .eq('path', `${runId}/${storageKeyName(fileName)}`).eq('kind', 'finalizing');
  if (error) throw error;
}

export async function cancelStoredUpload(runId: string, fileName: string): Promise<void> {
  if (!isSupabase) return;
  if (!isUuid(runId) || !isSafeNwdFileName(fileName)) throw new Error('unsafe storage key');
  const { error } = await client().from('storage_cleanup').delete()
    .eq('path', `${runId}/${storageKeyName(fileName)}`).in('kind', ['reservation', 'finalizing']);
  if (error) throw error;
}

function dbRun(r: Record<string, unknown>): Run {
  return {
    id: r.id as string, projectName: r.project_name as string, fileName: r.file_name as string,
    fileSize: Number(r.file_size), vocab: r.vocab as Run['vocab'], calibrationId: r.calibration_id as string | null,
    status: r.status as Run['status'], error: (r.error as string) ?? undefined,
    totals: r.totals as Run['totals'], fasteners: r.fasteners as Run['fasteners'],
    progress: (r.progress as Run['progress']) ?? [], ai: (r.ai as Run['ai']) ?? null,
    answer: (r.answer as Run['answer']) ?? null,
    rowRevision: Number(r.row_revision ?? 0),
    rowsHash: (r.rows_hash as string | null) ?? null,
    comparisonRevision: Number(r.comparison_revision ?? 0),
    aps: (r.aps as Run['aps']) ?? null,
    createdAt: r.created_at as string,
  };
}

// ---------- Çalışma ilerlemesi + AI (v2) ----------
export async function updateRunMeta(runId: string, patch: { progress?: import('./types').StageEvent[]; ai?: import('./types').AiAudit | null; status?: Run['status']; error?: string; totals?: Run['totals']; fasteners?: Run['fasteners']; vocab?: Run['vocab']; answer?: Run['answer']; calibrationId?: Run['calibrationId']; aps?: Run['aps'] }): Promise<void> {
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
    if (patch.aps !== undefined) db.aps = patch.aps;
    const { error } = await client().from('runs').update(db).eq('id', runId);
    if (error) throw error;
    return;
  }
  if (isPg) {
    const r = await kvGet<Run>(`run-${runId}`);
    if (r) await kvSet(`run-${runId}`, { ...r, ...patch });
    return;
  }
  const runs = await readJson<Run[]>('runs.json', []);
  const i = runs.findIndex(r => r.id === runId);
  if (i >= 0) { runs[i] = { ...runs[i], ...patch }; await writeJson('runs.json', runs); }
}

// ---------- Bayat işlem bekçisi (watchdog) ----------
// APS ready-tamamlama kilidi: koşullu UPDATE ile tek instance kazanır (advance
// route'unun process-bellek inFlight seti lambda'lar arası korumaz). TTL geçince
// kilit doğal düşer — tamamlama yarıda kalırsa sonraki poll yeniden dener.
export async function claimApsRun(runId: string, ttlMs = 120_000): Promise<boolean> {
  const now = Date.now();
  const run = await getRun(runId);
  if (!run || run.status !== 'processing' || !run.aps) return false;
  const cu = run.aps.claimedUntil;
  if (cu && new Date(cu).getTime() > now) return false;
  const claimed = { ...run.aps, claimedUntil: new Date(now + ttlMs).toISOString() };
  if (isSupabase) {
    let q = client().from('runs').update({ aps: claimed }).eq('id', runId).eq('status', 'processing');
    // yalnız okuduğumuz claimedUntil hâlâ yerindeyse yaz (compare-and-set)
    q = cu ? q.eq('aps->>claimedUntil', cu) : q.is('aps->claimedUntil', null);
    const { data, error } = await q.select('id');
    if (error) throw error;
    return (data ?? []).length > 0;
  }
  // pg/local: tek instance çalışır — okuma-kontrolü yeterli
  await updateRunMeta(runId, { aps: claimed });
  return true;
}

const STALE_PROCESSING_MS = 15 * 60 * 1000; // 15 dk
const STALE_APS_MS = 60 * 60 * 1000;        // bulut çevirisi (APS) dakikalar sürer — 60 dk tavan

// Süresi aşan 'processing' run'ı hataya çevirir (pipeline sessizce ölmüşse kullanıcı sonsuz beklemesin)
export async function resolveStaleRun(run: Run): Promise<Run> {
  if (run.status !== 'processing') return run;
  const limit = run.aps ? STALE_APS_MS : STALE_PROCESSING_MS;
  const age = Date.now() - new Date(run.createdAt).getTime();
  if (!Number.isFinite(age) || age <= limit) return run;
  const error = run.aps
    ? 'Bulut çevirisi zaman aşımına uğradı (60 dk) — dosyayı yeniden yükleyin'
    : 'İşlem zaman aşımına uğradı (15 dk) — dosyayı yeniden yükleyin';
  await updateRunMeta(run.id, { status: 'error', error });
  return { ...run, status: 'error', error };
}

// ---------- Bildirimler ----------
import type { AppNotification, LearningEvent } from './types';

export async function listNotifications(limit = 30): Promise<AppNotification[]> {
  if (isSupabase) {
    const { data, error } = await client().from('notifications').select('*').order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return (data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string, kind: r.kind as AppNotification['kind'], title: r.title as string,
      body: (r.body as string) ?? '', url: (r.url as string) ?? '/', read: Boolean(r.read), createdAt: r.created_at as string,
    }));
  }
  const all = await readJson<AppNotification[]>('notifications.json', []);
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

export async function addNotification(n: AppNotification): Promise<void> {
  if (isSupabase) {
    const { error } = await client().from('notifications').insert({
      id: n.id, kind: n.kind, title: n.title, body: n.body, url: n.url, read: n.read, created_at: n.createdAt,
    });
    if (error) throw error;
    return;
  }
  const all = await readJson<AppNotification[]>('notifications.json', []);
  all.push(n);
  await writeJson('notifications.json', all.slice(-200));
}

export async function markNotificationsRead(ids: string[] | 'all'): Promise<void> {
  if (isSupabase) {
    const q = client().from('notifications').update({ read: true });
    const { error } = ids === 'all' ? await q.eq('read', false) : await q.in('id', ids);
    if (error) throw error;
    return;
  }
  const all = await readJson<AppNotification[]>('notifications.json', []);
  for (const n of all) if (ids === 'all' || ids.includes(n.id)) n.read = true;
  await writeJson('notifications.json', all);
}

export async function deleteNotifications(ids: string[] | 'all'): Promise<void> {
  if (isSupabase) {
    const q = client().from('notifications').delete();
    const { error } = ids === 'all' ? await q.gte('created_at', '1970-01-01') : await q.in('id', ids);
    if (error) throw error;
    return;
  }
  const all = await readJson<AppNotification[]>('notifications.json', []);
  await writeJson('notifications.json', ids === 'all' ? [] : all.filter(n => !ids.includes(n.id)));
}

// ---------- Öğrenme günlüğü (ML-uyumlu) ----------
export async function addLearningEvents(events: LearningEvent[]): Promise<void> {
  if (!events.length) return;
  if (isSupabase) {
    const { error } = await client().from('learning_events').insert(events.map(e => ({
      id: e.id, run_id: e.runId, ts: e.ts, kind: e.kind, before: e.before, after: e.after, context: e.context,
    })));
    if (error) throw error;
    return;
  }
  const all = await readJson<LearningEvent[]>('learning-events.json', []);
  all.push(...events);
  await writeJson('learning-events.json', all);
}

export async function listLearningEvents(limit = 500): Promise<LearningEvent[]> {
  if (isSupabase) {
    const { data, error } = await client().from('learning_events').select('*').order('ts', { ascending: false }).limit(limit);
    if (error) throw error;
    return (data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string, runId: r.run_id as string, ts: r.ts as string, kind: r.kind as LearningEvent['kind'],
      before: r.before as LearningEvent['before'], after: r.after as LearningEvent['after'],
      context: r.context as LearningEvent['context'],
    }));
  }
  return (await readJson<LearningEvent[]>('learning-events.json', [])).slice(-limit).reverse();
}

// ---------- Web Push abonelikleri ----------
export async function addPushSubscription(sub: { endpoint: string; keys: Record<string, string> }): Promise<void> {
  if (isSupabase) {
    const { error } = await client().from('push_subscriptions').upsert({ endpoint: sub.endpoint, subscription: sub });
    if (error) throw error;
    return;
  }
  const all = await readJson<Record<string, unknown>[]>('push-subs.json', []);
  if (!all.some(s => (s as { endpoint?: string }).endpoint === sub.endpoint)) all.push(sub);
  await writeJson('push-subs.json', all);
}

export async function listPushSubscriptions(): Promise<{ endpoint: string; keys: Record<string, string> }[]> {
  if (isSupabase) {
    const { data, error } = await client().from('push_subscriptions').select('subscription');
    if (error) throw error;
    return (data ?? []).map((r: Record<string, unknown>) => r.subscription as { endpoint: string; keys: Record<string, string> });
  }
  return readJson('push-subs.json', []);
}

export async function removePushSubscription(endpoint: string): Promise<void> {
  if (isSupabase) {
    const { error } = await client().from('push_subscriptions').delete().eq('endpoint', endpoint);
    if (error) throw error;
    return;
  }
  const all = await readJson<{ endpoint: string }[]>('push-subs.json', []);
  await writeJson('push-subs.json', all.filter(s => s.endpoint !== endpoint));
}
