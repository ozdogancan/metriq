import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { randomUUID } from 'node:crypto';
import {
  listRuns, saveRun, saveRows, saveSteel, storeFile, fetchStoredFile, listCalibrations,
  updateRunMeta, addNotification, listPushSubscriptions, removePushSubscription,
} from '@/lib/store';
import { parseNwd } from '@/lib/parser/nwd';
import { applyRules } from '@/lib/vocab';
import { computeComplexity, runAudit, aiEnabled } from '@/lib/ai';
import { DEFAULT_RULES, STAGE_ORDER, type Run, type StageEvent, type VocabProfileId, type CalibrationRules } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET() {
  return NextResponse.json(await listRuns());
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
  if (!pub || !priv) return;
  const subs = await listPushSubscriptions();
  if (!subs.length) return;
  const webpush = (await import('web-push')).default;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:canozdogan@outlook.com', pub, priv);
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
async function processRun(run: Run, buf: Buffer, rules: CalibrationRules, lang: 'tr' | 'en') {
  let stages = run.progress ?? freshStages();
  const push = async () => updateRunMeta(run.id, { progress: stages });
  const t0 = Date.now();
  try {
    stages = stageSet(stages, 'upload', 'done', { 'MB': +(run.fileSize / 1e6).toFixed(1) });
    stages = stageSet(stages, 'scan', 'active');
    await push();

    const parsed = parseNwd(buf);

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
    await addNotification({
      id: randomUUID(), kind: 'run_done', title, body,
      url: `/runs/${run.id}`, read: false, createdAt: new Date().toISOString(),
    });
    await sendPush({ title, body, url: `/runs/${run.id}`, tag: `run-${run.id}` });
  } catch (e) {
    console.error('pipeline hata', e);
    const msg = e instanceof Error ? e.message : 'işleme hatası';
    await updateRunMeta(run.id, { status: 'error', error: msg, progress: stages });
    const title = lang === 'tr' ? `Metraj başarısız: ${run.projectName}` : `Take-off failed: ${run.projectName}`;
    await addNotification({
      id: randomUUID(), kind: 'run_error', title, body: msg,
      url: `/runs/${run.id}`, read: false, createdAt: new Date().toISOString(),
    });
    await sendPush({ title, body: msg, url: `/runs/${run.id}`, tag: `run-${run.id}` });
  }
}

export async function POST(req: NextRequest) {
  try {
    let buf: Buffer;
    let meta: { projectName: string; vocab: VocabProfileId; calibrationId: string | null; fileName: string };
    let runId = randomUUID();
    let fileSize = 0;

    const ctype = req.headers.get('content-type') || '';
    if (ctype.includes('multipart/form-data')) {
      const fd = await req.formData();
      const file = fd.get('file') as File | null;
      if (!file) return NextResponse.json({ error: 'file missing' }, { status: 400 });
      meta = JSON.parse(String(fd.get('meta') || '{}'));
      buf = Buffer.from(await file.arrayBuffer());
      fileSize = buf.length;
      await storeFile(runId, meta.fileName || file.name, buf);
    } else {
      const body = await req.json();
      meta = body;
      runId = body.runId || runId;
      fileSize = body.fileSize || 0;
      buf = await fetchStoredFile(body.storagePath);
      fileSize = fileSize || buf.length;
    }

    // kurallar: kalibrasyon > profil varsayılanı
    let rules = DEFAULT_RULES[meta.vocab] ?? DEFAULT_RULES['steel-plant'];
    if (meta.calibrationId) {
      const cal = (await listCalibrations()).find(c => c.id === meta.calibrationId);
      if (cal) rules = cal.rules;
    }

    const lang = (req.cookies.get('lang')?.value === 'en' ? 'en' : 'tr') as 'tr' | 'en';
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

    // yanıttan SONRA işle — istemci /runs/[id]'de canlı pipeline'ı izler
    after(() => processRun(run, buf, rules, lang));

    return NextResponse.json({ id: runId, status: 'processing' });
  } catch (e) {
    console.error('run create failed', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'parse failed' }, { status: 500 });
  }
}
