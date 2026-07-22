// Metriq — kalibrasyon kararlarını uygula: "cevabı komple kabul / satır satır / özel değer".
// Teklif-kritik yazma yolu: idempotencyKey (çift tık güvenli) + rowRevision/rowsHash
// bayatlık korumaları + profil sürüm kontrolü. Satırlar, profil ve karne TEK
// commit'te güncellenir (Supabase'de RPC transaction'ı, yerelde eşdeğer sıra).
import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomUUID } from 'node:crypto';
import {
  getRun, getRows, getSteel, getAnswerComparison,
  getCalibrationCommitResult, applyAnswerCalibration, listCalibrations,
} from '@/lib/store';
import { CalibrationApplySchema, zodMessage } from '@/lib/schemas';
import {
  applyCalibrationDecisions, deriveCalibrationRules, projectedAccuracy,
  type CalibrationDecisionInput,
} from '@/lib/calibration-core';
import { compareAnswer, hashMtoRows, type AnswerRow } from '@/lib/answer-compare';
import { computeTotals } from '@/lib/vocab';
import { DEFAULT_RULES } from '@/lib/types';
import { isApiDenial, requireApiIdentity } from '@/lib/session';

export const runtime = 'nodejs';
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const identity = await requireApiIdentity();
  if (isApiDenial(identity)) return identity;
  const actor = identity.email;
  const { id } = await ctx.params;

  const raw = await req.json().catch(() => null);
  const parsed = CalibrationApplySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: `Geçersiz kalibrasyon isteği — ${zodMessage(parsed.error)}` }, { status: 400 });
  }
  const body = parsed.data;
  // İstek imzası: aynı idempotencyKey YALNIZ birebir aynı içerikle tekrar edilebilir.
  const requestHash = createHash('sha256').update(JSON.stringify({
    comparisonId: body.comparisonId, profileId: body.profileId ?? null,
    expectedProfileVersion: body.expectedProfileVersion, profileName: body.profileName,
    decisions: body.decisions,
    // kapsam kuralları da imzaya girer: aynı anahtarla farklı kural seti
    // gönderilirse replay sayılıp sessizce yutulmamalı
    acceptScopeRules: [...(body.acceptScopeRules ?? [])].sort(),
  })).digest('hex');

  try {
    const run = await getRun(identity, id);
    if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 });

    // Çift gönderim: önceki commit varsa sonucunu aynen döndür (yan etkisiz).
    const existing = await getCalibrationCommitResult(identity, body.idempotencyKey, requestHash, id);
    if (existing) {
      return NextResponse.json({ ...existing, answer: run.answer, totals: run.totals });
    }

    const comparison = await getAnswerComparison(identity, body.comparisonId);
    if (!comparison || comparison.runId !== id || run.answer?.id !== body.comparisonId) {
      return NextResponse.json({ error: 'Karşılaştırma bulunamadı ya da güncel değil — cevabı yeniden yükleyin.' }, { status: 409 });
    }
    if ((run.rowRevision ?? 0) !== comparison.baseRowRevision) {
      return NextResponse.json({ error: 'Satırlar karşılaştırmadan sonra değişti — cevabı yeniden karşılaştırın.' }, { status: 409 });
    }
    const currentRows = await getRows(identity, id);
    if (hashMtoRows(currentRows) !== comparison.baseRowsHash) {
      return NextResponse.json({ error: 'Satır içeriği karşılaştırmayla uyuşmuyor — cevabı yeniden karşılaştırın.' }, { status: 409 });
    }

    // Hedef profil: verilmişse o profil güncellenir; verilmemişse run'ın
    // profili (otomatik uygulanmış olabilir) ya da yepyeni bir profil.
    const cals = await listCalibrations(identity);
    // profileId yokluğu UI'daki açık "+ Yeni profil" seçimidir. Run'ın daha
    // önce kullandığı profiline sessizce düşmek yeni profili overwrite ederdi.
    const targetId = body.profileId ?? randomUUID();
    const target = cals.find(c => c.id === targetId);
    if (body.profileId && !target) {
      return NextResponse.json({ error: 'Seçilen profil bulunamadı.' }, { status: 404 });
    }
    const runModelFamily = run.analysis?.family && run.analysis.family !== 'plant3d-local'
      ? 'aps' : 'plant3d-local';
    if (target && (target.rules.vocab !== run.vocab
      || (target.modelFamily !== undefined && target.modelFamily !== 'legacy'
        && target.modelFamily !== runModelFamily))) {
      return NextResponse.json({ error: 'Seçilen profil bu model ailesiyle uyumlu değil.' }, { status: 400 });
    }
    const expectedProfileVersion = target ? (body.profileId ? body.expectedProfileVersion : (target.version ?? 1)) : 0;
    if (body.profileId && (target!.version ?? 1) !== body.expectedProfileVersion) {
      return NextResponse.json({ error: 'Profil başka bir işlemde değişti — sayfayı yenileyin.' }, { status: 409 });
    }
    const baseRules = target?.rules ?? DEFAULT_RULES[run.vocab];

    // Kararları uygula (eksik karar = 400; kaynak satır kayması = 409 sınıfı)
    const decisions = body.decisions as CalibrationDecisionInput[];
    const newRows = applyCalibrationDecisions(currentRows, comparison.diff, decisions,
      () => `cal-${randomUUID().slice(0, 12)}`);
    const steel = await getSteel(identity, id);
    const totals = computeTotals(newRows, steel);

    // Karne, uygulama SONRASI satırlarla yeniden ölçülür (aynı cevap verisiyle).
    const answerRows: AnswerRow[] = comparison.diff.rows
      .filter(r => r.answerSide)
      .map(r => ({ ...r.answerSide!.value }));
    const answerAfter = compareAnswer(newRows, answerRows, comparison.diff.fileName, comparison.diff.sheet, {
      comparisonId: comparison.diff.id,
      baseRowsRevision: (run.rowRevision ?? 0) + 1,
    });
    // Model-dışı kalemler yeniden-karşılaştırmada kaybolmasın (diff.rows'ta
    // yoklar; kaynak karşılaştırmadan aynen taşınırlar)
    if (comparison.diff.externalItems?.length) answerAfter.externalItems = comparison.diff.externalItems;
    answerAfter.appliedAt = new Date().toISOString();
    answerAfter.calibrationVersion = expectedProfileVersion + 1;
    answerAfter.projectedAccuracy = projectedAccuracy(comparison.diff, decisions);

    // Kurallar kararlardan türetilir. Geniş etkili dönüşümler bağımsız model
    // kanıtı biriktirene kadar candidate kalır; yalnız active kurallar uygulanır.
    const derived = deriveCalibrationRules(baseRules, comparison.diff, decisions, () => randomUUID(), id);
    // Kapsam kuralları: kullanıcı "bunları da teklife kat" dediyse bayrağı aç.
    // Yalnız sistemin O KARŞILAŞTIRMADA gerçekten önerdikleri kabul edilir —
    // istemci keyfi bayrak gönderemez.
    const offered = new Set((comparison.diff.scopeSuggestions ?? []).map(s => s.rule));
    const acceptedScopeRules = (body.acceptScopeRules ?? []).filter(rule => offered.has(rule));
    for (const rule of acceptedScopeRules) derived.rules[rule] = true;
    const learnedFrom = [...new Set([...(target?.learnedFrom ?? []), id])];

    const result = await applyAnswerCalibration(identity, {
      runId: id,
      comparisonId: body.comparisonId,
      commitId: body.idempotencyKey,
      requestHash,
      expectedRowRevision: run.rowRevision ?? 0,
      expectedProfileVersion,
      calibrationId: targetId,
      calibrationName: body.profileName,
      rules: derived.rules,
      learnedFrom,
      decisions: body.decisions,
      rows: newRows,
      rowsAfterHash: answerAfter.baseRowsHash!,
      totals,
      answerAfter,
      metricsAfter: {
        accuracyBefore: comparison.diff.accuracy,
        accuracyAfter: answerAfter.accuracy,
        activatedRules: derived.activatedRules,
        candidateRules: derived.candidateRules,
        recordedExamples: derived.recordedExamples,
      },
      actor,
      learningEventId: randomUUID(),
      calibrationModelFamily: target?.modelFamily ?? runModelFamily,
      calibrationClientKey: target?.clientKey ?? 'default',
      calibrationStatus: target?.status === 'draft' ? 'draft' : 'active',
    });

    return NextResponse.json({
      ...result,
      answer: answerAfter,
      totals,
      learned: {
        activatedRules: derived.activatedRules,
        candidateRules: derived.candidateRules,
        recordedExamples: derived.recordedExamples,
      },
    });
  } catch (e) {
    console.error('calibration apply failed', e);
    const msg = e instanceof Error ? e.message : '';
    if (msg.startsWith('Karar eksik')) {
      return NextResponse.json({ error: 'Her fark için bir karar verilmeli.' }, { status: 400 });
    }
    if ((e as { code?: string }).code === 'PT409' || /CONFLICT|STALE|REUSED|değişmiş/.test(msg)) {
      return NextResponse.json({ error: 'Veriler bu sırada değişti — sayfayı yenileyip tekrar deneyin.' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Kalibrasyon uygulanamadı.' }, { status: 500 });
  }
}
