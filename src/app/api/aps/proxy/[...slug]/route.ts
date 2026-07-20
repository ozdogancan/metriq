// Metriq — APS Viewer same-origin proxy (resmî Autodesk örnek kalıbı).
// Neden: cdn.derivative.autodesk.com istekleri kullanıcı tarayıcısındaki
// gizlilik/reklam eklentilerince kesilebiliyor (gerçek vaka: sentetik 503,
// düz fetch "Failed to fetch"; curl aynı istekte 200). Viewer bu route
// üzerinden BİZİM origin'imize istek atar; sunucu viewables:read Bearer
// ekleyip Autodesk'e iletir ve yanıtı stream eder. Token istemciye çıkmaz.
import { NextRequest } from 'next/server';
import { viewerToken, apsEnabled } from '@/lib/aps';
import { requireApiSession } from '@/lib/session';

export const runtime = 'nodejs';
export const maxDuration = 60;

const UPSTREAM = 'https://cdn.derivative.autodesk.com';
// yalnız viewer'ın ihtiyacı olan türetilmiş-veri yolları geçer
const ALLOWED = /^derivativeservice\/v2\//;

export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string[] }> }) {
  const denied = await requireApiSession();
  if (denied) return denied;
  if (!apsEnabled) return new Response('APS yapılandırılmamış', { status: 404 });
  const { slug } = await ctx.params;
  const path = slug.map(encodeURIComponent).join('/');
  // urn'ler base64url + nokta içerir; encodeURIComponent bunları bozmaz
  if (!ALLOWED.test(slug.join('/'))) return new Response('yol izinli değil', { status: 403 });
  const { access_token } = await viewerToken();
  const headers: Record<string, string> = { authorization: `Bearer ${access_token}` };
  const range = req.headers.get('range');
  if (range) headers.range = range; // geometri paketleri Range ile akar
  const upstream = await fetch(`${UPSTREAM}/${path}${req.nextUrl.search}`, { headers });
  const out = new Headers();
  for (const h of ['content-type', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  out.set('cache-control', 'private, max-age=3600'); // türetilmiş veri değişmez — tekrar açılış hızlı
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
