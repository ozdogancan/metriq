// Metriq — müşteri cevap Excel'i yükleme: run ↔ ground truth karşılaştırması.
// Sonuç run.answer'a kalıcı yazılır + öğrenme günlüğüne run_feedback olayı düşer.
import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomUUID } from 'node:crypto';
import { getRun, getRows, recordAnswerComparison } from '@/lib/store';
import { parseAnswerXlsx, compareAnswer } from '@/lib/answer-compare';
import { MAX_ANSWER_XLSX_BYTES } from '@/lib/upload-policy';
import { getSessionUser, requireApiSession } from '@/lib/session';

export const runtime = 'nodejs';
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const denied = await requireApiSession();
  if (denied) return denied;
  const actor = (await getSessionUser())!;
  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (run.status !== 'done') {
    return NextResponse.json({ error: 'Karşılaştırma için metrajın tamamlanmış olması gerekir.' }, { status: 409 });
  }
  try {
    const fd = await req.formData();
    const file = fd.get('file') as File | null;
    if (!file) return NextResponse.json({ error: 'dosya eksik' }, { status: 400 });
    if (!/\.(?:xlsx|xlsm)$/i.test(file.name)) {
      return NextResponse.json({ error: 'Cevap dosyası .xlsx veya .xlsm olmalı.' }, { status: 400 });
    }
    if (file.size <= 0 || file.size > MAX_ANSWER_XLSX_BYTES) {
      return NextResponse.json({ error: 'Cevap dosyası 4 MB sınırını aşıyor.' }, { status: 413 });
    }
    const buf = Buffer.from(await file.arrayBuffer());
    const { rows: answerRows, sheet } = await parseAnswerXlsx(buf);
    if (!answerRows.length) {
      return NextResponse.json({ error: 'Cevap dosyasında satır bulunamadı.' }, { status: 400 });
    }
    const ours = await getRows(id);
    const comparisonId = randomUUID();
    const diff = compareAnswer(ours, answerRows, file.name, sheet, {
      comparisonId,
      baseRowsRevision: run.rowRevision ?? 0,
    });
    await recordAnswerComparison({
      id: comparisonId,
      runId: id,
      baseRowRevision: run.rowRevision ?? 0,
      baseRowsHash: diff.baseRowsHash!,
      answerSha256: createHash('sha256').update(buf).digest('hex'),
      sourceFileName: file.name,
      sourceSheet: sheet,
      diff,
      createdBy: actor,
      expectedComparisonRevision: run.comparisonRevision ?? 0,
      learningEventId: randomUUID(),
    });

    return NextResponse.json({ answer: diff });
  } catch (e) {
    console.error('answer compare failed', e);
    if ((e as { code?: string }).code === 'PT409' || (e instanceof Error && /CONFLICT|STALE/.test(e.message))) {
      return NextResponse.json({ error: 'Metraj bu sırada değişti; cevap dosyasını yeniden karşılaştırın.' }, { status: 409 });
    }
    const msg = e instanceof Error && e.message.startsWith('Cevap dosya')
      ? e.message
      : 'Cevap dosyası güvenli biçimde işlenemedi.';
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
