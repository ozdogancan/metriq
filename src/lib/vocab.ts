// Metriq — parser çıktısına kalibrasyon kurallarını uygular → MtoRow[]
// Kurallar üç gerçek müşteri vakasıyla kalibre edildi (bkz. dwg-takeoff/METODOLOJI.md)
import type { CalibrationRules, MtoRow, RunTotals, SteelRow, VocabProfileId } from './types';
import type { ParsedComponent, ParseResult } from './parser/nwd';
import { isCorrectionRuleActive } from './calibration-core';
import { is45DegreeBendDescription } from './parser/nwd-core';

// Tesisat tipini dosyadan algıla — sinyaller iki gerçek vakada ölçüldü (2026-07-10):
// Hijyenik fixture: TRU-BORE / DIN 11850; çelik fixture: ASME / WELD NECK / A105.
export function detectVocab(parsed: ParseResult): { vocab: VocabProfileId; hygienicHits: number; steelHits: number } {
  let hyg = 0, steel = 0;
  for (const c of parsed.components) {
    const d = (c.desc + ' ' + c.sub).toUpperCase();
    if (d.includes('TRU-BORE') || d.includes('TRUBORE') || d.includes('TRI-CLAMP') || d.includes('FERRULE') || d.includes('11850')) hyg++;
    if (d.includes('ASME') || d.includes('WELD NECK') || d.includes('A105')) steel++;
  }
  return { vocab: hyg > steel ? 'hygienic' : 'steel-plant', hygienicHits: hyg, steelHits: steel };
}

// Satır kimliği: ilk 8 karakter ('r' + 7 rastgele) satırlar arası ayırt edici olmalı —
// AI denetçi rowId eşlemesi id.slice(0,8) ile çalışır (bkz. lib/ai.ts).
let seq = 0;
const rid = () => `r${Math.random().toString(36).slice(2, 9).padEnd(7, '0')}-${++seq}`;

export function applyRules(parsed: ParseResult, rules: CalibrationRules): {
  rows: MtoRow[]; steel: SteelRow[]; totals: RunTotals;
} {
  const rows: MtoRow[] = [];
  const comps = parsed.components;

  // Refakat flanşı tespiti yalnız açık katalog tanımı + aynı hat/boyut kanıtıyla
  // yapılır. NWD segment sırası fiziksel bağlantı değildir; salt ±2 yakınlık,
  // özellikle farklı hatların art arda yazıldığı modellerde gerçek flanşları siler.
  const NEI = new Set(['Valve', 'InlineInstrument', 'Strainer', 'SpacerDisk']);
  const COMPANION_HINT = /\b(?:COMPANION|MATING)\s+FLANGE\b|\bFLANGE\s+(?:FOR|AT)\s+(?:VALVE|INSTRUMENT|STRAINER)\b/i;
  const companion = new Set<number>();
  comps.forEach((c, i) => {
    if (c.klass !== 'Flange' || !COMPANION_HINT.test(`${c.desc} ${c.sub}`)) return;
    for (let j = Math.max(0, i - 2); j <= Math.min(comps.length - 1, i + 2); j++) {
      const neighbour = comps[j];
      if (j !== i && NEI.has(neighbour.klass)
        && !c.lineGuessed && !neighbour.lineGuessed
        && c.line === neighbour.line && c.s1 != null && c.s1 === neighbour.s1) {
        companion.add(i);
        break;
      }
    }
  });

  const agg = new Map<string, MtoRow>();
  function push(line: string, code: string, sub: string, s1: number | null, s2: number,
    qty: number, unit: 'M' | 'EA', remark: string, scope: 'MAIN' | 'INFO') {
    code = rules.codeRenames[code] ?? code;
    // Cevap/özel değer kabulünden öğrenilen kurallar profil içinde yalnız tam
    // çıktı imzasına uygulanır. Hat/alt-tip varsa eşleşmeyi daha da daraltır.
    for (const correction of rules.itemCorrections ?? []) {
      if (!isCorrectionRuleActive(correction)) continue;
      const m = correction.match;
      // Tek-örnek güvenlik kapısı: "boyut bilinmiyor" (s1=null) kovasına DEĞER atayan
      // kurallar ya hat/alt-tip bağlamı taşımalı ya da ≥2 dosyada doğrulanmış olmalı —
      // yoksa tek dosyadaki '?→10"' kabulü sonraki her dosyanın boyutsuzlarına yayılırdı.
      // (aps-extract.ts applyRowRules ile AYNI semantik tutulur.)
      if (m.s1 === null && Object.prototype.hasOwnProperty.call(correction.set, 's1')
        && correction.evidenceCount < 2 && m.line === undefined && m.sub === undefined) continue;
      if (m.code !== code || m.s1 !== s1 || m.s2 !== s2 || m.unit !== unit
        || (m.line !== undefined && m.line !== line)
        || (m.sub !== undefined && m.sub !== sub)) continue;
      if (correction.set.code !== undefined) code = correction.set.code;
      if (Object.prototype.hasOwnProperty.call(correction.set, 's1')) s1 = correction.set.s1 ?? null;
      if (correction.set.s2 !== undefined) s2 = correction.set.s2;
      if (correction.set.unit !== undefined) unit = correction.set.unit;
      if (correction.set.scope !== undefined) scope = correction.set.scope;
      if (correction.set.qtyFactor !== undefined) qty *= correction.set.qtyFactor;
    }
    const key = [line, code, sub, s1, s2, unit, scope].join('|');
    const ex = agg.get(key);
    if (ex) { ex.qty += qty; if (remark && !ex.remark.includes(remark)) ex.remark = [ex.remark, remark].filter(Boolean).join('; '); }
    else agg.set(key, { id: rid(), line, code, sub, s1, s2, qty, unit, remark, scope });
  }

  comps.forEach((c: ParsedComponent, i) => {
    const line = c.line || '?';
    switch (c.klass) {
      case 'Pipe':
        push(line, 'PIPE', '', c.s1, 0, (c.lengthMm / 1000) * rules.grossPipeFactor, 'M', '', 'MAIN');
        break;
      case 'Elbow': {
        const is45 = is45DegreeBendDescription(c.desc);
        if (is45 && rules.merge45Into90) push(line, '90 BEND', '', c.s1, 0, 1, 'EA', '45° (birleşik)', 'MAIN');
        else push(line, is45 ? '45 BEND' : '90 BEND', '', c.s1, 0, 1, 'EA', '', 'MAIN');
        break;
      }
      case 'Tee': {
        const red = c.desc.includes('RED') || (c.s2 > 0 && c.s2 !== c.s1);
        push(line, red ? 'RED TEE' : 'EQ TEE', '', c.s1, red ? c.s2 : 0, 1, 'EA', '', 'MAIN');
        break;
      }
      case 'Reducer': {
        const ecc = c.desc.includes('ECC');
        const code = rules.vocab === 'hygienic' ? (ecc ? 'ECC RED' : 'CON RED') : 'CON RED';
        push(line, code, '', c.s1, c.s2, 1, 'EA', rules.vocab === 'hygienic' ? '' : (ecc ? 'ECC' : ''), 'MAIN');
        break;
      }
      case 'BlindFlange':
        push(line, 'BLIND FLANGE', '', c.s1, 0, 1, 'EA', '', 'MAIN');
        break;
      case 'Flange': {
        const excluded = rules.excludeCompanionFlanges && companion.has(i);
        if (rules.vocab === 'hygienic') {
          const s1 = c.s1 ?? null;
          push(line, 'BACKING FLANGE', c.sub, s1, 0, 1, 'EA', s1 == null ? 'boyut ? (elemeyle ata)' : '', excluded ? 'INFO' : 'MAIN');
          if (rules.collarOneToOne) push(line, 'COLLAR', '1:1', s1, 0, 1, 'EA', '', excluded ? 'INFO' : 'MAIN');
        } else {
          push(line, 'FLANGE', c.sub, c.s1, 0, 1, 'EA', excluded ? 'vana/enstrüman refakatçisi' : '', excluded ? 'INFO' : 'MAIN');
        }
        break;
      }
      case 'Valve':
      case 'Strainer': {
        const scope = rules.includeValvesInMain ? 'MAIN' : 'INFO';
        const code = rules.vocab === 'hygienic' ? 'MV' : (c.klass === 'Strainer' ? 'STRAINER' : 'VALVE');
        push(line, code, c.sub || (c.klass === 'Strainer' ? 'FILTER' : ''), c.s1, 0, 1, 'EA', '', scope);
        break;
      }
      case 'InlineInstrument':
        push(line, 'INSTRUMENT', c.sub, c.s1, 0, 1, 'EA', '', 'INFO');
        break;
      case 'Cap':
        push(line, 'CAP', '', c.s1, 0, 1, 'EA', '', 'MAIN');
        break;
      case 'Support':
        push(line, 'SUPPORT', '', c.s1, 0, 1, 'EA', '', 'INFO');
        break;
      default:
        push(line, c.klass.toUpperCase(), '', c.s1, 0, 1, 'EA', '', 'INFO');
    }
  });

  {
    const f = parsed.fasteners;
    // Bağlantı elemanları ARTIK HER ZAMAN üretilir; kural yalnız KAPSAMI belirler
    // (MAIN = teklife girer, INFO = bulunundu ama sayılmıyor). Böylece cevap
    // Excel'i bunları istediğinde sistem "bizde var, bilgi bölümünde" diyebilir
    // ve kuralı kendisi önerebilir. aps-extract zaten bu semantikte.
    const fastenerScope: 'MAIN' | 'INFO' = rules.includeFasteners ? 'MAIN' : 'INFO';
    // Müşteri listeleri contayı ÇAP BAZINDA sayar; boyutsuz toplam satırı
    // karşılaştırma anahtarında (kod|çap|birim) hiçbir zaman eşleşemez.
    // Boyut kırılımı varsa onu kullan (ENQ-237'de cevapla birebir doğrulandı).
    const sizedGaskets = Object.entries(f.bySize?.gaskets ?? {});
    if (sizedGaskets.length) {
      for (const [nps, n] of sizedGaskets) {
        push('*', 'GASKET', '', Number(nps), 0, n, 'EA', 'bağlantı başına 1', fastenerScope);
      }
    } else if (f.gaskets) {
      push('*', 'GASKET', '', null, 0, f.gaskets, 'EA', 'bağlantı başına 1', fastenerScope);
    }
    const sizedBolts = Object.entries(f.bySize?.boltSets ?? {});
    if (sizedBolts.length) {
      for (const [nps, n] of sizedBolts) push('*', 'BOLT SET', '', Number(nps), 0, n, 'EA', '', fastenerScope);
    } else if (f.boltSets) {
      push('*', 'BOLT SET', '', null, 0, f.boltSets, 'EA', '', fastenerScope);
    }
    if (f.stubEnds) push('*', 'STUB END', '', null, 0, f.stubEnds, 'EA', '', fastenerScope);
  }

  // öğrenilen kapsam-dışı hatlar: satırları silmek yerine INFO'ya indir (izlenebilir kalsın)
  const excl = new Set(rules.excludeLines ?? []);
  for (const r of agg.values()) {
    if (r.unit === 'M') r.qty = Math.round(r.qty * 1000) / 1000;
    if (r.scope === 'MAIN' && excl.has(r.line)) {
      r.scope = 'INFO';
      r.remark = [r.remark, 'kapsam dışı (kalibrasyon)'].filter(Boolean).join('; ');
    }
    rows.push(r);
  }
  const codeOrder = ['PIPE', '90 BEND', '45 BEND', 'EQ TEE', 'RED TEE', 'CON RED', 'ECC RED',
    'FLANGE', 'BACKING FLANGE', 'COLLAR', 'BLIND FLANGE', 'WELDOLET', 'MV', 'VALVE'];
  // bilinmeyen kodlar listenin SONUNA (999) — önüne değil
  const codeRank = (code: string) => { const i = codeOrder.indexOf(code); return i < 0 ? 999 : i; };
  rows.sort((a, b) => a.line.localeCompare(b.line)
    || codeRank(a.code) - codeRank(b.code)
    || (b.s1 ?? -1) - (a.s1 ?? -1));

  // çelik: profil+boy bazında grupla
  const steelMap = new Map<string, SteelRow>();
  for (const m of parsed.steelMembers) {
    const key = `${m.profile}|${Math.round(m.lengthMm)}`;
    const ex = steelMap.get(key);
    if (ex) { ex.count += 1; ex.totalKg += m.kg ?? 0; }
    else steelMap.set(key, { id: rid(), profile: m.profile, lengthMm: Math.round(m.lengthMm), count: 1, totalKg: m.kg ?? 0 });
  }
  const steel = [...steelMap.values()].sort((a, b) => b.lengthMm - a.lengthMm);

  const totals = computeTotals(rows, steel, parsed.steelMembers.reduce((s, m) => s + m.lengthMm, 0));
  return { rows, steel, totals };
}

export function computeTotals(rows: MtoRow[], steel: SteelRow[], steelMmOverride?: number): RunTotals {
  const main = rows.filter(r => r.scope === 'MAIN');
  const pipeM = main.filter(r => r.code === 'PIPE').reduce((s, r) => s + r.qty, 0);
  const flangesEa = main.filter(r => r.code.includes('FLANGE') || r.code === 'COLLAR').reduce((s, r) => s + r.qty, 0);
  const valvesEa = rows.filter(r => ['MV', 'VALVE', 'STRAINER'].includes(r.code)).reduce((s, r) => s + r.qty, 0);
  const fittingsEa = main.filter(r => ['90 BEND', '45 BEND', 'EQ TEE', 'RED TEE', 'CON RED', 'ECC RED', 'WELDOLET', 'CAP'].includes(r.code)).reduce((s, r) => s + r.qty, 0);
  const steelMm = steelMmOverride ?? steel.reduce((s, r) => s + r.lengthMm * r.count, 0);
  const steelKg = steel.reduce((s, r) => s + r.totalKg, 0);
  const lines = [...new Set(rows.map(r => r.line).filter(l => l !== '*' && l !== '?'))].sort();
  return {
    pipeM: Math.round(pipeM * 100) / 100,
    fittingsEa: Math.round(fittingsEa),
    flangesEa: Math.round(flangesEa),
    valvesEa: Math.round(valvesEa),
    steelM: Math.round(steelMm / 10) / 100,
    steelKg: Math.round(steelKg * 10) / 10,
    lines,
  };
}
