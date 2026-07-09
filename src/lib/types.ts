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
