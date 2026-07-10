// Metriq — depolama katmanı: Supabase (prod) veya yerel JSON (dev fallback)
import 'server-only';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Run, MtoRow, SteelRow, Calibration } from './types';

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_BUCKET || 'models';

export const isSupabase = Boolean(SB_URL && SB_KEY);

let sb: SupabaseClient | null = null;
function client(): SupabaseClient {
  if (!sb) sb = createClient(SB_URL!, SB_KEY!, { auth: { persistSession: false } });
  return sb;
}

// ---------- Yerel dosya sürücüsü (dev) ----------
const DATA_DIR = path.join(process.cwd(), '.data');
async function readJson<T>(name: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(path.join(DATA_DIR, name), 'utf8')) as T; }
  catch { return fallback; }
}
async function writeJson(name: string, data: unknown) {
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
  const runs = await readJson<Run[]>('runs.json', []);
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getRun(id: string): Promise<Run | null> {
  if (isSupabase) {
    const { data } = await client().from('runs').select('*').eq('id', id).maybeSingle();
    return data ? dbRun(data) : null;
  }
  return (await readJson<Run[]>('runs.json', [])).find(r => r.id === id) ?? null;
}

export async function saveRun(run: Run): Promise<void> {
  if (isSupabase) {
    const { error } = await client().from('runs').upsert({
      id: run.id, project_name: run.projectName, file_name: run.fileName, file_size: run.fileSize,
      vocab: run.vocab, calibration_id: run.calibrationId, status: run.status, error: run.error ?? null,
      totals: run.totals, fasteners: run.fasteners, progress: run.progress ?? [], ai: run.ai ?? null, created_at: run.createdAt,
    });
    if (error) throw error;
    return;
  }
  const runs = await readJson<Run[]>('runs.json', []);
  const i = runs.findIndex(r => r.id === run.id);
  if (i >= 0) runs[i] = run; else runs.push(run);
  await writeJson('runs.json', runs);
}

export async function deleteRun(id: string): Promise<void> {
  if (isSupabase) {
    await client().from('mto_rows').delete().eq('run_id', id);
    await client().from('steel_rows').delete().eq('run_id', id);
    await client().from('runs').delete().eq('id', id);
    return;
  }
  await writeJson('runs.json', (await readJson<Run[]>('runs.json', [])).filter(r => r.id !== id));
  try { await fs.unlink(path.join(DATA_DIR, `rows-${id}.json`)); } catch {}
  try { await fs.unlink(path.join(DATA_DIR, `steel-${id}.json`)); } catch {}
}

// ---------- Rows ----------
export async function getRows(runId: string): Promise<MtoRow[]> {
  if (isSupabase) {
    const { data, error } = await client().from('mto_rows').select('*').eq('run_id', runId).order('idx');
    if (error) throw error;
    return (data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string, line: r.line as string, code: r.code as string, sub: (r.sub as string) ?? '',
      s1: r.s1 as number | null, s2: (r.s2 as number) ?? 0, qty: Number(r.qty), unit: r.unit as 'M' | 'EA',
      remark: (r.remark as string) ?? '', scope: r.scope as 'MAIN' | 'INFO', edited: Boolean(r.edited),
    }));
  }
  return readJson<MtoRow[]>(`rows-${runId}.json`, []);
}

export async function saveRows(runId: string, rows: MtoRow[]): Promise<void> {
  if (isSupabase) {
    await client().from('mto_rows').delete().eq('run_id', runId);
    const payload = rows.map((r, idx) => ({
      id: r.id, run_id: runId, idx, line: r.line, code: r.code, sub: r.sub,
      s1: r.s1, s2: r.s2, qty: r.qty, unit: r.unit, remark: r.remark, scope: r.scope, edited: r.edited ?? false,
    }));
    for (let i = 0; i < payload.length; i += 500) {
      const { error } = await client().from('mto_rows').insert(payload.slice(i, i + 500));
      if (error) throw error;
    }
    return;
  }
  await writeJson(`rows-${runId}.json`, rows);
}

export async function getSteel(runId: string): Promise<SteelRow[]> {
  if (isSupabase) {
    const { data } = await client().from('steel_rows').select('*').eq('run_id', runId).order('length_mm', { ascending: false });
    return (data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id as string, profile: r.profile as string, lengthMm: Number(r.length_mm),
      count: Number(r.count), totalKg: Number(r.total_kg),
    }));
  }
  return readJson<SteelRow[]>(`steel-${runId}.json`, []);
}

export async function saveSteel(runId: string, rows: SteelRow[]): Promise<void> {
  if (isSupabase) {
    await client().from('steel_rows').delete().eq('run_id', runId);
    if (rows.length) {
      const { error } = await client().from('steel_rows').insert(rows.map(r => ({
        id: r.id, run_id: runId, profile: r.profile, length_mm: r.lengthMm, count: r.count, total_kg: r.totalKg,
      })));
      if (error) throw error;
    }
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
  if (isSupabase) {
    const key = `${runId}/${fileName}`;
    const { error } = await client().storage.from(BUCKET).upload(key, buf, { upsert: true, contentType: 'application/octet-stream' });
    if (error) throw error;
    return key;
  }
  const dir = path.join(DATA_DIR, 'files', runId);
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, fileName);
  await fs.writeFile(p, buf);
  return p;
}

export async function fetchStoredFile(key: string): Promise<Buffer> {
  if (isSupabase) {
    const { data, error } = await client().storage.from(BUCKET).download(key);
    if (error || !data) throw error ?? new Error('file not found');
    return Buffer.from(await data.arrayBuffer());
  }
  return fs.readFile(key);
}

export async function signedUploadUrl(runId: string, fileName: string): Promise<{ path: string; token: string } | null> {
  if (!isSupabase) return null;
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
    createdAt: r.created_at as string,
  };
}

// ---------- Çalışma ilerlemesi + AI (v2) ----------
export async function updateRunMeta(runId: string, patch: { progress?: import('./types').StageEvent[]; ai?: import('./types').AiAudit | null; status?: Run['status']; error?: string; totals?: Run['totals'] }): Promise<void> {
  if (isSupabase) {
    const db: Record<string, unknown> = {};
    if (patch.progress !== undefined) db.progress = patch.progress;
    if (patch.ai !== undefined) db.ai = patch.ai;
    if (patch.status !== undefined) db.status = patch.status;
    if (patch.error !== undefined) db.error = patch.error;
    if (patch.totals !== undefined) db.totals = patch.totals;
    const { error } = await client().from('runs').update(db).eq('id', runId);
    if (error) throw error;
    return;
  }
  const runs = await readJson<Run[]>('runs.json', []);
  const i = runs.findIndex(r => r.id === runId);
  if (i >= 0) { runs[i] = { ...runs[i], ...patch }; await writeJson('runs.json', runs); }
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
