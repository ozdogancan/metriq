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
  before: Partial<MtoRow> | null;
  after: Partial<MtoRow> | null;
  context: { vocab: string; fileName?: string; calibrationId?: string | null };
}
