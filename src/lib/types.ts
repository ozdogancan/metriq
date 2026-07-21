// Metriq — çekirdek tipler
export type Unit = 'M' | 'EA';

export interface MtoRow {
  id: string;
  line: string;          // hat/çizim adı (S1, STEAM MAIN HEADER…)
  code: string;          // PIPE, 90 BEND, FLANGE…
  sub: string;           // alt tip (WELD NECK FLANGE, BALL…)
  s1: number | null;     // nominal inç
  s2: number;            // ikinci boyut (0 = yok)
  qty: number;
  unit: Unit;
  remark: string;
  scope: 'MAIN' | 'INFO';
  edited?: boolean;      // kullanıcı düzenledi (kalibrasyon sinyali)
}

export interface SteelRow {
  id: string;
  profile: string;
  lengthMm: number;
  count: number;
  totalKg: number;
}

export interface RunTotals {
  pipeM: number;
  fittingsEa: number;
  flangesEa: number;
  valvesEa: number;
  steelM: number;
  steelKg: number;
  lines: string[];
}

// APS bulut çıkarım işi: yerel parser yapısal veri bulamayınca devreye girer.
// Çeviri dakikalar sürer; istemci /advance endpoint'i ile ilerletir.
export interface RunApsJob {
  urn: string;
  objectKey: string;
  guid?: string;
  submittedAt: string;
  claimedUntil?: string; // ready-tamamlama kilidi: çift instance aynı işi bitirmesin
  retriedAt?: string;    // geçici çeviri-hatasında tek otomatik yeniden deneme
  analysis?: ExtractionQuality;
}

export interface ExtractionQuality {
  family: string;
  quality: 'structured' | 'partial' | 'none';
  /** Şema kanıtının gücü; cevap Excel'iyle ölçülen accuracy değildir. */
  confidence: number;
  releaseEligible: boolean;
  coverage: {
    totalObjects: number;
    recognizedObjects: number;
    measurableObjects: number;
    candidateObjects: number;
    recognizedRatio: number;
    measurableRatio: number;
  };
  provenance: Array<{
    extractor: string;
    objects: number;
    rows: number;
    candidates: number;
    confidence: number;
    limitations: string[];
  }>;
  candidates?: Array<{
    kind: 'steel-profile' | 'piping-component' | 'pipe-without-length';
    code: string;
    label: string;
    count: number;
    s1: number | null;
    s2: number;
    lengthM?: number;
    weightKg?: number;
    confidence: number;
  }>;
}

export interface RunCalibrationSnapshot {
  id: string;
  name: string;
  version: number;
  rules: CalibrationRules;
  modelFamily: 'plant3d-local' | 'aps' | 'legacy';
  clientKey: string;
}

export interface Run {
  id: string;
  projectName: string;
  fileName: string;
  fileSize: number;
  vocab: VocabProfileId;
  calibrationId: string | null;
  calibrationSnapshot?: RunCalibrationSnapshot | null;
  status: 'processing' | 'done' | 'error';
  error?: string;
  aps?: RunApsJob | null;
  /** Extractor evidence quality for every local or APS run. */
  analysis?: ExtractionQuality | null;
  totals: RunTotals;
  fasteners: { gaskets: number; boltSets: number; stubEnds: number };
  progress?: StageEvent[];
  ai?: AiAudit | null;
  answer?: AnswerDiff | null; // müşteri cevap Excel'i karşılaştırması (ground truth)
  rowRevision?: number;       // satırlar her değiştiğinde artar; bayat karşılaştırmayı engeller
  rowsHash?: string | null;
  comparisonRevision?: number;
  createdAt: string;
}

// ---------- Cevap karşılaştırması (müşteri Excel'i = ground truth) ----------
export interface AnswerValue {
  code: string;
  s1: number | null;
  s2: number;
  qty: number;
  unit: Unit;
}

export interface AnswerSide {
  value: AnswerValue;
  rowIds: string[];
  lines?: string[];
  subs?: string[];
}

export type AnswerRowStatus = 'match' | 'qty_diff' | 'field_diff' | 'missing' | 'extra';
export interface AnswerDiffRow {
  id?: string;                    // eski kayıtlarla geriye uyum için opsiyonel
  status: AnswerRowStatus;
  kind?: 'quantity' | 'size' | 'code' | 'missing' | 'extra';
  code: string;
  s1: number | null;
  s2: number;
  unit: Unit;
  ours: number;    // bizim miktar (0 = bizde yok)
  answer: number;  // cevaptaki miktar (0 = cevapta yok)
  oursSide?: AnswerSide | null;
  answerSide?: AnswerSide | null;
}
export interface AnswerDiff {
  id?: string;                    // comparison id; eski sonuçlarda bulunmayabilir
  baseRowsHash?: string;
  baseRowsRevision?: number;
  fileName: string;
  sheet: string;
  accuracy: number;              // eşleşen / (cevap anahtarları + bizdeki fazla anahtarlar) (%)
  targetAccuracy?: number;
  projectedAccuracy?: number;
  appliedAt?: string;
  calibrationVersion?: number;
  counts: { matched: number; qtyDiff: number; fieldDiff?: number; missing: number; extra: number };
  metrics?: {
    precision: number;
    recall: number;
    f1: number;
    quantityWeightedOverlap: AnswerQuantityOverlap;
    quantityWeightedOverlapByUnit: Record<Unit, AnswerQuantityOverlap>;
  };
  rows: AnswerDiffRow[];
  /**
   * "Bunu zaten buluyoruz ama teklife katmıyoruz" önerileri. Karşılaştırma
   * yalnız MAIN'i görür; INFO'daki vana/conta cevapta saf 'eksik' gibi
   * görünürdü. Kullanıcı tek tıkla kuralı öğretir.
   */
  scopeSuggestions?: Array<{
    rule: 'includeValvesInMain' | 'includeFasteners';
    recoverable: number;
    codes: string[];
  }>;
  createdAt: string;
}

export interface AnswerQuantityOverlap {
  percent: number;
  intersection: number;
  union: number;
  oursTotal: number;
  answerTotal: number;
}

export type VocabProfileId = 'steel-plant' | 'hygienic';

export interface CalibrationRules {
  vocab: VocabProfileId;
  merge45Into90: boolean;         // 45° dirsek 90 BEND'e katılır
  collarOneToOne: boolean;        // COLLAR = backing flanş adedi (hijyenik)
  excludeCompanionFlanges: boolean; // vana/enstrüman refakat flanşı bulk dışı
  includeValvesInMain: boolean;   // vanalar ana listede (MV)
  includeFasteners: boolean;      // conta/cıvata ana listede
  grossPipeFactor: number;        // 1.0 = net; 1.18 ≈ gross
  codeRenames: Record<string, string>; // öğrenilen kod eşlemeleri
  excludeLines?: string[];        // öğrenilen kapsam-dışı hatlar (satırları INFO'ya iner)
  itemCorrections?: ItemCorrectionRule[]; // kabul edilmiş cevap/özel değerlerden öğrenilen kesin eşlemeler
}

export interface ItemCorrectionRule {
  id: string;
  match: {
    code: string;
    s1: number | null;
    s2: number;
    unit: Unit;
    line?: string;
    sub?: string;
  };
  set: {
    code?: string;
    s1?: number | null;
    s2?: number;
    unit?: Unit;
    scope?: 'MAIN' | 'INFO';
    qtyFactor?: number;
  };
  source: 'accepted_answer' | 'custom';
  evidenceCount: number;
  /**
   * Eski kayıtlarda status yoktur; bunlar geriye uyumluluk için aktif kabul edilir.
   * Yeni, genellenebilir kurallar önce adaydır ve bağımsız model kanıtı biriktirir.
   */
  status?: 'candidate' | 'active' | 'rejected';
  evidenceRunIds?: string[];
  minEvidence?: number;
}

export interface Calibration {
  id: string;
  name: string;
  rules: CalibrationRules;
  learnedFrom: string[]; // run id'leri
  version?: number;
  modelFamily?: 'plant3d-local' | 'aps' | 'legacy';
  clientKey?: string;
  status?: 'draft' | 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_RULES: Record<VocabProfileId, CalibrationRules> = {
  'steel-plant': {
    vocab: 'steel-plant',
    merge45Into90: true,
    collarOneToOne: false,
    excludeCompanionFlanges: true,
    includeValvesInMain: false,
    includeFasteners: false,
    grossPipeFactor: 1.0,
    codeRenames: {},
    excludeLines: [],
    itemCorrections: [],
  },
  hygienic: {
    vocab: 'hygienic',
    merge45Into90: true,
    collarOneToOne: true,
    excludeCompanionFlanges: false,
    includeValvesInMain: true,
    includeFasteners: false,
    grossPipeFactor: 1.0,
    codeRenames: {},
    excludeLines: [],
    itemCorrections: [],
  },
};

// ---------- İşleme aşamaları (canlı pipeline görünümü) ----------
export type StageKey = 'upload' | 'scan' | 'extract' | 'size' | 'lines' | 'rules' | 'steel' | 'audit' | 'finalize';
export interface StageEvent {
  key: StageKey;
  status: 'pending' | 'active' | 'done';
  startedAt?: string;
  metrics?: Record<string, string | number>;
}
export const STAGE_ORDER: StageKey[] = ['upload', 'scan', 'extract', 'size', 'lines', 'rules', 'steel', 'audit', 'finalize'];

// ---------- AI denetçi (Claude — komplexity'ye göre model) ----------
export interface AiFinding {
  severity: 'info' | 'warn' | 'critical';
  message: string;      // Türkçe
  messageEn?: string;   // English — UI dili EN iken gösterilir (eski kayıtlarda yok → TR'ye düşer)
  rowId?: string;
}
export interface AiAudit {
  model: string;              // kullanılan Claude modeli
  complexity: number;         // 0-100
  tier: 'basit' | 'orta' | 'karmaşık';
  findings: AiFinding[];
  summary: string;            // Türkçe
  summaryEn?: string;         // English
  createdAt: string;
}

// ---------- Bildirimler ----------
export interface AppNotification {
  id: string;
  kind: 'run_done' | 'run_error' | 'system';
  title: string;
  body: string;
  url: string;
  read: boolean;
  createdAt: string;
}

// ---------- Öğrenme olayları (ML-uyumlu düzeltme günlüğü) ----------
export interface LearningEvent {
  id: string;
  runId: string;
  ts: string;
  kind: 'row_edit' | 'row_add' | 'row_delete' | 'calibration_saved' | 'run_feedback';
  // row_* olaylarında Partial<MtoRow>; calibration_saved'da kurallar; run_feedback'te karne özeti
  before: Partial<MtoRow> | Record<string, unknown> | null;
  after: Partial<MtoRow> | Record<string, unknown> | null;
  context: { vocab: string; fileName?: string; calibrationId?: string | null };
}
