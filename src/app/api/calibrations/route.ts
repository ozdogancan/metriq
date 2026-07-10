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
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Geçersiz istek gövdesi — JSON obje bekleniyor.' }, { status: 400 });
    }
    // Doğrulama: bozuk kurallar sonraki tüm run'ları kirletir — fail-fast
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return NextResponse.json({ error: 'name zorunlu — boş olamaz.' }, { status: 400 });
    }
    const rules = body.rules;
    if (!rules || typeof rules !== 'object' || Array.isArray(rules)) {
      return NextResponse.json({ error: 'rules zorunlu bir obje olmalı.' }, { status: 400 });
    }
    if (rules.vocab !== 'steel-plant' && rules.vocab !== 'hygienic') {
      return NextResponse.json({ error: "rules.vocab 'steel-plant' veya 'hygienic' olmalı." }, { status: 400 });
    }
    if (typeof rules.grossPipeFactor !== 'number' || !Number.isFinite(rules.grossPipeFactor)
      || rules.grossPipeFactor < 0.5 || rules.grossPipeFactor > 2) {
      return NextResponse.json({ error: 'rules.grossPipeFactor 0.5–2 aralığında bir sayı olmalı.' }, { status: 400 });
    }
    if (!rules.codeRenames || typeof rules.codeRenames !== 'object' || Array.isArray(rules.codeRenames)) {
      return NextResponse.json({ error: 'rules.codeRenames bir obje olmalı.' }, { status: 400 });
    }
    const now = new Date().toISOString();
    const cal: Calibration = {
      id: body.id || randomUUID(),
      name,
      rules,
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
