// Metriq — Autodesk Platform Services istemcisi (Model Derivative).
// Plant3D-olmayan NWD'ler (Revit MEP vb.) için bulut çıkarım yolu: string-kazıma
// bu dosyalarda boru uzunluğuna ULAŞAMAZ (binary parametre); APS temiz property döner.
// Maliyet: NWD çevirisi 0.5 token/dosya — yalnız yerel parser 0 komponent verdiğinde kullanılır.
import 'server-only';

const BASE = 'https://developer.api.autodesk.com';
const ID = process.env.APS_CLIENT_ID;
const SECRET = process.env.APS_CLIENT_SECRET;

export const apsEnabled = Boolean(ID && SECRET);

// Bucket adı client-id'den türetilir (global benzersizlik) — transient: 24 saat saklama yeter
const BUCKET = ID ? `metriq-${ID.toLowerCase().slice(0, 12)}-runs` : '';

let cachedToken: { value: string; exp: number } | null = null;
async function token(scope = 'data:read data:write data:create bucket:create bucket:read'): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.exp - 60_000) return cachedToken.value;
  const r = await fetch(`${BASE}/authentication/v2/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: 'Basic ' + Buffer.from(`${ID}:${SECRET}`).toString('base64'),
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('APS token alınamadı: ' + JSON.stringify(d).slice(0, 120));
  cachedToken = { value: d.access_token, exp: Date.now() + (d.expires_in ?? 3600) * 1000 };
  return d.access_token;
}

async function authed(path: string, init: RequestInit = {}): Promise<Response> {
  const t = await token();
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${t}` },
  });
}

// Viewer için DAR kapsamlı token (yalnız viewables:read) — istemciye bu verilir,
// bucket/translate yetkisi taşımaz. Ayrı cache: ana token'la kapsam karışmasın.
let cachedViewerToken: { value: string; exp: number } | null = null;
export async function viewerToken(): Promise<{ access_token: string; expires_in: number }> {
  if (cachedViewerToken && Date.now() < cachedViewerToken.exp - 120_000) {
    return { access_token: cachedViewerToken.value, expires_in: Math.floor((cachedViewerToken.exp - Date.now()) / 1000) };
  }
  const r = await fetch(`${BASE}/authentication/v2/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: 'Basic ' + Buffer.from(`${ID}:${SECRET}`).toString('base64'),
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'viewables:read' }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('APS viewer token alınamadı');
  cachedViewerToken = { value: d.access_token, exp: Date.now() + (d.expires_in ?? 3600) * 1000 };
  return { access_token: d.access_token, expires_in: d.expires_in ?? 3600 };
}

export function toUrn(objectId: string): string {
  return Buffer.from(objectId).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// NWD'yi APS'e yükle + çeviri işini başlat → { urn } (çeviri ASENKRON sürer)
export async function apsSubmit(objectKey: string, buf: Buffer): Promise<{ urn: string }> {
  // bucket (409 = zaten var)
  const b = await authed('/oss/v2/buckets', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ads-region': 'US' },
    body: JSON.stringify({ bucketKey: BUCKET, policyKey: 'transient' }),
  });
  if (![200, 409].includes(b.status)) throw new Error('APS bucket: ' + (await b.text()).slice(0, 150));

  const su = await (await authed(
    `/oss/v2/buckets/${BUCKET}/objects/${encodeURIComponent(objectKey)}/signeds3upload?minutesExpiration=30`,
  )).json();
  if (!su.urls?.length) throw new Error('APS signed upload alınamadı');
  const put = await fetch(su.urls[0], { method: 'PUT', body: new Uint8Array(buf) });
  if (!put.ok) throw new Error('APS S3 PUT ' + put.status);
  const done = await (await authed(
    `/oss/v2/buckets/${BUCKET}/objects/${encodeURIComponent(objectKey)}/signeds3upload`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadKey: su.uploadKey }) },
  )).json();
  if (!done.objectId) throw new Error('APS upload complete: ' + JSON.stringify(done).slice(0, 150));

  const urn = toUrn(done.objectId);
  const job = await authed('/modelderivative/v2/designdata/job', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ads-force': 'true' },
    body: JSON.stringify({ input: { urn }, output: { formats: [{ type: 'svf', views: ['3d'] }] } }),
  });
  if (!job.ok) throw new Error('APS translate job: ' + (await job.text()).slice(0, 150));
  return { urn };
}

// Yalnız çeviri durumu (property İNDİRMEDEN) — sonradan-3B akışı için hafif poll.
// apsAdvance'ten farkı: ready'de koleksiyon çekmez; satırlar zaten yerelden var.
export async function apsManifestPhase(urn: string, knownGuid?: string): Promise<
  | { phase: 'translating'; progress: string }
  | { phase: 'failed'; message: string }
  | { phase: 'ready'; guid: string }
> {
  const m = await (await authed(`/modelderivative/v2/designdata/${urn}/manifest`)).json();
  if (m.status === 'failed' || m.status === 'timeout') {
    const msg = m.derivatives?.flatMap((d: { messages?: { message?: string }[] }) => d.messages ?? [])
      .map((x: { message?: string }) => x.message).filter(Boolean).join('; ');
    return { phase: 'failed', message: (msg || 'Autodesk çevirisi başarısız').slice(0, 300) };
  }
  if (m.status !== 'success') return { phase: 'translating', progress: String(m.progress ?? '') };
  let guid = knownGuid;
  if (!guid) {
    const meta = await (await authed(`/modelderivative/v2/designdata/${urn}/metadata`)).json();
    guid = meta.data?.metadata?.find((v: { role: string }) => v.role === '3d')?.guid ?? meta.data?.metadata?.[0]?.guid;
    if (!guid) return { phase: 'failed', message: '3D görünüm bulunamadı' };
  }
  return { phase: 'ready', guid };
}

export type ApsPhase =
  | { phase: 'translating'; progress: string }
  | { phase: 'failed'; message: string }
  | { phase: 'extracting'; guid: string }
  | { phase: 'ready'; guid: string; collection: unknown[] };

// Vercel fonksiyon belleği sınırı: devasa property koleksiyonlarını (ör. 285k obje
// ≈ 460 MB JSON) tek istekte parse etmek OOM riski — dürüst hata ver.
const MAX_PROPS_BYTES = 100 * 1024 * 1024;

// Gövdeyi chunk chunk oku, tavanı DEKOMPRESE bayt üzerinden uygula.
// content-length'e güvenilmez: header hiç gelmeyebilir (chunked) ve gzip'te
// SIKIŞTIRILMIŞ boyutu taşır (~10x küçük) — guard'ı ikisi de deler.
async function readBodyCapped(res: Response, cap: number): Promise<string | null> {
  if (!res.body) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > cap) return null; // erken dönüş stream'i cancel eder
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Çeviri/çıkarım durumunu İLERLET — hızlı döner (Vercel 300sn sınırına uygun,
// istemci ProcessingLive periyodik çağırır). 'ready' geldiğinde collection tam listedir.
export async function apsAdvance(urn: string, knownGuid?: string): Promise<ApsPhase> {
  const m = await (await authed(`/modelderivative/v2/designdata/${urn}/manifest`)).json();
  if (m.status === 'failed' || m.status === 'timeout') {
    const msg = m.derivatives?.flatMap((d: { messages?: { message?: string }[] }) => d.messages ?? [])
      .map((x: { message?: string }) => x.message).filter(Boolean).join('; ');
    return { phase: 'failed', message: (msg || 'Autodesk çevirisi başarısız').slice(0, 300) };
  }
  if (m.status !== 'success') return { phase: 'translating', progress: String(m.progress ?? '') };

  let guid = knownGuid;
  if (!guid) {
    const meta = await (await authed(`/modelderivative/v2/designdata/${urn}/metadata`)).json();
    guid = meta.data?.metadata?.find((v: { role: string }) => v.role === '3d')?.guid ?? meta.data?.metadata?.[0]?.guid;
    if (!guid) return { phase: 'failed', message: '3D görünüm bulunamadı' };
  }
  // property DB büyük modelde dakikalar sürebilir: 202 = hazırlanıyor
  const pr = await authed(`/modelderivative/v2/designdata/${urn}/metadata/${guid}/properties?forceget=true`);
  if (pr.status === 202) return { phase: 'extracting', guid };
  if (pr.status !== 200) return { phase: 'failed', message: `APS properties ${pr.status}` };
  // content-length yalnız hızlı-ret ipucu (gzip'te sıkıştırılmış boyut); asıl sınır okurken
  const hinted = Number(pr.headers.get('content-length') ?? 0);
  if (hinted > MAX_PROPS_BYTES) {
    return { phase: 'failed', message: `Model property verisi çok büyük (${Math.round(hinted / 1e6)} MB) — bulut çıkarım sınırı 100 MB` };
  }
  const text = await readBodyCapped(pr, MAX_PROPS_BYTES);
  if (text === null) {
    return { phase: 'failed', message: 'Model property verisi çok büyük — bulut çıkarım sınırı 100 MB' };
  }
  const d = JSON.parse(text);
  return { phase: 'ready', guid, collection: d.data?.collection ?? [] };
}
