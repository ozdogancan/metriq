import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { listCalibrations, saveCalibration, deleteCalibration, getRun } from '@/lib/store';
import { CalibrationPostSchema, zodMessage } from '@/lib/schemas';
import { isApiDenial, requireApiIdentity } from '@/lib/session';
import { isUuid } from '@/lib/upload-policy';

export const runtime = 'nodejs';

export async function GET() {
  const identity = await requireApiIdentity();
  if (isApiDenial(identity)) return identity;
  return NextResponse.json(await listCalibrations(identity));
}

export async function POST(req: NextRequest) {
  const identity = await requireApiIdentity();
  if (isApiDenial(identity)) return identity;
  const actor = identity.email;
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
    let modelFamily = body.modelFamily;
    if (!Object.prototype.hasOwnProperty.call(raw, 'modelFamily') && body.learnedFrom.length) {
      const sourceRun = await getRun(identity, body.learnedFrom[body.learnedFrom.length - 1]);
      if (sourceRun) modelFamily = sourceRun.analysis?.family && sourceRun.analysis.family !== 'plant3d-local'
        ? 'aps' : 'plant3d-local';
    }
    const cal = {
      id: body.id || randomUUID(),
      name: body.name,
      rules: body.rules,
      learnedFrom: body.learnedFrom,
      version: body.expectedVersion,
      createdAt: now,
      updatedAt: now,
      modelFamily,
      clientKey: body.clientKey,
      status: body.status,
    };
    const saved = await saveCalibration(identity, cal, body.expectedVersion, actor);
    return NextResponse.json(saved);
  } catch (e) {
    console.error('calibration save failed', e);
    if ((e as { code?: string }).code === 'PT409' || (e instanceof Error && e.message.includes('CONFLICT'))) {
      return NextResponse.json({ error: 'Profil başka bir işlemde değişti; sayfayı yenileyip tekrar deneyin.' }, { status: 409 });
    }
    return NextResponse.json({ error: 'save failed' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const identity = await requireApiIdentity();
  if (isApiDenial(identity)) return identity;
  const actor = identity.email;
  const id = req.nextUrl.searchParams.get('id');
  if (!isUuid(id)) return NextResponse.json({ error: 'geçersiz id' }, { status: 400 });
  const version = Number(req.nextUrl.searchParams.get('version'));
  if (!Number.isInteger(version) || version < 1) {
    return NextResponse.json({ error: 'geçersiz profil sürümü' }, { status: 400 });
  }
  try {
    await deleteCalibration(identity, id, version, actor);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('calibration delete failed', e);
    if ((e as { code?: string }).code === 'PT409' || (e instanceof Error && e.message.includes('CONFLICT'))) {
      return NextResponse.json({ error: 'Profil başka bir işlemde değişti; sayfayı yenileyin.' }, { status: 409 });
    }
    return NextResponse.json({ error: 'silme başarısız' }, { status: 500 });
  }
}
