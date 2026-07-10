// Metriq — NWD parser sözleşmesi + çekirdek adaptörü.
// Çekirdek: nwd-core.ts (dwg-takeoff/nwd_mto3.py'nin TS portu; 26010+26113 vakalarında
// 54/54 regresyon doğrulamalı). Bu dosya çekirdek çıktısını platform sözleşmesine uyarlar.
import { parseNwd as coreParse } from './nwd-core';

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

export function parseNwd(buf: Buffer): ParseResult {
  const r = coreParse(buf);
  return {
    components: r.components.map(c => ({
      klass: c.klass,
      guid: c.guid,
      line: c.line,
      lineGuessed: c.lineGuessed,
      desc: c.desc,
      sub: c.sub,
      s1: c.s1,
      s2: c.s2,
      lengthMm: c.unit === 'M' ? Math.round(c.qty * 1000) : 0,
      metric: c.metric,
    })),
    steelMembers: r.steelMembers,
    fasteners: r.fasteners,
    stats: {
      blobCount: r.stats.blobs,
      recordCount: r.stats.records,
      uniqueComponents: r.stats.uniqueComponents,
    },
  };
}
