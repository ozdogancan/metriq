import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { ensureBucketLimit, isSupabase, reserveStoredUpload, signedUploadUrl } from '@/lib/store';
import { MAX_NWD_BYTES, isAllowedNwdSize, isSafeNwdFileName } from '@/lib/upload-policy';
import { requireApiSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const denied = await requireApiSession();
  if (denied) return denied;
  try {
    const body = await req.json().catch(() => null);
    const fileName = body?.fileName;
    const fileSize = body?.fileSize;
    if (!isSafeNwdFileName(fileName)) {
      return NextResponse.json({ error: 'Geçersiz NWD dosya adı.' }, { status: 400 });
    }
    if (!isAllowedNwdSize(fileSize)) {
      return NextResponse.json({ error: 'NWD dosyası 200 MB sınırını aşıyor.' }, { status: 413 });
    }
    if (!isSupabase) return NextResponse.json({ mode: 'local' });
    await ensureBucketLimit(MAX_NWD_BYTES); // bucket sınırını politikayla hizala (fail-soft)
    const runId = randomUUID();
    const signed = await signedUploadUrl(runId, fileName);
    if (!signed) return NextResponse.json({ mode: 'local' });
    // If the browser uploads and disconnects before finalization, the private
    // object becomes eligible for automatic cleanup after four hours.
    await reserveStoredUpload(runId, fileName);
    const base = process.env.SUPABASE_URL!.replace(/\/$/, '');
    const bucket = process.env.SUPABASE_BUCKET || 'models';
    return NextResponse.json({
      mode: 'supabase',
      runId,
      path: signed.path,
      token: signed.token,
      uploadUrl: `${base}/storage/v1/object/upload/sign/${bucket}/${encodeURIComponent(signed.path)}?token=${encodeURIComponent(signed.token)}`,
    });
  } catch (e) {
    console.error('upload-url failed', e);
    return NextResponse.json({ error: 'Yükleme bağlantısı oluşturulamadı.' }, { status: 500 });
  }
}
