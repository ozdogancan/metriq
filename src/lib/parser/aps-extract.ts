// Metriq — APS Model Derivative property koleksiyonu → MTO satırları.
// Güçlü property şemaları (Revit / Plant3D) doğrudan çıkarılır. Inventor,
// IFC/Tekla ve generic AutoCAD kaynaklarında ise yalnız açık isim/property kanıtı
// kullanılır; eksik ölçü "aday" olarak raporlanır, asla miktara dönüştürülmez.
import { dnToNps } from '../pipe-sizes.ts';
import { computeTotals } from '../vocab.ts';
import type { CalibrationRules, MtoRow, RunTotals } from '../types';

export interface ApsExtractResult {
  rows: MtoRow[];
  totals: RunTotals;
  fasteners: { gaskets: number; boltSets: number; stubEnds: number };
  family: ApsFamily;
  // "structured" yalnız property tabanlı deterministik çıkarım demektir; cevap
  // Excel'iyle accuracy iddiası değildir. İsim/eksik-ölçü aileleri fail-closed
  // olarak "partial" döner.
  quality: 'structured' | 'partial' | 'none';
  confidence: number;          // 0..1, provenance katkılarının ağırlıklı ortalaması
  coverage: ApsCoverage;
  provenance: ApsProvenance[];
  candidates: ApsCandidate[];  // güvenilir kimlik var, teklif ölçüsü eksik
  structuredCount: number;   // MTO'ya katkı veren obje sayısı
  totalCount: number;        // koleksiyondaki toplam obje
  lineCount: number;
  // satır id → APS viewer dbId listesi ("modelde göster" izole+zoom için).
  // Satır başına MAX_OIDS_PER_ROW ile sınırlı — devasa toplamalarda bölgeyi göstermek yeter.
  objectMap: Record<string, number[]>;
}

export type ApsFamily =
  | 'revit'
  | 'plant3d-dwg'
  | 'inventor-assembly'
  | 'ifc-tekla'
  | 'generic-autocad'
  | 'mixed'
  | 'none';

export interface ApsCoverage {
  totalObjects: number;
  recognizedObjects: number;
  measurableObjects: number;
  candidateObjects: number;
  recognizedRatio: number;
  measurableRatio: number;
}

export interface ApsProvenance {
  extractor: 'revit-properties' | 'plant3d-properties' | 'inventor-nameplate'
    | 'inventor-steel-nameplate' | 'ifc-tekla-quantities' | 'autocad-explicit-block';
  objects: number;
  rows: number;
  candidates: number;
  confidence: number;
  evidence: string[];          // yalnız şema/yol adları; müşteri değeri içermez
  limitations: string[];
}

export interface ApsCandidate {
  kind: 'steel-profile' | 'piping-component' | 'pipe-without-length';
  code: string;
  label: string;
  count: number;
  s1: number | null;
  s2: number;
  lengthM?: number;
  weightKg?: number;
  confidence: number;
  provenance: 'inventor-nameplate' | 'ifc-tekla-quantities' | 'autocad-explicit-block';
  objectIds?: number[];
}

const MAX_OIDS_PER_ROW = 500;
// aggregation sırasında taşınan geçici viewer-id alanı (DB'ye yazılmadan sökülür)
type RawRow = MtoRow & { _oids?: number[] };

type ApsObject = {
  objectid?: number;
  name?: string;
  properties?: Record<string, Record<string, string> | undefined>;
};

type NamedComponent = {
  code: string;
  dns: number[];
  confidence: number;
};

type CandidateAccumulator = ApsCandidate & { objectIds: number[] };

const rid = () => Math.random().toString(36).slice(2, 10);
const FT_TO_M = 0.3048;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const cleanSpace = (s: string) => s.replace(/\s+/g, ' ').trim();
const cleanSource = (s: string) => cleanSpace(s.replace(/\.(?:dwg|iam|ipt|ifc|nwd)$/i, '')) || '?';

function finiteUnit(value: unknown, expectedUnit: 'mm' | 'kg'): number | null {
  if (typeof value !== 'string' || !value) return null;
  const m = value.trim().match(/^(-?\d+(?:[.,]\d+)?)\s*([A-Za-z]+)(?:\^\d+)?$/);
  if (!m || m[2].toLowerCase() !== expectedUnit) return null;
  const n = Number.parseFloat(m[1].replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Bir ürün ailesinin katalog aralığını ("DN10-500", "DN15_500") gerçek
// ölçü sanma. Birden çok DN geçiyorsa son geçerli ifade, BOM isimlerinde gerçek
// yerleştirilmiş boyuttur (örn. "(DN10-500)_DN 80").
function explicitDns(name: string): number[] {
  const matches: number[][] = [];
  const re = /DN\s*(\d{1,4}(?:\s*[x×]\s*\d{1,4}){0,2})/gi;
  for (const m of name.matchAll(re)) {
    const tail = name.slice((m.index ?? 0) + m[0].length);
    if (/^\s*[-_]\s*\d/.test(tail)) continue; // katalog aralığı
    const values = m[1].split(/[x×]/i).map(v => Number.parseInt(v.trim(), 10));
    if (values.length && values.every(v => dnToNps(v) !== null)) matches.push(values);
  }
  return matches.at(-1) ?? [];
}

// DN öneki bulunmayan fakat iki/üç standart metrik nominal ölçüyü açıkça
// "350x200" biçiminde veren reducer/tee nameplate'leri. Noktalı ürün kodları
// (örn. 2060.100.065) bu kapıdan geçmez.
function explicitMetricSizeSeries(name: string): number[] {
  const matches: number[][] = [];
  const re = /(\d{2,4})\s*(?:mm\s*)?[x×]\s*(\d{2,4})(?:\s*(?:mm\s*)?[x×]\s*(\d{2,4}))?\s*(?:mm)?/gi;
  for (const match of name.matchAll(re)) {
    const values = match.slice(1, 4).filter((value): value is string => value !== undefined)
      .map(value => Number.parseInt(value, 10));
    if (values.length >= 2 && values.every(value => dnToNps(value) !== null)) matches.push(values);
  }
  return matches.at(-1) ?? [];
}

function namedComponent(nameIn: string): NamedComponent | null {
  const name = cleanSpace(nameIn);
  const n = name.toUpperCase();
  let code: string | null = null;
  if (/FLAT GASKET|\bGASKET\b|GUARNIZIONE/.test(n)) code = 'GASKET';
  else if (/CARTELLA|STUB\s*END|\bCOLLAR\b/.test(n)) code = 'COLLAR';
  else if (/FLANGIA\s+LIBERA|LOOSE\s+FLANGE|BACKING\s+FLANGE/.test(n)) code = 'BACKING FLANGE';
  else if (/FLANGIA\s+CIECA|BLIND\s+FLANGE|BLANK\s+FLANGE/.test(n)) code = 'BLIND FLANGE';
  else if (/\bFLANGE\b|\bFLANGIA\b/.test(n)) code = 'FLANGE';
  else if (/\b45\s*°?\s*(?:CURVA|BEND|ELBOW)/.test(n)) code = '45 BEND';
  else if (/\b90\s*°?\s*(?:CURVA|BEND|ELBOW)/.test(n)) code = '90 BEND';
  else if (/REDUCING\s+TEE|TEE\s+RIDOTT/.test(n)) code = 'RED TEE';
  else if (/EQUAL\s+TEE|TEE\s+EGUAL/.test(n)) code = 'EQ TEE';
  else if (/\bTEE\b/.test(n)) code = 'EQ TEE';
  else if (/RID\.?\s*ECC|ECCENTRIC\s+REDUCER/.test(n)) code = 'ECC RED';
  else if (/R\.?\s*CONCENTRICA|CONCENTRIC\s+REDUCER/.test(n)) code = 'CON RED';
  else if (/REDUZIERSTÜCK|REDUZIERSTUECK/.test(n)) code = 'CON RED';
  else if (/Y\s*TYPE\s*STRAINER|\bSTRAINER\b/.test(n)) code = 'STRAINER';
  else if (/CHECK\s+VALVE|NON.?RETURN|\bNRV\b/.test(n)) code = 'CV';
  else if (/\bVALVE\b|DOPPELSITZVENTIL|BUTTERFLY/.test(n)) code = 'MV';
  else if (/\bCAP\b/.test(n)) code = 'CAP';
  else if (/NIPPLE|HALF\s+COUPLING|\bUNION\b/.test(n)) code = 'BSP FITTING';
  else if (/ROHRSTÜCK|ROHRSTUECK|\bPIPE\s*DN|\bTUBO\s*DN|\bTUBODN/.test(n)) code = 'PIPE';
  else if (/KLEINFLANSCH|FLANSCH[- ]SCHWEI(?:SS|ß)STUTZEN/.test(n)) code = 'FLANGED NIPPLE';
  if (!code) return null;

  let dns = explicitDns(name);
  if (!dns.length && (code === 'CON RED' || code === 'ECC RED' || code === 'RED TEE')) {
    dns = explicitMetricSizeSeries(name);
  }
  return { code, dns, confidence: dns.length ? 0.86 : 0.68 };
}

function componentSizes(dns: number[]): [number | null, number] {
  if (!dns.length) return [null, 0];
  const values = dns.map(dnToNps).filter((v): v is number => v !== null);
  if (!values.length) return [null, 0];
  const s1 = Math.max(...values);
  const smaller = values.filter(v => v !== s1);
  return [s1, smaller.length ? Math.min(...smaller) : 0];
}

function addCandidate(map: Map<string, CandidateAccumulator>, candidate: Omit<ApsCandidate, 'count'>, objectId?: number) {
  const key = [candidate.kind, candidate.code, candidate.label, candidate.s1, candidate.s2,
    candidate.provenance].join('|');
  const ex = map.get(key);
  if (ex) {
    ex.count++;
    if (candidate.lengthM !== undefined) ex.lengthM = round3((ex.lengthM ?? 0) + candidate.lengthM);
    if (candidate.weightKg !== undefined) ex.weightKg = round3((ex.weightKg ?? 0) + candidate.weightKg);
    if (objectId !== undefined && ex.objectIds.length < MAX_OIDS_PER_ROW) ex.objectIds.push(objectId);
  } else {
    map.set(key, {
      ...candidate, count: 1,
      objectIds: objectId === undefined ? [] : [objectId],
    });
  }
}

function finishCandidates(map: Map<string, CandidateAccumulator>): ApsCandidate[] {
  return [...map.values()]
    .map(({ objectIds, ...c }) => ({ ...c, ...(objectIds.length ? { objectIds } : {}) }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label) || (b.s1 ?? -1) - (a.s1 ?? -1));
}

// ---- 1) Revit/Victaulic yapılandırılmış property şeması ----
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

// ---- 2) Plant3D-in-DWG yapılandırılmış property şeması ----
function p3dCode(cls: string, desc: string): string | null {
  const d = desc.toUpperCase();
  switch (cls) {
    case 'Pipe': return 'PIPE';
    case 'Elbow': return /45/.test(d) ? '45 BEND' : '90 BEND';
    case 'PipeBend': return 'PIPE BEND';
    case 'Tee': return /RED/.test(d) ? 'RED TEE' : 'EQ TEE';
    case 'Reducer': return /ECC/.test(d) ? 'ECC RED' : 'CON RED';
    case 'BlindFlange': return 'BLIND FLANGE';
    case 'Flange':
      if (/BACKING|LOOSE|LAP\s*JOINT/.test(d)) return 'BACKING FLANGE';
      if (/SLIP\s*[- ]?ON|\bSO\s+FLANGE/.test(d)) return 'SLIP ON FLANGE';
      if (/WELD(?:ING)?\s+NECK|\bWN\s+FLANGE/.test(d)) return 'WELD NECK FLANGE';
      return 'FLANGE';
    case 'Valve': return /CHECK|NON.?RET|NRV/.test(d) ? 'CV' : 'MV';
    case 'InlineInstrument':
      if (!/\bVALVE\b/.test(d)) return null;
      return /CHECK|NON.?RET|NRV/.test(d) ? 'CV' : 'MV';
    case 'Olet': return 'WELDOLET';
    case 'Coupling': return 'BSP FITTING';
    default: return null; // Gasket/BoltSet ayrıca; Instrument → kapsam dışı
  }
}

// Tanınan vendor blok adları (Inventor/step ekipman modellerinden gelen Insert'ler)
function insertCode(nm: string): { code: string; s1mm: number | null; s2mm: number } | null {
  const n = nm.toUpperCase();
  const series = explicitMetricSizeSeries(n);
  const single = n.match(/\bDN\s*(\d{1,4})\b|\bM(\d{2,4})\b|\b(\d{2,4})\s*MM\b/);
  const singleMm = single ? Number.parseInt(single[1] ?? single[2] ?? single[3], 10) : NaN;
  const values = series.length ? series : (dnToNps(singleMm) !== null ? [singleMm] : []);
  const s1mm = values.length ? Math.max(...values) : null;
  const smaller = s1mm === null ? [] : values.filter(value => value !== s1mm);
  const s2mm = smaller.length ? Math.min(...smaller) : 0;
  if (/PRESS COLLAR/.test(n)) return { code: 'COLLAR', s1mm, s2mm: 0 };
  if (/SO FLANGE|BACKING FL/.test(n)) return { code: 'BACKING FLANGE', s1mm, s2mm: 0 };
  if (/BLANK FLANGE|BLIND FLANGE/.test(n)) return { code: 'BLIND FLANGE', s1mm, s2mm: 0 };
  if (/VALVE/.test(n)) return { code: 'MV', s1mm, s2mm: 0 };
  if (/EQUAL TEE/.test(n)) return { code: 'EQ TEE', s1mm, s2mm: 0 };
  if (/CONCENTRIC|\bCON\.?\s*RED(?:UCER)?\b/.test(n)) return { code: 'CON RED', s1mm, s2mm };
  if (/^90\s*(?:DEG|°)?\s*BEND/.test(n)) return { code: '90 BEND', s1mm, s2mm: 0 };
  if (/\bBEND\b/.test(n)) return { code: 'PIPE BEND', s1mm, s2mm: 0 };
  if (/NIPPLE|SOCKET|UNION/.test(n)) return { code: 'BSP FITTING', s1mm, s2mm: 0 };
  return null;
}

const srcStem = (s: string) => s.replace(/\.dwg$/i, '').trim() || '?';

function extractP3dDwg(
  col: ApsObject[], out: RawRow[], fasteners: { gaskets: number; boltSets: number; stubEnds: number },
  rules: CalibrationRules,
): number {
  let used = 0;
  // Salt AutoCAD bloklarında da Item.Type=Insert görülür. Insert reçetesini
  // Plant3D saymak için koleksiyonda en az bir gerçek ACPP/connector imzası şart.
  const hasP3dCore = col.some(o => {
    const t = o.properties?.Item?.Type;
    return t === 'ACPPPIPE' || t === 'ACPPPIPEINLINEASSET' || t === 'ACPPCONNECTOR';
  });
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
      const desc = [AC['ShortDescription'], AC['Long Description']].filter(Boolean).join(' ');
      const code = p3dCode(String(AC.Class ?? ''), desc);
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
        // Kalibrasyon tercihi: spec WN flanş yerine
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
    } else if (t === 'Insert' && hasP3dCore) {
      const r = insertCode(String(o.name ?? ''));
      if (!r) continue;
      used++;
      out.push({
        id: rid(), line, code: r.code, sub: String(o.name ?? '').slice(0, 60),
        s1: r.s1mm != null ? dnToNps(r.s1mm) : null,
        s2: r.s2mm ? (dnToNps(r.s2mm) ?? 0) : 0, qty: 1, unit: 'EA',
        remark: 'vendor blok', scope: 'MAIN',
        _oids: o.objectid != null ? [o.objectid] : undefined,
      });
    }
  }
  return used;
}

type PartialExtractStats = { used: number; candidateObjects: number; rawRows: number };

function pushNamedRow(
  o: ApsObject,
  component: NamedComponent,
  out: RawRow[],
  candidates: Map<string, CandidateAccumulator>,
  fasteners: { gaskets: number; boltSets: number; stubEnds: number },
  rules: CalibrationRules,
  provenance: ApsCandidate['provenance'],
): 'row' | 'candidate' {
  const [s1, s2] = componentSizes(component.dns);
  const needsSecondSize = component.code === 'CON RED' || component.code === 'ECC RED' || component.code === 'RED TEE';
  const I = o.properties?.Item ?? {};
  const line = cleanSource(String(I['Source File'] ?? ''));
  const objectId = o.objectid;

  // İsimde boru kimliği/çapı olsa bile uzunluk yoksa metre üretmek yasak.
  if (component.code === 'PIPE') {
    addCandidate(candidates, {
      kind: 'pipe-without-length', code: component.code, label: component.code,
      s1, s2: 0, confidence: component.confidence, provenance,
    }, objectId);
    return 'candidate';
  }
  if (s1 === null || (needsSecondSize && s2 === 0)) {
    addCandidate(candidates, {
      kind: 'piping-component', code: component.code, label: component.code,
      s1, s2, confidence: component.confidence, provenance,
    }, objectId);
    return 'candidate';
  }

  let scope: 'MAIN' | 'INFO' = 'MAIN';
  if (component.code === 'GASKET' || component.code === 'BOLT SET') scope = rules.includeFasteners ? 'MAIN' : 'INFO';
  if (component.code === 'MV' || component.code === 'CV' || component.code === 'STRAINER') {
    scope = rules.includeValvesInMain ? 'MAIN' : 'INFO';
  }
  if (component.code === 'GASKET') fasteners.gaskets++;
  else if (component.code === 'BOLT SET') fasteners.boltSets++;
  else if (component.code === 'COLLAR') fasteners.stubEnds++;
  out.push({
    id: rid(), line, code: component.code, sub: '', s1, s2, qty: 1, unit: 'EA',
    remark: 'explicit DN nameplate', scope,
    _oids: objectId === undefined ? undefined : [objectId],
  });
  return 'row';
}

// Inventor/assembly dönüşümlerinde yerleştirilmiş parça "Instance" düğümüdür;
// aynı parçanın Part/Mesh çocuklarını saymak iki/üç kat miktar üretir. Yalnız
// Instance + açık komponent adı + standart DN birlikteyse satır çıkar.
function extractInventorNamedPiping(
  col: ApsObject[], out: RawRow[], candidates: Map<string, CandidateAccumulator>,
  fasteners: { gaskets: number; boltSets: number; stubEnds: number }, rules: CalibrationRules,
): PartialExtractStats {
  let used = 0;
  let candidateObjects = 0;
  const before = out.length;
  for (const o of col) {
    const I = o.properties?.Item ?? {};
    if (I.Type !== 'Instance') continue;
    const component = [I.Name, o.name]
      .map(value => namedComponent(String(value ?? '').replace(/_\d+$/, '')))
      .find((value): value is NamedComponent => value !== null) ?? null;
    if (!component) continue;
    const result = pushNamedRow(o, component, out, candidates, fasteners, rules, 'inventor-nameplate');
    if (result === 'row') used++;
    else candidateObjects++;
  }
  return { used, candidateObjects, rawRows: out.length - before };
}

// Generic AutoCAD'de Block tanımı ile Insert yerleşimi birebir yinelenir. Miktar
// için yalnız GUID'li/konumlu Insert düğümü sayılır; mesh/solid çocukları atılır.
function extractGenericAutoCad(
  col: ApsObject[], out: RawRow[], candidates: Map<string, CandidateAccumulator>,
  fasteners: { gaskets: number; boltSets: number; stubEnds: number }, rules: CalibrationRules,
): PartialExtractStats {
  let used = 0;
  let candidateObjects = 0;
  const before = out.length;
  const seen = new Set<string>();
  for (const o of col) {
    const P = o.properties ?? {}, I = P.Item ?? {};
    if (I.Type !== 'Insert' || !P['AutoCAD Geometry'] || P.AutoCAD) continue;
    // APS dbId bir yerleşimi tanımlar. AutoCAD GUID'i aynı blok tanımını kullanan
    // birden fazla fiziksel Insert'te ortak olabildiğinden ancak dbId yoksa yedektir.
    const identity = String(o.objectid ?? I.GUID ?? '');
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    const named = [I.Name, o.name]
      .map(value => String(value ?? ''))
      .map(name => ({ name, component: namedComponent(name) }))
      .find(value => value.component !== null);
    if (!named?.component) continue;
    // Generic blok ürün numaralarındaki çıplak rakamları çap kabul etme. Satır
    // için açık DN veya "100x80" ölçü serisi gerekir; aksi halde yalnız adaydır.
    const hasExplicitSize = explicitDns(named.name).length > 0 || explicitMetricSizeSeries(named.name).length > 0;
    const component = hasExplicitSize ? named.component : { ...named.component, dns: [] };
    const result = pushNamedRow(o, component, out, candidates, fasteners, rules, 'autocad-explicit-block');
    if (result === 'row') used++;
    else candidateObjects++;
  }
  return { used, candidateObjects, rawRows: out.length - before };
}

function normalizeSteelProfile(raw: string): string | null {
  const value = cleanSpace(raw).toUpperCase().replace(/\*/g, 'X');
  const known = value.match(/^(?:UB|UC|PFC|RHS|SHS|CHS|RSA|EA|UA|FLT|PLT|FBAR|SBAR|RBAR)\s*-?\s*[\d.]+(?:X[\d.]+){1,2}$/);
  return known ? value.replace(/\s+/g, '') : null;
}

function inventorSteelProfile(raw: string): string | null {
  const value = cleanSpace(raw).toUpperCase();
  const section = value.match(/\b(UB|UC|PFC|RHS|SHS|CHS)\s*-?\s*(\d+(?:[._]\d+)?(?:\s*[X*]\s*\d+(?:[._]\d+)?){1,2})\b/i);
  if (section) return `${section[1].toUpperCase()}${section[2].replace(/\s/g, '').replace(/\*/g, 'X').replace(/_(?=\d)/g, '.')}`;
  const zed = value.match(/\b(\d{2,4}Z\d{2,3})\b/);
  return zed ? zed[1] : null;
}

function collectIfcTeklaSteel(col: ApsObject[], candidates: Map<string, CandidateAccumulator>): number {
  const seen = new Set<string>();
  let objects = 0;
  for (const o of col) {
    const P = o.properties ?? {}, I = P.Item ?? {};
    const type = String(I.Type ?? '');
    const rawProfile = type.match(/^Ifc(?:Beam|Column|Member):\s*(.+)$/i)?.[1] ?? '';
    const profile = normalizeSteelProfile(rawProfile);
    const globalId = String(P.Element?.GlobalId ?? P.BaseQuantities?.GlobalId ?? P['Tekla Quantity']?.GlobalId ?? '');
    if (!profile || !globalId || seen.has(globalId)) continue;
    seen.add(globalId);
    const base = P.BaseQuantities ?? {}, tekla = P['Tekla Quantity'] ?? {};
    const lengthMm = finiteUnit(base.Length, 'mm') ?? finiteUnit(tekla.Length, 'mm');
    const weightKg = finiteUnit(base.NetWeight, 'kg') ?? finiteUnit(tekla.Weight, 'kg');
    // Profil kimliği tek başına adaydır; explicit unit'li miktarlar varsa ayrıca
    // taşınır. Hiçbiri MtoRow/teklif toplamına otomatik girmez.
    addCandidate(candidates, {
      kind: 'steel-profile', code: 'STEEL PROFILE', label: profile,
      s1: null, s2: 0,
      ...(lengthMm !== null ? { lengthM: lengthMm / 1000 } : {}),
      ...(weightKg !== null ? { weightKg } : {}),
      confidence: lengthMm !== null || weightKg !== null ? 0.96 : 0.8,
      provenance: 'ifc-tekla-quantities',
    }, o.objectid);
    objects++;
  }
  return objects;
}

function collectInventorSteel(col: ApsObject[], candidates: Map<string, CandidateAccumulator>): number {
  let objects = 0;
  for (const o of col) {
    const I = o.properties?.Item ?? {};
    if (I.Type !== 'Group') continue;
    const source = String(I['Source File'] ?? '');
    const name = String(o.properties?.Project?.['Part Number'] ?? I.Name ?? o.name ?? '');
    if (!/\.iam$/i.test(source) && !/\.ipt$/i.test(String(I.Name ?? o.name ?? ''))) continue;
    const profile = inventorSteelProfile(name);
    if (!profile) continue;
    addCandidate(candidates, {
      kind: 'steel-profile', code: 'STEEL PROFILE', label: profile,
      s1: null, s2: 0, confidence: 0.74, provenance: 'inventor-nameplate',
    }, o.objectid);
    objects++;
  }
  return objects;
}

// ---- satır-düzeyi kural uygulaması (vocab.applyRules.push ile aynı semantik) ----
function applyRowRules(rowsIn: RawRow[], rules: CalibrationRules): RawRow[] {
  const excl = new Set(rules.excludeLines ?? []);
  const agg = new Map<string, RawRow>();
  for (const r0 of rowsIn) {
    let { code, s1, s2, unit, scope } = r0;
    let qty = r0.qty;
    code = rules.codeRenames[code] ?? code;
    for (const correction of rules.itemCorrections ?? []) {
      // Eski kurallar geriye uyumlu olarak aktiftir. Yeni lifecycle'da aday veya
      // reddedilmiş bir kalibrasyon gelecek model sonuçlarını değiştiremez.
      if (correction.status !== undefined && correction.status !== 'active') continue;
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
      if (correction.set.qtyFactor !== undefined) qty *= correction.set.qtyFactor;
    }
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

export function extractFromApsProps(collection: unknown[], rules: CalibrationRules, totalCountOverride?: number): ApsExtractResult {
  const col = collection as ApsObject[];
  const fasteners = { gaskets: 0, boltSets: 0, stubEnds: 0 };
  const raw: RawRow[] = [];
  const candidateMap = new Map<string, CandidateAccumulator>();

  const beforeRevit = raw.length;
  const revitUsed = extractRevit(col, raw);
  const revitRows = raw.length - beforeRevit;
  // conta/cıvata satırları boyutLU olarak extractP3dDwg içinde üretilir
  // (includeFasteners kapalıysa INFO kapsamında — çift sayım yok)
  const beforeP3d = raw.length;
  const p3dUsed = extractP3dDwg(col, raw, fasteners, rules);
  const p3dRows = raw.length - beforeP3d;
  // Güçlü bir native schema bulunduysa isim tabanlı fallback aynı objeleri farklı
  // ailede tekrar saymasın. Fallback'ler yalnız native extraction yokken çalışır.
  const useFallback = revitUsed === 0 && p3dUsed === 0;
  const emptyStats: PartialExtractStats = { used: 0, candidateObjects: 0, rawRows: 0 };
  const inventor = useFallback
    ? extractInventorNamedPiping(col, raw, candidateMap, fasteners, rules) : emptyStats;
  const genericCad = useFallback
    ? extractGenericAutoCad(col, raw, candidateMap, fasteners, rules) : emptyStats;
  const ifcSteelObjects = useFallback ? collectIfcTeklaSteel(col, candidateMap) : 0;
  const inventorSteelObjects = useFallback ? collectInventorSteel(col, candidateMap) : 0;

  const withOids = applyRowRules(raw, rules);
  // viewer eşlemesi ayrılır, satırlar temiz MtoRow olarak döner (DB'ye _oids sızmaz)
  const objectMap: Record<string, number[]> = {};
  const rows: MtoRow[] = withOids.map(({ _oids, ...row }) => {
    if (_oids?.length) objectMap[row.id] = _oids;
    return row;
  });
  const totals = computeTotals(rows, []);
  const candidates = finishCandidates(candidateMap);
  const candidateObjects = candidates.reduce((sum, c) => sum + c.count, 0);
  const structuredCount = revitUsed + p3dUsed + inventor.used + genericCad.used;
  const totalCount = totalCountOverride ?? col.length;

  const provenance: ApsProvenance[] = [];
  if (revitUsed) provenance.push({
    extractor: 'revit-properties', objects: revitUsed, rows: revitRows, candidates: 0, confidence: 0.97,
    evidence: ['Element.Id', 'Element.Category', 'Element.Size', 'Custom.Description BOM'],
    limitations: ['Accuracy requires an answer workbook; structured does not mean ground-truth complete.'],
  });
  if (p3dUsed) provenance.push({
    extractor: 'plant3d-properties', objects: p3dUsed, rows: p3dRows, candidates: 0, confidence: 0.98,
    evidence: ['Item.Type', 'AutoCAD.Class', 'AutoCAD.Port*_NominalDiameter', 'AutoCAD.Length'],
    limitations: ['Only recognized Plant3D classes and explicit vendor inserts are counted.'],
  });
  if (inventor.used || inventor.candidateObjects) provenance.push({
    extractor: 'inventor-nameplate', objects: inventor.used + inventor.candidateObjects,
    rows: inventor.rawRows, candidates: inventor.candidateObjects, confidence: 0.84,
    evidence: ['Item.Type=Instance', 'Item.Name component token', 'explicit standard DN token'],
    limitations: ['Pipe identity without an explicit length remains a candidate.', 'Assembly/Part/Mesh nodes are excluded to prevent double counting.'],
  });
  if (inventorSteelObjects) provenance.push({
    extractor: 'inventor-steel-nameplate', objects: inventorSteelObjects, rows: 0,
    candidates: inventorSteelObjects, confidence: 0.74,
    evidence: ['Item.Type=Group', 'Inventor .iam/.ipt source', 'recognized section token'],
    limitations: ['No explicit member length or weight; candidates never enter totals.'],
  });
  if (ifcSteelObjects) provenance.push({
    extractor: 'ifc-tekla-quantities', objects: ifcSteelObjects, rows: 0,
    candidates: ifcSteelObjects, confidence: 0.96,
    evidence: ['Element.GlobalId deduplication', 'Item.Type IFC section', 'BaseQuantities/Tekla Quantity unit fields'],
    limitations: ['Steel candidates are reported separately and never mixed into piping totals.'],
  });
  if (genericCad.used || genericCad.candidateObjects) provenance.push({
    extractor: 'autocad-explicit-block', objects: genericCad.used + genericCad.candidateObjects,
    rows: genericCad.rawRows, candidates: genericCad.candidateObjects, confidence: 0.8,
    evidence: ['Item.Type=Insert', 'AutoCAD Geometry insertion', 'explicit component/standard DN token'],
    limitations: ['Block definitions and solid children are excluded.', 'Unlabelled geometry is never classified by shape alone.'],
  });

  const families = new Set<ApsFamily>();
  if (revitUsed) families.add('revit');
  if (p3dUsed) families.add('plant3d-dwg');
  if (inventor.used || inventor.candidateObjects || inventorSteelObjects) families.add('inventor-assembly');
  if (ifcSteelObjects) families.add('ifc-tekla');
  if (genericCad.used || genericCad.candidateObjects) families.add('generic-autocad');
  const family: ApsFamily = families.size > 1 ? 'mixed' : (families.values().next().value ?? 'none');
  const partialObjects = inventor.used + inventor.candidateObjects + inventorSteelObjects
    + ifcSteelObjects + genericCad.used + genericCad.candidateObjects;
  const quality: ApsExtractResult['quality'] = partialObjects > 0 ? 'partial' : rows.length ? 'structured' : 'none';
  const weighted = provenance.reduce((sum, p) => sum + p.confidence * Math.max(1, p.objects), 0);
  const weight = provenance.reduce((sum, p) => sum + Math.max(1, p.objects), 0);
  const confidence = weight ? round3(weighted / weight) : 0;
  const ratio = (n: number) => totalCount > 0 ? Math.round(Math.min(1, n / totalCount) * 10_000) / 10_000 : 0;
  const coverage: ApsCoverage = {
    totalObjects: totalCount,
    recognizedObjects: structuredCount + candidateObjects,
    measurableObjects: structuredCount,
    candidateObjects,
    recognizedRatio: ratio(structuredCount + candidateObjects),
    measurableRatio: ratio(structuredCount),
  };
  return {
    rows, totals, fasteners, family, quality, confidence, coverage, provenance, candidates,
    structuredCount,
    // akışlı yol koleksiyonu önceden filtreler — gerçek toplam ayrıca gelir
    totalCount,
    lineCount: totals.lines.length,
    objectMap,
  };
}
