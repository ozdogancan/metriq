import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { addLearningEvents, getRun } from '@/lib/store';
import type { LearningEvent } from '@/lib/types';
import { requireApiSession } from '@/lib/session';

export const runtime = 'nodejs';

// Kullanıcı düzeltmeleri = öğrenme sinyali. Her düzeltme yapılandırılmış olay olarak
// kaydedilir (docs/02-learning.md sözleşmesi) — ileride kural önerisi/eğitim verisi olur.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireApiSession();
  if (denied) return denied;
  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const body = await req.json().catch(() => null);
  const incoming = Array.isArray(body?.events) ? body.events : [];
  if (!incoming.length) return NextResponse.json({ ok: true, saved: 0 });

  const events: LearningEvent[] = incoming.slice(0, 200).map((e: Partial<LearningEvent>) => ({
    id: randomUUID(),
    runId: id,
    ts: new Date().toISOString(),
    kind: (['row_edit', 'row_add', 'row_delete', 'calibration_saved', 'run_feedback'].includes(e.kind as string)
      ? e.kind : 'row_edit') as LearningEvent['kind'],
    before: e.before ?? null,
    after: e.after ?? null,
    context: { vocab: run.vocab, fileName: run.fileName, calibrationId: run.calibrationId },
  }));
  await addLearningEvents(events);
  return NextResponse.json({ ok: true, saved: events.length });
}
