// Metriq — APS Model Derivative property koleksiyonu → MTO satırları.
// İki yapısal aile desteklenir (ikisi de gerçek dosyalarla kanıtlandı):
//   1) Revit/Victaulic NWD (ENQ-223): Element.Category + Custom["Description BOM"]
//   2) Plant3D-in-DWG NWD (ENQ-238): Item.Type=ACPPPIPE/ACPPPIPEINLINEASSET/ACPPCONNECTOR
//      + tanınan vendor Insert blokları (DN150 PRESS COLLAR, SO Flange, vana…)
// Yapısal veri YOKSA (mesh/dumb solid, ör. SolidWorks kaynaklı ENQ-268) satır
// üretilmez — asla uydurma yok; çağıran dürüst hata gösterir.
import { dnToNps } from '../pipe-sizes.ts';
import { computeTotals } from '../vocab.ts';
import type { CalibrationRules, MtoRow, RunTotals } from '../types';

export interface ApsExtractResult {
  rows: MtoRow[];
  totals: RunTotals;
  fasteners: { gaskets: number; boltSets: number; stubEnds: number };
  family: 'revit' | 'plant3d-dwg' | 'mixed' | 'none';
  structuredCount: number;   // MTO'ya katkı veren obje sayısı
  totalCount: number;        // koleksiyondaki toplam obje
  lineCount: number;
  // satır id → APS viewer dbId listesi ("modelde göster" izole+zoom için).
  // Satır başına MAX_OIDS_PER_ROW ile sınırlı — devasa toplamalarda bölgeyi göstermek yeter.
  objectMap: Record<string, number[]>;
}

const MAX_OIDS_PER_ROW = 500;
// aggregation sırasında taşınan geçici viewer-id alanı (DB'ye yazılmadan sökülür)
type RawRow = MtoRow & { _oids?: number[] };

type ApsObject = {
  objectid?: number;
  name?: string;
  properties?: Record<string, Record<string, string> | undefined>;
};

const rid = () => Math.random().toString(36).slice(2, 10);
const FT_TO_M = 0.3048;

// ---- 1) Revit/Victaulic (ENQ-223 reçetesi — %57 doğal-tavan kanıtlı) ----
function revitCode(bom: string, cat: string): string | null {
  const b = bom.toUpperCase();
  if (/^PIPE\b|^PIPE:/.test(b)) return 'PIPE';
  if (/COUPLING STYLE (77|75|177)/.test(b)) return 'FLEXIBLE COUPLING';
  if (/COUPLING/.test(b)) return 'RIGID COUPLING';
  if (/90 DEG ELBOW/.test(b)) return '90 ELBOW';
  if (/45 DEG ELBOW/.test(b)) return '45 ELBOW';
  if (/REDUCING TEE/.test(b)) return 'RED TEE';
  if (/MECHANICAL T/.test(b)) return 'MECHANICAL-T';
  if (/\bTEE\b/.test(b)) return 'EQ TEE';
  if (/CONCENTRIC REDUCER|REDUCER/.test(b)) return 'CON RED';
  if (/FLANGE ADAPTER NIPPLE|FLANGE ADAPTER|ADAPTER NIPPLE/.test(b)) return 'FLANGED NIPPLE';
  if (/NIPPLE/.test(b)) return 'NIPPLE';
  if (/THREDOLET|THREADOLET/.test(b)) return 'THREDOLET';
  if (/\bCAP\b/.test(b) && !/CAP SCREW/.test(b)) return 'CAP';
  if (/STRAINER/.test(b)) return 'STRAINER';
  if (/VALVE|VLV|BFLY/.test(b)) return 'MV';
  if (/ORIFICE|BOLT SET|CAP SCREW|GASKET/.test(b)) return null;
  if (cat === 'Pipe Accessories') return 'MV';
  return null;
}

function revitSizes(E: Record<string, string>): [number | null, number] {
  // "200-200-100" → ana=200, branş=100 (en küçük FARKLI parça); DN mm → NPS inç
  const parts = String(E.Size || E['Overall Size'] || '').replace(/mm/g, '')
    .split('-').map(p => parseInt(p.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);
  if (!parts.length) return [null, 0];
  const s1mm = Math.max(...parts);
  const diff = parts.filter(p => p !== s1mm);
  const s2mm = diff.length ? Math.min(...diff) : 0;
  return [dnToNps(s1mm), s2mm ? (dnToNps(s2mm) ?? 0) : 0];
}

function extractRevit(col: ApsObject[], out: RawRow[]): number {
  // Solid alt-objeleri aynı Element.Id'yi taşır — Length'i olan kaydı tut
  const byId = new Map<string, ApsObject>();
  for (const o of col) {
    const E = o.properties?.Element;
    if (!E?.Id) continue;
    if (!['Pipes', 'Pipe Fittings', 'Pipe Accessories'].includes(E.Category ?? '')) continue;
    const prev = byId.get(E.Id);
    if (!prev || (E.Length && !prev.properties?.Element?.Length)) byId.set(E.Id, o);
  }
  let used = 0;
  for (const o of byId.values()) {
    const E = o.properties!.Element!, C = o.properties?.Custom ?? {};
    const dns = C['Vic_Do Not Schedule'] === 'Yes' || /DNS/.test(C['Description BOM'] ?? '');
    const code = revitCode(C['Description BOM'] || o.name || '', E.Category ?? '');
    if (!code) continue;
    used++;
    const [s1, s2raw] = revitSizes(E);
    // cevap şablonu nipple'larda tek boyut yazar
    const s2 = code === 'NIPPLE' || code === 'FLANGED NIPPLE' ? 0 : s2raw;
    // Hat = ALAN (Vic_Area_PT): estimatörün kapsam boyutu budur (Primary/ADAC/District…)
    // ve excludeLines öğrenmesi bu granülaritede çalışır. System Name binlerce olur.
    const line = C['Vic_Area_PT'] || E['System Name'] || '?';
    const scope = dns ? 'INFO' as const : 'MAIN' as const;
    const remark = dns ? 'DNS' : '';
    const _oids = o.objectid != null ? [o.objectid] : undefined;
    if (code === 'PIPE') {
      const m = parseFloat(E.Length || '0') * FT_TO_M;
      if (m > 0) out.push({ id: rid(), line, code, sub: '', s1, s2: 0, qty: m, unit: 'M', remark, scope, _oids });
    } else {
      out.push({ id: rid(), line, code, sub: '', s1, s2, qty: 1, unit: 'EA', remark, scope, _oids });
    }
  }
  return used;
}

// ---- 2) Plant3D-in-DWG (ENQ-238 reçetesi) ----
function p3dCode(cls: string, desc: string): string | null {
  const d = desc.toUpperCase();
  switch (cls) {
    case 'Pipe': return 'PIPE';
    case 'Elbow': return /45/.test(d) ? '45 BEND' : '90 BEND';
    case 'PipeBend': return 'PIPE BEND';
    case 'Tee': return /RED/.test(d) ? 'RED TEE' : 'EQ TEE';
    case 'Reducer': return /ECC/.test(d) ? 'ECC RED' : 'CON RED';
    case 'BlindFlange': return 'BLIND FLANGE';
    case 'Flange': return 'WELD NECK FLANGE';
    case 'Valve': return /CHECK|NON.?RET|NRV/.test(d) ? 'CV' : 'MV';
    case 'Olet': return 'WELDOLET';
    case 'Coupling': return 'BSP FITTING';
    default: return null; // Gasket/BoltSet ayrıca; Instrument → kapsam dışı
  }
}

// Tanınan vendor blok adları (Inventor/step ekipman modellerinden gelen Insert'ler)
function insertCode(nm: string): { code: string; s1mm: number | null } | null {
  const n = nm.toUpperCase();
  const m = n.match(/DN\s?(\d+)|\bM(\d{2,3})\b|(\d{2,3})\s?MM|^(\d{2,3}) /);
  const s1mm = m ? (parseFloat(m[1] ?? m[2] ?? m[3] ?? m[4]) || null) : null;
  if (/PRESS COLLAR/.test(n)) return { code: 'COLLAR', s1mm };
  if (/SO FLANGE|BACKING FL/.test(n)) return { code: 'BACKING FLANGE', s1mm };
  if (/BLANK FLANGE|BLIND FLANGE/.test(n)) return { code: 'BLIND FLANGE', s1mm };
  if (/VALVE/.test(n)) return { code: 'MV', s1mm };
  if (/EQUAL TEE/.test(n)) return { code: 'EQ TEE', s1mm };
  if (/^90 BEND/.test(n)) return { code: '90 BEND', s1mm };
  if (/\bBEND\b/.test(n)) return { code: 'PIPE BEND', s1mm };
  if (/NIPPLE|SOCKET|UNION/.test(n)) return { code: 'BSP FITTING', s1mm };
  return null;
}

const srcStem = (s: string) => s.replace(/\.dwg$/i, '').trim() || '?';

function extractP3dDwg(
  col: ApsObject[], out: RawRow[], fasteners: { gaskets: number; boltSets: number; stubEnds: number },
  rules: CalibrationRules,
): number {
  let used = 0;
  // conta/cıvata: boyutLU satır olarak da çıkar (cevap şablonları boyut bazında sayar);
  // includeFasteners kapalıysa INFO'da dursun — veri kaybolmasın, kalibrasyonla MAIN'e alınabilsin
  const fastenerScope = rules.includeFasteners ? 'MAIN' as const : 'INFO' as const;
  for (const o of col) {
    const P = o.properties ?? {}, I = P.Item ?? {}, AC = P.AutoCAD ?? {};
    const t = I.Type;
    const line = srcStem(String(I['Source File'] ?? ''));
    if (t === 'ACPPPIPE' || t === 'ACPPPIPEINLINEASSET') {
      const dias = ['Port1', 'Port2', 'Port3']
        .map(p => parseFloat(AC[`${p}_NominalDiameter`] ?? '')).filter(Number.isFinite);
      const hdr = parseFloat(String(AC.Size ?? '').split('x')[0]) || null;
      const s1mm = dias.length ? Math.max(...dias) : hdr;
      const sMin = dias.length ? Math.min(...dias) : hdr;
      const s2mm = sMin !== s1mm ? (sMin ?? 0) : 0;
      const code = p3dCode(String(AC.Class ?? ''), String(AC['ShortDescription'] ?? AC['Long Description'] ?? ''));
      if (!code) continue;
      used++;
      const s1 = s1mm != null ? dnToNps(s1mm) : null;
      const s2 = s2mm ? (dnToNps(s2mm) ?? 0) : 0;
      const spec = String(AC.Spec ?? '');
      const _oids = o.objectid != null ? [o.objectid] : undefined;
      if (code === 'PIPE') {
        const m = (parseFloat(AC.Length ?? '0') || 0) / 1000;
        if (m > 0) out.push({ id: rid(), line, code, sub: '', s1, s2: 0, qty: m, unit: 'M', remark: spec, scope: 'MAIN', _oids });
      } else if (code === 'WELD NECK FLANGE' && rules.collarOneToOne) {
        // müşteri pratiği (kalibrasyonla öğrenilir): spec WN flanş yerine
        // gevşek backing flanş + kaynaklı collar çifti teklif edilir
        out.push({ id: rid(), line, code: 'BACKING FLANGE', sub: 'WN→BF', s1, s2: 0, qty: 1, unit: 'EA', remark: spec, scope: 'MAIN', _oids });
        out.push({ id: rid(), line, code: 'COLLAR', sub: '1:1', s1, s2: 0, qty: 1, unit: 'EA', remark: spec, scope: 'MAIN', _oids });
      } else {
        const keepS2 = code === 'CON RED' || code === 'ECC RED' || code === 'RED TEE';
        out.push({ id: rid(), line, code, sub: '', s1, s2: keepS2 ? s2 : 0, qty: 1, unit: 'EA', remark: spec, scope: 'MAIN', _oids });
      }
    } else if (t === 'ACPPCONNECTOR') {
      for (const fk of ['Fastener1', 'Fastener2', 'Fastener3']) {
        const cn = String(AC[`${fk}_Class Name`] ?? '');
        if (cn !== 'Gasket' && cn !== 'BoltSet') continue;
        used++;
        const szMm = parseFloat(AC[`${fk}_Size`] ?? '') || null;
        const s1 = szMm != null ? dnToNps(szMm) : null;
        const _oids = o.objectid != null ? [o.objectid] : undefined;
        if (cn === 'Gasket') {
          fasteners.gaskets++;
          out.push({ id: rid(), line, code: 'GASKET', sub: '', s1, s2: 0, qty: 1, unit: 'EA', remark: 'bağlantı başına 1', scope: fastenerScope, _oids });
        } else {
          fasteners.boltSets++;
          out.push({ id: rid(), line, code: 'BOLT SET', sub: '', s1, s2: 0, qty: 1, unit: 'EA', remark: '', scope: fastenerScope, _oids });
        }
      }
    } else if (t === 'Insert') {
      const r = insertCode(String(o.name ?? ''));
      if (!r) continue;
      used++;
      out.push({
        id: rid(), line, code: r.code, sub: String(o.name ?? '').slice(0, 60),
        s1: r.s1mm != null ? dnToNps(r.s1mm) : null, s2: 0, qty: 1, unit: 'EA',
        remark: 'vendor blok', scope: 'MAIN',
        _oids: o.objectid != null ? [o.objectid] : undefined,
      });
    }
  }
  return used;
}

// ---- satır-düzeyi kural uygulaması (vocab.applyRules.push ile aynı semantik) ----
function applyRowRules(rowsIn: RawRow[], rules: CalibrationRules): RawRow[] {
  const excl = new Set(rules.excludeLines ?? []);
  const agg = new Map<string, RawRow>();
  for (const r0 of rowsIn) {
    let { code, s1, s2, unit, scope } = r0;
    code = rules.codeRenames[code] ?? code;
    for (const correction of rules.itemCorrections ?? []) {
      const m = correction.match;
      // Tek-örnek güvenlik kapısı — vocab.ts push içindekiyle AYNI semantik:
      // s1=null kovasına değer atayan kurallar bağlamsız + tek-kanıtlıysa uygulanmaz.
      if (m.s1 === null && Object.prototype.hasOwnProperty.call(correction.set, 's1')
        && correction.evidenceCount < 2 && m.line === undefined && m.sub === undefined) continue;
      if (m.code !== code || m.s1 !== s1 || m.s2 !== s2 || m.unit !== unit
        || (m.line !== undefined && m.line !== r0.line)
        || (m.sub !== undefined && m.sub !== r0.sub)) continue;
      if (correction.set.code !== undefined) code = correction.set.code;
      if (Object.prototype.hasOwnProperty.call(correction.set, 's1')) s1 = correction.set.s1 ?? null;
      if (correction.set.s2 !== undefined) s2 = correction.set.s2;
      if (correction.set.unit !== undefined) unit = correction.set.unit;
      if (correction.set.scope !== undefined) scope = correction.set.scope;
    }
    let qty = r0.qty;
    if (code === 'PIPE' && unit === 'M') qty *= rules.grossPipeFactor;
    let remark = r0.remark;
    if (scope === 'MAIN' && excl.has(r0.line)) {
      scope = 'INFO';
      remark = [remark, 'kapsam dışı (kalibrasyon)'].filter(Boolean).join('; ');
    }
    const key = [r0.line, code, r0.sub, s1, s2, unit, scope].join('|');
    const ex = agg.get(key);
    if (ex) {
      ex.qty += qty;
      // remark birleşimi tavanlı: binlerce obje aynı satıra düşebilir
      if (remark && ex.remark.length < 160 && !ex.remark.includes(remark)) {
        ex.remark = [ex.remark, remark].filter(Boolean).join('; ');
      }
      // viewer id'leri birleşir (satır başına tavanlı — bölgeyi göstermek yeter)
      if (r0._oids?.length && (ex._oids?.length ?? 0) < MAX_OIDS_PER_ROW) {
        ex._oids = [...(ex._oids ?? []), ...r0._oids].slice(0, MAX_OIDS_PER_ROW);
      }
    } else {
      agg.set(key, { ...r0, code, s1, s2, unit, scope, qty, remark });
    }
  }
  const rows = [...agg.values()];
  for (const r of rows) if (r.unit === 'M') r.qty = Math.round(r.qty * 1000) / 1000;
  const codeOrder = ['PIPE', '90 BEND', '45 BEND', '90 ELBOW', '45 ELBOW', 'EQ TEE', 'RED TEE',
    'CON RED', 'ECC RED', 'FLANGE', 'WELD NECK FLANGE', 'BACKING FLANGE', 'COLLAR', 'BLIND FLANGE',
    'RIGID COUPLING', 'FLEXIBLE COUPLING', 'WELDOLET', 'MV', 'CV', 'VALVE'];
  const rank = (c: string) => { const i = codeOrder.indexOf(c); return i < 0 ? 999 : i; };
  rows.sort((a, b) => a.line.localeCompare(b.line) || rank(a.code) - rank(b.code) || (b.s1 ?? -1) - (a.s1 ?? -1));
  return rows;
}

export function extractFromApsProps(collection: unknown[], rules: CalibrationRules): ApsExtractResult {
  const col = collection as ApsObject[];
  const fasteners = { gaskets: 0, boltSets: 0, stubEnds: 0 };
  const raw: RawRow[] = [];
  const revitUsed = extractRevit(col, raw);
  // conta/cıvata satırları boyutLU olarak extractP3dDwg içinde üretilir
  // (includeFasteners kapalıysa INFO kapsamında — çift sayım yok)
  const p3dUsed = extractP3dDwg(col, raw, fasteners, rules);
  const withOids = applyRowRules(raw, rules);
  // viewer eşlemesi ayrılır, satırlar temiz MtoRow olarak döner (DB'ye _oids sızmaz)
  const objectMap: Record<string, number[]> = {};
  const rows: MtoRow[] = withOids.map(({ _oids, ...row }) => {
    if (_oids?.length) objectMap[row.id] = _oids;
    return row;
  });
  const totals = computeTotals(rows, []);
  const family: ApsExtractResult['family'] =
    revitUsed && p3dUsed ? 'mixed' : revitUsed ? 'revit' : p3dUsed ? 'plant3d-dwg' : 'none';
  return {
    rows, totals, fasteners, family,
    structuredCount: revitUsed + p3dUsed,
    totalCount: col.length,
    lineCount: totals.lines.length,
    objectMap,
  };
}
