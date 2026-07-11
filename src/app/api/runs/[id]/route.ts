import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getRun, getRows, getSteel, saveRows, saveRun, deleteRun, addLearningEvents, resolveStaleRun } from '@/lib/store';
import { computeTotals } from '@/lib/vocab';
import { RowsPatchSchema, zodMessage } from '@/lib/schemas';
import type { LearningEvent, MtoRow } from '@/lib/types';
import { requireApiSession } from '@/lib/session';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const denied = await requireApiSession();
  if (denied) return denied;
  const { id } = await ctx.params;
  let run = await getRun(id);
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 });
  run = await resolveStaleRun(run); // 15 dk'yı aşan 'processing' → error
  // slim=1: yalnız run meta döner (rows/steel yok) — canlı polling için hafif yanıt
  if (req.nextUrl.searchParams.get('slim') === '1') {
    return NextResponse.json({ run });
  }
  const [rows, steel] = await Promise.all([getRows(id), getSteel(id)]);
  return NextResponse.json({ run, rows, steel });
}

// Öğrenme sinyali için diff'te izlenen alanlar (docs/02-learning.md)
const LEARN_FIELDS: (keyof MtoRow)[] = ['line', 'code', 'sub', 's1', 's2', 'qty', 'unit', 'remark', 'scope'];
function slim(r: MtoRow): Partial<MtoRow> {
  return { line: r.line, code: r.code, sub: r.sub, s1: r.s1, s2: r.s2, qty: r.qty, unit: r.unit, remark: r.remark, scope: r.scope };
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const denied = await requireApiSession();
  if (denied) return denied;
  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const body = await req.json().catch(() => null);
  if (body && Array.isArray(body.rows)) {
    // Satır doğrulaması (zod): bozuk sayılar totals'ı ve kayıtları kirletmesin
    const parsed = RowsPatchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: `Geçersiz satır verisi — ${zodMessage(parsed.error)}` }, { status: 400 });
    }
    const rows = parsed.data.rows as MtoRow[];
    const oldRows = await getRows(id);
    const steel = await getSteel(id);
    run.totals = computeTotals(rows, steel);
    await saveRows(id, rows);
    await saveRun(run);

    // Kullanıcı düzeltmeleri → yapılandırılmış öğrenme olayları (sistem böyle öğrenir)
    try {
      const ctxMeta = { vocab: run.vocab, fileName: run.fileName, calibrationId: run.calibrationId };
      const oldById = new Map(oldRows.map(r => [r.id, r]));
      const newById = new Map(rows.map(r => [r.id, r]));
      const events: LearningEvent[] = [];
      for (const r of rows) {
        const prev = oldById.get(r.id);
        if (!prev) {
          events.push({ id: randomUUID(), runId: id, ts: new Date().toISOString(), kind: 'row_add', before: null, after: slim(r), context: ctxMeta });
        } else if (LEARN_FIELDS.some(f => prev[f] !== r[f])) {
          events.push({ id: randomUUID(), runId: id, ts: new Date().toISOString(), kind: 'row_edit', before: slim(prev), after: slim(r), context: ctxMeta });
        }
      }
      for (const prev of oldRows) {
        if (!newById.has(prev.id)) {
          events.push({ id: randomUUID(), runId: id, ts: new Date().toISOString(), kind: 'row_delete', before: slim(prev), after: null, context: ctxMeta });
        }
      }
      await addLearningEvents(events);
    } catch (e) { console.error('learning event yazılamadı (fail-soft)', e); }
  }
  return NextResponse.json({ ok: true, totals: run.totals });
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const denied = await requireApiSession();
  if (denied) return denied;
  const { id } = await ctx.params;
  await deleteRun(id);
  return NextResponse.json({ ok: true });
}
