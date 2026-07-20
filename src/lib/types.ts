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
}

export interface Run {
  id: string;
  projectName: string;
  fileName: string;
  fileSize: number;
  vocab: VocabProfileId;
  calibrationId: string | null;
  status: 'processing' | 'done' | 'error';
  error?: string;
  aps?: RunApsJob | null;
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
  rows: AnswerDiffRow[];
  createdAt: string;
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
  };
  source: 'accepted_answer' | 'custom';
  evidenceCount: number;
}

export interface Calibration {
  id: string;
  name: string;
  rules: CalibrationRules;
  learnedFrom: string[]; // run id'leri
  version?: number;
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
