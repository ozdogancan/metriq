import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { listCalibrations, saveCalibration, deleteCalibration } from '@/lib/store';
import type { Calibration } from '@/lib/types';

export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json(await listCalibrations());
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const now = new Date().toISOString();
    const cal: Calibration = {
      id: body.id || randomUUID(),
      name: body.name || 'Kalibrasyon',
      rules: body.rules,
      learnedFrom: body.learnedFrom || [],
      createdAt: body.createdAt || now,
      updatedAt: now,
    };
    await saveCalibration(cal);
    return NextResponse.json(cal);
  } catch (e) {
    console.error('calibration save failed', e);
    return NextResponse.json({ error: 'save failed' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  await deleteCalibration(id);
  return NextResponse.json({ ok: true });
}
