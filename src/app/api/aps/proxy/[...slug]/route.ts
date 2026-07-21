// Metriq — APS Viewer same-origin proxy (resmî Autodesk örnek kalıbı).
// Neden: cdn.derivative.autodesk.com istekleri kullanıcı tarayıcısındaki
// gizlilik/reklam eklentilerince kesilebiliyor (gerçek vaka: sentetik 503,
// düz fetch "Failed to fetch"; curl aynı istekte 200). Viewer bu route
// üzerinden BİZİM origin'imize istek atar; sunucu viewables:read Bearer
// ekleyip Autodesk'e iletir ve yanıtı stream eder. Token istemciye çıkmaz.
import { NextRequest } from 'next/server';
import { viewerToken, apsEnabled } from '@/lib/aps';
import { authorizeViewerPath } from '@/lib/aps-viewer-policy';
import { getRun } from '@/lib/store';
import { isApiDenial, requireApiIdentity } from '@/lib/session';
import { isUuid } from '@/lib/upload-policy';

export const runtime = 'nodejs';
export const maxDuration = 60;

const UPSTREAM = 'https://cdn.derivative.autodesk.com';
const PRIVATE_NO_STORE = { 'cache-control': 'private, no-store' };

export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string[] }> }) {
  const identity = await requireApiIdentity();
  if (isApiDenial(identity)) return identity;
  if (!apsEnabled) return new Response('APS yapılandırılmamış', { status: 404 });
  const { slug } = await ctx.params;
  const [runId, ...viewerSlug] = slug;
  if (!isUuid(runId)) return new Response('geçersiz runId', { status: 400, headers: PRIVATE_NO_STORE });

  // getRun tenant_key filtresiyle fail-closed çalışır: başka tenant'ın UUID'si
  // bilinse dahi burada "not found" olur ve APS isteği hiç yapılmaz.
  const run = await getRun(identity, runId);
  if (!run?.aps?.urn) return new Response('not found', { status: 404, headers: PRIVATE_NO_STORE });
  const allowed = authorizeViewerPath(viewerSlug, run.aps.urn);
  if (!allowed) return new Response('kaynak bu metraja ait değil', { status: 403, headers: PRIVATE_NO_STORE });

  try {
    const { access_token } = await viewerToken();
    const headers: Record<string, string> = { authorization: `Bearer ${access_token}` };
    const range = req.headers.get('range');
    if (range && /^bytes=(?:\d+-\d*|-\d+)(?:,(?:\d+-\d*|-\d+))*$/.test(range) && range.length <= 160) {
      headers.range = range; // geometri paketleri Range ile akar
    }

    const upstreamUrl = new URL(`${UPSTREAM}/${allowed.upstreamPath}`);
    if (req.nextUrl.search.length > 2048) {
      return new Response('sorgu çok uzun', { status: 400, headers: PRIVATE_NO_STORE });
    }
    for (const [key, value] of req.nextUrl.searchParams) {
      // İstemciden gelen hiçbir credential APS'e taşınmaz.
      if (/^(?:access_token|token|client_id|client_secret)$/i.test(key)) continue;
      upstreamUrl.searchParams.append(key, value);
    }

    const upstream = await fetch(upstreamUrl, { headers });
    const out = new Headers();
    for (const h of ['content-type', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    }
    // Aynı tarayıcı profili daha sonra başka bir Metriq kullanıcısına geçebilir;
    // kimlik-bağımlı model baytlarını browser cache'inde de kalıcı tutma.
    out.set('cache-control', 'private, no-store');
    out.set('x-content-type-options', 'nosniff');
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch (error) {
    console.error('APS viewer proxy failed', error);
    return new Response('APS görüntüleme isteği başarısız', { status: 502, headers: PRIVATE_NO_STORE });
  }
}
