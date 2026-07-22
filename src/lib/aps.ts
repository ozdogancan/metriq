// Metriq — Autodesk Platform Services istemcisi (Model Derivative).
// Plant3D-olmayan NWD'ler (Revit MEP vb.) için bulut çıkarım yolu: string-kazıma
// bu dosyalarda boru uzunluğuna ULAŞAMAZ (binary parametre); APS temiz property döner.
// Bulut çevirisi yalnız yerel yapısal kanıt yetersiz kaldığında kullanılır.
import 'server-only';
import { Readable } from 'node:stream';
// stream-json v1 = CJS; named-export tespiti güvenilmez → default-import interop
import streamJsonParser from 'stream-json';
import streamJsonPick from 'stream-json/filters/Pick.js';
import streamJsonArray from 'stream-json/streamers/StreamArray.js';
type StreamFactory = (opts?: Record<string, unknown>) => import('node:stream').Duplex;
const parser = ((streamJsonParser as unknown as { parser?: StreamFactory }).parser ?? streamJsonParser) as StreamFactory;
const pick = ((streamJsonPick as unknown as { pick?: StreamFactory }).pick ?? streamJsonPick) as StreamFactory;
const streamArray = ((streamJsonArray as unknown as { streamArray?: StreamFactory }).streamArray ?? streamJsonArray) as StreamFactory;

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

// Viewer proxy için dar kapsamlı token (yalnız viewables:read). Token tarayıcıya
// verilmez; ayrı cache ana upload/translate token'ıyla kapsam karışmasını önler.
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

// Çeviri işini yeniden kuyruğa al (x-ads-force) — Autodesk motoru bazen geçici
// InternalFailure verir; yalnız bu açık retry yolu zorlanmış çeviri başlatır.
export async function apsRetryTranslate(urn: string): Promise<boolean> {
  const job = await authed('/modelderivative/v2/designdata/job', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ads-force': 'true' },
    body: JSON.stringify({ input: { urn }, output: { formats: [{ type: 'svf', views: ['3d'] }] } }),
  });
  return job.ok;
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
    // Aynı durable adım ağ kesintisi yüzünden tekrar çalışırsa aynı URN'i
    // yeniden ücretli çevirmeye zorlama. Gerçek retry ayrı fonksiyonda force=true.
    headers: { 'content-type': 'application/json' },
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

/**
 * Akış-anı teşhis sayacı: aile filtresine TAKILMAYAN modellerde bile "içeride
 * ne vardı"yı söyleyebilmek için. Objeler tutulmaz (bellek güvenli), yalnız
 * sayaçlar birikir. Gerçek vaka (Model 16Dec): 14.135 obje / 0 yapısal —
 * kör "desteklenmiyor" yerine "12 boru katmanında 3.4k yalın katı var ama
 * ölçü verisi yok" diyebilmek bu sayaçlarla mümkün oluyor.
 */
export interface ApsStreamDiag {
  pipingLayerObjects: number;
  pipingLayers: Record<string, number>;   // katman adı → obje (tavan: 40 anahtar)
  hardwareBlocks: Record<string, number>; // katalog bloğu adı → adet (tavan: 60)
}

export type ApsPhase =
  | { phase: 'translating'; progress: string }
  | { phase: 'failed'; message: string }
  | { phase: 'extracting'; guid: string }
  | { phase: 'ready'; guid: string; collection: unknown[]; totalCount: number; diag: ApsStreamDiag };

// Devasa property setleri (doğrulanmış örnek: 285k obje ≈ 460MB JSON) tek string olarak
// parse edilemez (OOM). Çözüm: gövdeyi STREAM'le, objeleri daha akış sırasında
// aile filtresinden geçir (Revit boru kategorileri / Plant3D ACPP / Insert) ve
// yalnız gerekli property gruplarını tut — bellek, tutulan alt-kümeyle sınırlı
// kalır (285k → ~45k slim obje). Sınır bayt değil OBJE sayısıyla korunur.
const MAX_KEPT_OBJECTS = 400_000;
const REVIT_PIPING = new Set(['Pipes', 'Pipe Fittings', 'Pipe Accessories']);
const P3D_TYPES = new Set(['ACPPPIPE', 'ACPPPIPEINLINEASSET', 'ACPPCONNECTOR', 'Insert']);

// ALAN-düzeyi beyaz liste: grup-bazlı inceltme yetmiyor (Revit gruplarının içi
// şişkin — 46k obje ~500MB tutuyordu). Çıkarımın okuduğu alanlar dışında her şey
// akış sırasında atılır → aynı 46k obje ~40MB.
const EL_FIELDS = ['Id', 'GlobalId', 'Category', 'Size', 'Overall Size', 'Length', 'System Name', 'System Abbreviation'];
const CU_FIELDS = ['Description BOM', 'Vic_Do Not Schedule', 'Vic_Area_PT'];
const IT_FIELDS = ['Type', 'Source File', 'Name', 'GUID'];
const AC_FIELDS = new Set(['Class', 'Size', 'Length', 'Spec', 'ShortDescription', 'Long Description']);
const AC_DYNAMIC = /^(?:Port\d_NominalDiameter|Fastener\d_(?:Class Name|Size))$/;
const PROJECT_FIELDS = ['Part Number'];
const BASE_QUANTITY_FIELDS = ['GlobalId', 'Length', 'NetWeight'];
const TEKLA_QUANTITY_FIELDS = ['GlobalId', 'Length', 'Weight'];
const NAMED_COMPONENT = /\b(?:PIPE|TUBE|ELBOW|BEND|TEE|REDUCER|FLANGE|VALVE|GASKET|BOLT|COLLAR|COUPLING|CAP|STRAINER)\b/i;
const STANDARD_DN = /\bDN\s*\d{1,4}\b/i;
const STEEL_SECTION = /\b(?:UB|UC|PFC|RHS|SHS|CHS|RSA|EA|UA|FLT|PLT|FBAR|SBAR|RBAR)\s*-?\s*\d/i;

function slimGroup(src: Record<string, string> | undefined, fields: string[]): Record<string, string> | undefined {
  if (!src) return undefined;
  const out: Record<string, string> = {};
  let n = 0;
  for (const f of fields) { const v = src[f]; if (v !== undefined) { out[f] = v; n++; } }
  return n ? out : undefined;
}
function slimAutoCad(src: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!src) return undefined;
  const out: Record<string, string> = {};
  let n = 0;
  for (const k of Object.keys(src)) {
    if (AC_FIELDS.has(k) || AC_DYNAMIC.test(k)) { out[k] = src[k]; n++; }
  }
  return n ? out : undefined;
}

type SlimObj = { objectid?: number; name?: string; properties?: Record<string, unknown> };

const PIPING_LAYER = /pip(?:e|ing)/i;
// Katalog bloğu: "Sechskantschraube-+-8106.010.030_-_…" gibi artikel-kodlu adlar
const CATALOG_BLOCK = /^\p{L}[\p{L}\p{M}]+-\+-\d{4}[._]/u;
const MAX_DIAG_KEYS = { layers: 40, blocks: 60 };

function streamCollection(res: Response): Promise<{ collection: SlimObj[]; totalCount: number; diag: ApsStreamDiag }> {
  return new Promise((resolve, reject) => {
    const kept: SlimObj[] = [];
    let total = 0;
    const diag: ApsStreamDiag = { pipingLayerObjects: 0, pipingLayers: {}, hardwareBlocks: {} };
    const pipeline = Readable.fromWeb(res.body as never)
      .pipe(parser())
      .pipe(pick({ filter: 'data.collection' }))
      .pipe(streamArray());
    pipeline.on('data', ({ value }: { value: SlimObj }) => {
      total++;
      const p = value?.properties as Record<string, Record<string, string>> | undefined;
      const cat = p?.Element?.Category;
      const typ = p?.Item?.Type;
      const itemName = String(p?.Item?.Name ?? value.name ?? '');
      // Teşhis sayaçları — obje TUTULMAZ, yalnız sayılır (bellek sabit kalır)
      const layer = p?.General?.Layer;
      if (layer && PIPING_LAYER.test(layer)) {
        diag.pipingLayerObjects++;
        if (diag.pipingLayers[layer] !== undefined || Object.keys(diag.pipingLayers).length < MAX_DIAG_KEYS.layers) {
          diag.pipingLayers[layer] = (diag.pipingLayers[layer] ?? 0) + 1;
        }
      }
      if (typ === 'Block' && CATALOG_BLOCK.test(itemName)) {
        if (diag.hardwareBlocks[itemName] !== undefined || Object.keys(diag.hardwareBlocks).length < MAX_DIAG_KEYS.blocks) {
          diag.hardwareBlocks[itemName] = (diag.hardwareBlocks[itemName] ?? 0) + 1;
        }
      }
      const sourceFile = String(p?.Item?.['Source File'] ?? '');
      const partNumber = String(p?.Project?.['Part Number'] ?? '');
      const isRevit = Boolean(p?.Element?.Id && cat && REVIT_PIPING.has(cat));
      const isP3d = Boolean(
        typ && (typ !== 'Insert' ? P3D_TYPES.has(typ) : Boolean(p?.AutoCAD)),
      );
      const isNamedInstance = typ === 'Instance' && NAMED_COMPONENT.test(itemName) && STANDARD_DN.test(itemName);
      const isInventorSteel = typ === 'Group' && /\.(?:iam|ipt)$/i.test(sourceFile)
        && STEEL_SECTION.test(`${partNumber} ${itemName}`);
      const isIfcTekla = /^Ifc(?:Beam|Column|Member):/i.test(String(typ ?? ''));
      const isGenericCad = typ === 'Insert' && Boolean(p?.['AutoCAD Geometry'])
        && !p?.AutoCAD && NAMED_COMPONENT.test(itemName) && STANDARD_DN.test(itemName);
      if (!isRevit && !isP3d && !isNamedInstance && !isInventorSteel && !isIfcTekla && !isGenericCad) return;
      if (kept.length >= MAX_KEPT_OBJECTS) {
        pipeline.destroy(new Error(`Model yapısal obje tavanını aşıyor (${MAX_KEPT_OBJECTS})`));
        return;
      }
      // alan-düzeyi inceltme: yalnız çıkarımın okuduğu alanlar kalır
      const el = slimGroup(p?.Element, EL_FIELDS);
      const cu = slimGroup(p?.Custom, CU_FIELDS);
      const it = slimGroup(p?.Item, IT_FIELDS);
      const ac = slimAutoCad(p?.AutoCAD);
      const project = slimGroup(p?.Project, PROJECT_FIELDS);
      const baseQuantities = slimGroup(p?.BaseQuantities, BASE_QUANTITY_FIELDS);
      const teklaQuantities = slimGroup(p?.['Tekla Quantity'], TEKLA_QUANTITY_FIELDS);
      kept.push({
        objectid: value.objectid,
        name: value.name,
        properties: {
          ...(el ? { Element: el } : {}),
          ...(cu ? { Custom: cu } : {}),
          ...(it ? { Item: it } : {}),
          ...(ac ? { AutoCAD: ac } : {}),
          ...(project ? { Project: project } : {}),
          ...(baseQuantities ? { BaseQuantities: baseQuantities } : {}),
          ...(teklaQuantities ? { 'Tekla Quantity': teklaQuantities } : {}),
          ...(p?.['AutoCAD Geometry'] ? { 'AutoCAD Geometry': { present: 'true' } } : {}),
        },
      });
    });
    pipeline.on('end', () => resolve({ collection: kept, totalCount: total, diag }));
    pipeline.on('error', reject);
  });
}

// Çeviri/çıkarım durumunu İLERLET — hızlı döner (Vercel 300sn sınırına uygun,
// istemci ProcessingLive periyodik çağırır). 'ready' geldiğinde collection tam listedir.
export async function apsAdvance(urn: string, knownGuid?: string): Promise<ApsPhase> {
  const manifest = await apsManifestPhase(urn, knownGuid);
  if (manifest.phase !== 'ready') return manifest;
  return apsFetchProperties(urn, manifest.guid);
}

// Ağır property akışı ayrı tutulur: çağıran önce DB claim alarak yüzlerce MB'lık
// aynı koleksiyonun iki serverless instance tarafından paralel indirilmesini önler.
export async function apsFetchProperties(urn: string, guid: string): Promise<
  | { phase: 'failed'; message: string }
  | { phase: 'extracting'; guid: string }
  | { phase: 'ready'; guid: string; collection: unknown[]; totalCount: number; diag: ApsStreamDiag }
> {
  // property DB büyük modelde dakikalar sürebilir: 202 = hazırlanıyor
  const pr = await authed(`/modelderivative/v2/designdata/${urn}/metadata/${guid}/properties?forceget=true`);
  if (pr.status === 202) return { phase: 'extracting', guid };
  if (pr.status !== 200) return { phase: 'failed', message: `APS properties ${pr.status}` };
  // boyut sınırı YOK: akış sırasında aile-filtresi + grup-inceltme (bellek güvenli)
  try {
    const { collection, totalCount, diag } = await streamCollection(pr);
    return { phase: 'ready', guid, collection, totalCount, diag };
  } catch (e) {
    return { phase: 'failed', message: e instanceof Error ? e.message.slice(0, 200) : 'property akışı okunamadı' };
  }
}
