import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { isSupabase, signedUploadUrl } from '@/lib/store';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const { fileName } = await req.json();
    if (!fileName) return NextResponse.json({ error: 'fileName required' }, { status: 400 });
    if (!isSupabase) return NextResponse.json({ mode: 'local' });
    const runId = randomUUID();
    const signed = await signedUploadUrl(runId, fileName);
    if (!signed) return NextResponse.json({ mode: 'local' });
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
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}
