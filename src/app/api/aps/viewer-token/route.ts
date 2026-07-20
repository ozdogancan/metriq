// Metriq — APS Viewer erişim token'ı (yalnız viewables:read; oturum korumalı).
// İstemcideki 3B görüntüleyici modeli doğrudan Autodesk'ten akıtır; bu token
// bucket/translate yetkisi TAŞIMAZ.
import { NextResponse } from 'next/server';
import { apsEnabled, viewerToken } from '@/lib/aps';
import { requireApiSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function GET() {
  const denied = await requireApiSession();
  if (denied) return denied;
  if (!apsEnabled) return NextResponse.json({ error: 'APS yapılandırılmamış' }, { status: 404 });
  try {
    const t = await viewerToken();
    return NextResponse.json(t, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    console.error('viewer token failed', e);
    return NextResponse.json({ error: 'Viewer token alınamadı' }, { status: 502 });
  }
}
