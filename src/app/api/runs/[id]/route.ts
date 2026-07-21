import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { applyRunFeedback, getRun, getRows, getSteel, deleteRun } from '@/lib/store';
import { computeTotals } from '@/lib/vocab';
import { hashMtoRows } from '@/lib/answer-compare';
import { RowsPatchSchema, zodMessage } from '@/lib/schemas';
import type { LearningEvent, MtoRow } from '@/lib/types';
import { isApiDenial, requireApiIdentity } from '@/lib/session';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const identity = await requireApiIdentity();
  if (isApiDenial(identity)) return identity;
  const { id } = await ctx.params;
  const run = await getRun(identity, id);
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 });
  // slim=1: yalnız run meta döner (rows/steel yok) — canlı polling için hafif yanıt
  if (req.nextUrl.searchParams.get('slim') === '1') {
    return NextResponse.json({ run });
  }
  const [rows, steel] = await Promise.all([getRows(identity, id), getSteel(identity, id)]);
  return NextResponse.json({ run, rows, steel });
}

// Öğrenme sinyali için diff'te izlenen alanlar (docs/02-learning.md)
const LEARN_FIELDS: (keyof MtoRow)[] = ['line', 'code', 'sub', 's1', 's2', 'qty', 'unit', 'remark', 'scope'];
function slim(r: MtoRow): Partial<MtoRow> {
  return { line: r.line, code: r.code, sub: r.sub, s1: r.s1, s2: r.s2, qty: r.qty, unit: r.unit, remark: r.remark, scope: r.scope };
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const identity = await requireApiIdentity();
  if (isApiDenial(identity)) return identity;
  const { id } = await ctx.params;
  const run = await getRun(identity, id);
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (run.status !== 'done') {
    return NextResponse.json({ error: 'İşlem sürerken metraj satırları düzenlenemez.' }, { status: 409 });
  }
  const body = await req.json().catch(() => null);
  if (body && Array.isArray(body.rows)) {
    // Satır doğrulaması (zod): bozuk sayılar totals'ı ve kayıtları kirletmesin
    const parsed = RowsPatchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: `Geçersiz satır verisi — ${zodMessage(parsed.error)}` }, { status: 400 });
    }
    const rows = parsed.data.rows as MtoRow[];
    if ((run.rowRevision ?? 0) !== parsed.data.expectedRowRevision) {
      return NextResponse.json({ error: 'Satırlar başka bir sekmede değişti — sayfayı yenileyin.' }, { status: 409 });
    }
    const oldRows = await getRows(identity, id);
    const steel = await getSteel(identity, id);
    const totals = computeTotals(rows, steel);
    const oldById = new Map(oldRows.map(r => [r.id, r]));
    const newById = new Map(rows.map(r => [r.id, r]));
    const changes: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const prev = oldById.get(row.id);
      if (!prev) changes.push({ kind: 'row_add', before: null, after: slim(row) });
      else if (LEARN_FIELDS.some(field => prev[field] !== row[field])) {
        changes.push({ kind: 'row_edit', before: slim(prev), after: slim(row) });
      }
    }
    for (const prev of oldRows) {
      if (!newById.has(prev.id)) changes.push({ kind: 'row_delete', before: slim(prev), after: null });
    }
    if (!changes.length) {
      return NextResponse.json({ ok: true, totals, rowRevision: run.rowRevision ?? 0 });
    }
    const context = { vocab: run.vocab, fileName: run.fileName, calibrationId: run.calibrationId };
    const event: LearningEvent = {
      id: randomUUID(), runId: id, ts: new Date().toISOString(), kind: 'run_feedback',
      before: { rowsHash: run.rowsHash ?? hashMtoRows(oldRows) },
      after: { source: 'manual_rows', changeCount: changes.length, changes: changes.slice(0, 1000) },
      context,
    };
    try {
      const result = await applyRunFeedback(identity, {
        runId: id,
        expectedRowRevision: parsed.data.expectedRowRevision,
        expectedRowsHash: run.rowsHash ?? hashMtoRows(oldRows),
        rows,
        rowsAfterHash: hashMtoRows(rows),
        totals,
        actor: identity.email,
        events: [event],
      });
      return NextResponse.json({ ok: true, totals, rowRevision: result.rowRevision });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if ((error as { code?: string }).code === 'PT409' || /CONFLICT|NOT_DONE/.test(message)) {
        return NextResponse.json({ error: 'Satırlar bu sırada değişti — sayfayı yenileyin.' }, { status: 409 });
      }
      throw error;
    }
  }
  return NextResponse.json({ error: 'rows missing' }, { status: 400 });
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const identity = await requireApiIdentity();
  if (isApiDenial(identity)) return identity;
  const { id } = await ctx.params;
  await deleteRun(identity, id);
  return NextResponse.json({ ok: true });
}
