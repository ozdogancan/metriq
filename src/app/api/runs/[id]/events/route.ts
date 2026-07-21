import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { addLearningEvents, getRun } from '@/lib/store';
import type { LearningEvent } from '@/lib/types';
import { isApiDenial, requireApiIdentity } from '@/lib/session';
import { LearningEventsRequestSchema, zodMessage } from '@/lib/schemas';
import { isUuid } from '@/lib/upload-policy';

export const runtime = 'nodejs';

// Kullanıcı düzeltmeleri = öğrenme sinyali. Her düzeltme yapılandırılmış olay olarak
// kaydedilir (docs/02-learning.md sözleşmesi) — ileride kural önerisi/eğitim verisi olur.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const identity = await requireApiIdentity();
  if (isApiDenial(identity)) return identity;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: 'geçersiz id' }, { status: 400 });
  const run = await getRun(identity, id);
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const body = await req.json().catch(() => null);
  const parsed = LearningEventsRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: `Geçersiz öğrenme olayı — ${zodMessage(parsed.error)}` }, { status: 400 });
  }
  if (!parsed.data.events.length) return NextResponse.json({ ok: true, saved: 0 });

  const events: LearningEvent[] = parsed.data.events.map(e => ({
    id: randomUUID(),
    runId: id,
    ts: new Date().toISOString(),
    kind: e.kind,
    before: e.before,
    after: e.after,
    context: { vocab: run.vocab, fileName: run.fileName, calibrationId: run.calibrationId },
  }));
  await addLearningEvents(identity, events);
  return NextResponse.json({ ok: true, saved: events.length });
}
