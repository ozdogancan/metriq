// Metriq — müşteri cevap Excel'i yükleme: run ↔ ground truth karşılaştırması.
// Sonuç run.answer'a kalıcı yazılır + öğrenme günlüğüne run_feedback olayı düşer.
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getRun, getRows, updateRunMeta, addLearningEvents } from '@/lib/store';
import { parseAnswerXlsx, compareAnswer } from '@/lib/answer-compare';
import { MAX_ANSWER_XLSX_BYTES } from '@/lib/upload-policy';
import { requireApiSession } from '@/lib/session';

export const runtime = 'nodejs';
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const denied = await requireApiSession();
  if (denied) return denied;
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
    if (!/\.xlsx$/i.test(file.name)) {
      return NextResponse.json({ error: 'Cevap dosyası .xlsx olmalı.' }, { status: 400 });
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
    const diff = compareAnswer(ours, answerRows, file.name, sheet);
    await updateRunMeta(id, { answer: diff });

    // öğrenme sinyali: gerçek cevapla ölçülen fark (fail-soft)
    try {
      await addLearningEvents([{
        id: randomUUID(), runId: id, ts: new Date().toISOString(), kind: 'run_feedback',
        before: null,
        after: { accuracy: diff.accuracy, counts: diff.counts, fileName: diff.fileName },
        context: { vocab: run.vocab, fileName: run.fileName, calibrationId: run.calibrationId },
      }]);
    } catch (e) { console.error('run_feedback yazılamadı (fail-soft)', e); }

    return NextResponse.json({ answer: diff });
  } catch (e) {
    console.error('answer compare failed', e);
    const msg = e instanceof Error && e.message.startsWith('Cevap dosya')
      ? e.message
      : 'Cevap dosyası güvenli biçimde işlenemedi.';
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
