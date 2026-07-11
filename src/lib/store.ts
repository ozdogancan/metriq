// Metriq — depolama katmanı: Supabase (prod) veya yerel JSON (dev fallback)
import 'server-only';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Run, MtoRow, SteelRow, Calibration } from './types';
import { isPg, kvGet, kvSet, kvDel, kvList, pgPutFile, pgGetFile, pgDelFiles } from './store-pg';
import { isSafeNwdFileName, isUuid } from './upload-policy';

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
    const { data } = await client().from('runs').select('*').eq('id', id).maybeSingle();
    return data ? dbRun(data) : null;
  }
  if (isPg) return kvGet<Run>(`run-${id}`);
  return (await readJson<Run[]>('runs.json', [])).find(r => r.id === id) ?? null;
}

export async function saveRun(run: Run): Promise<void> {
  if (isSupabase) {
    const { error } = await client().from('runs').upsert({
      id: run.id, project_name: run.projectName, file_name: run.fileName, file_size: run.fileSize,
      vocab: run.vocab, calibration_id: run.calibrationId, status: run.status, error: run.error ?? null,
      totals: run.totals, fasteners: run.fasteners, progress: run.progress ?? [], ai: run.ai ?? null,
      answer: run.answer ?? null, created_at: run.createdAt,
    });
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
    if (run && isSafeNwdFileName(run.fileName)) {
      const { error: storageError } = await client().storage.from(BUCKET).remove([`${id}/${run.fileName}`]);
      if (storageError) throw storageError;
    }
    await client().from('mto_rows').delete().eq('run_id', id);
    await client().from('steel_rows').delete().eq('run_id', id);
    await client().from('runs').delete().eq('id', id);
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
    const { error } = await client().rpc('replace_mto_rows', { p_run_id: runId, p_rows: payload });
    if (error) throw error;
    return;
  }
  await writeJson(`rows-${runId}.json`, rows);
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
    const { data } = await client().from('calibrations').select('*').order('updated_at', { ascending: false });
    return (data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string, name: r.name as string, rules: r.rules as Calibration['rules'],
      learnedFrom: (r.learned_from as string[]) ?? [], createdAt: r.created_at as string, updatedAt: r.updated_at as string,
    }));
  }
  return readJson<Calibration[]>('calibrations.json', []);
}

export async function saveCalibration(cal: Calibration): Promise<void> {
  if (isSupabase) {
    const { error } = await client().from('calibrations').upsert({
      id: cal.id, name: cal.name, rules: cal.rules, learned_from: cal.learnedFrom,
      created_at: cal.createdAt, updated_at: cal.updatedAt,
    });
    if (error) throw error;
    return;
  }
  const cals = await readJson<Calibration[]>('calibrations.json', []);
  const i = cals.findIndex(c => c.id === cal.id);
  if (i >= 0) cals[i] = cal; else cals.push(cal);
  await writeJson('calibrations.json', cals);
}

export async function deleteCalibration(id: string): Promise<void> {
  if (isSupabase) { await client().from('calibrations').delete().eq('id', id); return; }
  await writeJson('calibrations.json', (await readJson<Calibration[]>('calibrations.json', [])).filter(c => c.id !== id));
}

// ---------- Dosya depolama ----------
export async function storeFile(runId: string, fileName: string, buf: Buffer): Promise<string> {
  if (!isUuid(runId) || !isSafeNwdFileName(fileName)) throw new Error('unsafe storage key');
  if (isSupabase) {
    const key = `${runId}/${fileName}`;
    const { error } = await client().storage.from(BUCKET).upload(key, buf, { upsert: true, contentType: 'application/octet-stream' });
    if (error) throw error;
    return key;
  }
  if (isPg) {
    const key = `${runId}/${fileName}`;
    await pgPutFile(key, buf);
    return key;
  }
  const dir = path.join(DATA_DIR, 'files', runId);
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, fileName);
  await fs.writeFile(p, buf);
  return p;
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
  const key = `${runId}/${fileName}`;
  const { data, error } = await client().storage.from(BUCKET).createSignedUploadUrl(key);
  if (error || !data) throw error ?? new Error('signed url failed');
  return { path: key, token: data.token };
}

function dbRun(r: Record<string, unknown>): Run {
  return {
    id: r.id as string, projectName: r.project_name as string, fileName: r.file_name as string,
    fileSize: Number(r.file_size), vocab: r.vocab as Run['vocab'], calibrationId: r.calibration_id as string | null,
    status: r.status as Run['status'], error: (r.error as string) ?? undefined,
    totals: r.totals as Run['totals'], fasteners: r.fasteners as Run['fasteners'],
    progress: (r.progress as Run['progress']) ?? [], ai: (r.ai as Run['ai']) ?? null,
    answer: (r.answer as Run['answer']) ?? null,
    createdAt: r.created_at as string,
  };
}

// ---------- Çalışma ilerlemesi + AI (v2) ----------
export async function updateRunMeta(runId: string, patch: { progress?: import('./types').StageEvent[]; ai?: import('./types').AiAudit | null; status?: Run['status']; error?: string; totals?: Run['totals']; fasteners?: Run['fasteners']; vocab?: Run['vocab']; answer?: Run['answer'] }): Promise<void> {
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
const STALE_PROCESSING_MS = 15 * 60 * 1000; // 15 dk

// 15 dk'yı aşan 'processing' run'ı hataya çevirir (pipeline sessizce ölmüşse kullanıcı sonsuz beklemesin)
export async function resolveStaleRun(run: Run): Promise<Run> {
  if (run.status !== 'processing') return run;
  const age = Date.now() - new Date(run.createdAt).getTime();
  if (!Number.isFinite(age) || age <= STALE_PROCESSING_MS) return run;
  const error = 'İşlem zaman aşımına uğradı (15 dk) — dosyayı yeniden yükleyin';
  await updateRunMeta(run.id, { status: 'error', error });
  return { ...run, status: 'error', error };
}

// ---------- Bildirimler ----------
import type { AppNotification, LearningEvent } from './types';

export async function listNotifications(limit = 30): Promise<AppNotification[]> {
  if (isSupabase) {
    const { data } = await client().from('notifications').select('*').order('created_at', { ascending: false }).limit(limit);
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
    await client().from('notifications').insert({
      id: n.id, kind: n.kind, title: n.title, body: n.body, url: n.url, read: n.read, created_at: n.createdAt,
    });
    return;
  }
  const all = await readJson<AppNotification[]>('notifications.json', []);
  all.push(n);
  await writeJson('notifications.json', all.slice(-200));
}

export async function markNotificationsRead(ids: string[] | 'all'): Promise<void> {
  if (isSupabase) {
    const q = client().from('notifications').update({ read: true });
    if (ids === 'all') await q.eq('read', false); else await q.in('id', ids);
    return;
  }
  const all = await readJson<AppNotification[]>('notifications.json', []);
  for (const n of all) if (ids === 'all' || ids.includes(n.id)) n.read = true;
  await writeJson('notifications.json', all);
}

export async function deleteNotifications(ids: string[] | 'all'): Promise<void> {
  if (isSupabase) {
    const q = client().from('notifications').delete();
    if (ids === 'all') await q.gte('created_at', '1970-01-01'); else await q.in('id', ids);
    return;
  }
  const all = await readJson<AppNotification[]>('notifications.json', []);
  await writeJson('notifications.json', ids === 'all' ? [] : all.filter(n => !ids.includes(n.id)));
}

// ---------- Öğrenme günlüğü (ML-uyumlu) ----------
export async function addLearningEvents(events: LearningEvent[]): Promise<void> {
  if (!events.length) return;
  if (isSupabase) {
    await client().from('learning_events').insert(events.map(e => ({
      id: e.id, run_id: e.runId, ts: e.ts, kind: e.kind, before: e.before, after: e.after, context: e.context,
    })));
    return;
  }
  const all = await readJson<LearningEvent[]>('learning-events.json', []);
  all.push(...events);
  await writeJson('learning-events.json', all);
}

export async function listLearningEvents(limit = 500): Promise<LearningEvent[]> {
  if (isSupabase) {
    const { data } = await client().from('learning_events').select('*').order('ts', { ascending: false }).limit(limit);
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
    await client().from('push_subscriptions').upsert({ endpoint: sub.endpoint, subscription: sub });
    return;
  }
  const all = await readJson<Record<string, unknown>[]>('push-subs.json', []);
  if (!all.some(s => (s as { endpoint?: string }).endpoint === sub.endpoint)) all.push(sub);
  await writeJson('push-subs.json', all);
}

export async function listPushSubscriptions(): Promise<{ endpoint: string; keys: Record<string, string> }[]> {
  if (isSupabase) {
    const { data } = await client().from('push_subscriptions').select('subscription');
    return (data ?? []).map((r: Record<string, unknown>) => r.subscription as { endpoint: string; keys: Record<string, string> });
  }
  return readJson('push-subs.json', []);
}

export async function removePushSubscription(endpoint: string): Promise<void> {
  if (isSupabase) { await client().from('push_subscriptions').delete().eq('endpoint', endpoint); return; }
  const all = await readJson<{ endpoint: string }[]>('push-subs.json', []);
  await writeJson('push-subs.json', all.filter(s => s.endpoint !== endpoint));
}
