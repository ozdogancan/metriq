import { NextRequest, NextResponse } from 'next/server';
import { getRun, getRows, getSteel, saveRows, saveRun, deleteRun } from '@/lib/store';
import { computeTotals } from '@/lib/vocab';
import type { MtoRow } from '@/lib/types';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const [rows, steel] = await Promise.all([getRows(id), getSteel(id)]);
  return NextResponse.json({ run, rows, steel });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const body = await req.json();
  if (Array.isArray(body.rows)) {
    const rows = body.rows as MtoRow[];
    const steel = await getSteel(id);
    run.totals = computeTotals(rows, steel);
    await saveRows(id, rows);
    await saveRun(run);
  }
  return NextResponse.json({ ok: true, totals: run.totals });
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  await deleteRun(id);
  return NextResponse.json({ ok: true });
}
