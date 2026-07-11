import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { listCalibrations, saveCalibration, deleteCalibration } from '@/lib/store';
import { CalibrationPostSchema, zodMessage } from '@/lib/schemas';
import type { Calibration } from '@/lib/types';
import { requireApiSession } from '@/lib/session';
import { isUuid } from '@/lib/upload-policy';

export const runtime = 'nodejs';

export async function GET() {
  const denied = await requireApiSession();
  if (denied) return denied;
  return NextResponse.json(await listCalibrations());
}

export async function POST(req: NextRequest) {
  const denied = await requireApiSession();
  if (denied) return denied;
  try {
    const raw = await req.json().catch(() => null);
    if (!raw || typeof raw !== 'object') {
      return NextResponse.json({ error: 'Geçersiz istek gövdesi — JSON obje bekleniyor.' }, { status: 400 });
    }
    // Doğrulama (zod): bozuk kurallar sonraki tüm run'ları kirletir — fail-fast
    const parsed = CalibrationPostSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: `Geçersiz kalibrasyon — ${zodMessage(parsed.error)}` }, { status: 400 });
    }
    const body = parsed.data;
    const now = new Date().toISOString();
    const cal: Calibration = {
      id: body.id || randomUUID(),
      name: body.name,
      rules: body.rules,
      learnedFrom: body.learnedFrom,
      createdAt: (typeof raw.createdAt === 'string' && raw.createdAt) || now,
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
  const denied = await requireApiSession();
  if (denied) return denied;
  const id = req.nextUrl.searchParams.get('id');
  if (!isUuid(id)) return NextResponse.json({ error: 'geçersiz id' }, { status: 400 });
  try {
    await deleteCalibration(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('calibration delete failed', e);
    return NextResponse.json({ error: 'silme başarısız' }, { status: 500 });
  }
}
