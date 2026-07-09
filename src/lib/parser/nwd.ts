// Metriq — NWD parser sözleşmesi.
// Gerçek implementasyon: TS portu (dwg-takeoff/nwd_mto3.py'den, 3 vakayla regresyon-testli).
// Bu dosya ajan teslimiyle değiştirilir; sözleşme sabittir.

export interface ParsedComponent {
  klass: string;        // Pipe | Elbow | Flange | Valve | Tee | Reducer | ...
  guid: string;
  line: string;         // hat adı (S1, STEAM MAIN HEADER, ...)
  lineGuessed?: boolean;
  desc: string;         // Long Description (upper-case aramalar için ham)
  sub: string;          // flanş alt tipi / vana tipi
  s1: number | null;    // nominal inç
  s2: number;           // ikinci boyut (0 = yok)
  lengthMm: number;     // Pipe için kesim boyu; diğerleri 0
  metric: boolean;      // DIN 11850-2 hijyenik seri mi
}

export interface SteelMember { profile: string; lengthMm: number; kg: number | null }

export interface ParseResult {
  components: ParsedComponent[];
  steelMembers: SteelMember[];
  fasteners: { gaskets: number; boltSets: number; stubEnds: number };
  stats: { blobCount: number; recordCount: number; uniqueComponents: number };
}

export function parseNwd(_buf: Buffer): ParseResult {
  throw new Error('NWD parser henüz bağlanmadı (TS portu entegre edilecek)');
}
