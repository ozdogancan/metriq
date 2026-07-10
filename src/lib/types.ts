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

export interface Run {
  id: string;
  projectName: string;
  fileName: string;
  fileSize: number;
  vocab: VocabProfileId;
  calibrationId: string | null;
  status: 'processing' | 'done' | 'error';
  error?: string;
  totals: RunTotals;
  fasteners: { gaskets: number; boltSets: number; stubEnds: number };
  progress?: StageEvent[];
  ai?: AiAudit | null;
  answer?: AnswerDiff | null; // müşteri cevap Excel'i karşılaştırması (ground truth)
  createdAt: string;
}

// ---------- Cevap karşılaştırması (müşteri Excel'i = ground truth) ----------
export type AnswerRowStatus = 'match' | 'qty_diff' | 'missing' | 'extra';
export interface AnswerDiffRow {
  status: AnswerRowStatus;
  code: string;
  s1: number | null;
  s2: number;
  unit: Unit;
  ours: number;    // bizim miktar (0 = bizde yok)
  answer: number;  // cevaptaki miktar (0 = cevapta yok)
}
export interface AnswerDiff {
  fileName: string;
  sheet: string;
  accuracy: number;              // eşleşen anahtar / cevaptaki anahtar (%)
  counts: { matched: number; qtyDiff: number; missing: number; extra: number };
  rows: AnswerDiffRow[];         // en fazla 200 satır (önce sorunlar)
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
}

export interface Calibration {
  id: string;
  name: string;
  rules: CalibrationRules;
  learnedFrom: string[]; // run id'leri
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
  message: string;
  rowId?: string;
}
export interface AiAudit {
  model: string;              // kullanılan Claude modeli
  complexity: number;         // 0-100
  tier: 'basit' | 'orta' | 'karmaşık';
  findings: AiFinding[];
  summary: string;
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
