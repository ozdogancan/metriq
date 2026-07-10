// Metriq — müşteri cevap Excel'i karşılaştırması ("bu dosyanın doğru cevabı bu").
// Teklif-kritik: burada hiçbir rakam üretilmez/uydurulmaz — yalnız İKİ kaynak ölçülür:
// bizim deterministik motorun satırları ↔ müşterinin cevap dosyası.
import 'server-only';
import ExcelJS from 'exceljs';
import type { AnswerDiff, AnswerDiffRow, MtoRow, Unit } from './types';

interface AnswerRow { code: string; s1: number | null; s2: number; qty: number; unit: Unit }

// Başlık eş anlamlıları — müşteri şablonları TR/EN karışık gelebilir
const HEADERS: Record<string, RegExp> = {
  code: /material\s*code|malzeme\s*kodu|^kalem$|^kod$/i,
  s1in: /size\s*1.*(inch|inç|")|çap\s*1|^size1"?$/i,
  s2in: /size\s*2.*(inch|inç|")|çap\s*2|^size2"?$/i,
  qty: /^quantity$|^miktar$|adet-?boy|^qty$/i,
  unit: /qty\.?\s*units?|^birim$|^units?$/i,
};

function cellText(c: ExcelJS.CellValue): string {
  if (c == null) return '';
  if (typeof c === 'object' && 'richText' in (c as object)) {
    return ((c as { richText: { text: string }[] }).richText || []).map(t => t.text).join('');
  }
  if (typeof c === 'object' && 'result' in (c as object)) return String((c as { result: unknown }).result ?? '');
  return String(c);
}
function cellNum(c: ExcelJS.CellValue): number | null {
  const t = cellText(c).trim().replace(',', '.');
  if (t === '' || t === '?') return null;
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

// Sayfalar içinde en çok başlık eşleştiren satırı bul → kolon haritası
export function parseAnswerXlsx(buf: Buffer): Promise<{ rows: AnswerRow[]; sheet: string }> {
  return (async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    let best: { sheet: string; headerRow: number; cols: Record<string, number>; score: number } | null = null;

    for (const ws of wb.worksheets) {
      for (let r = 1; r <= Math.min(ws.rowCount, 12); r++) {
        const row = ws.getRow(r);
        const cols: Record<string, number> = {};
        let score = 0;
        row.eachCell({ includeEmpty: false }, (cell, colNo) => {
          const txt = cellText(cell.value).trim();
          for (const [key, re] of Object.entries(HEADERS)) {
            if (cols[key] == null && re.test(txt)) { cols[key] = colNo; score++; }
          }
        });
        if (score >= 3 && cols.code != null && cols.qty != null && (!best || score > best.score)) {
          best = { sheet: ws.name, headerRow: r, cols, score };
        }
      }
    }
    if (!best) throw new Error('Cevap dosyasında tanınan başlık satırı bulunamadı (Material Code / Quantity / Size 1 (inch) beklenir).');

    const ws = wb.getWorksheet(best.sheet)!;
    const rows: AnswerRow[] = [];
    for (let r = best.headerRow + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const code = cellText(row.getCell(best.cols.code).value).trim().toUpperCase();
      if (!code || /^toplam|^total/i.test(code)) continue;
      const qty = cellNum(row.getCell(best.cols.qty).value);
      if (qty == null || qty === 0) continue;
      const s1 = best.cols.s1in != null ? cellNum(row.getCell(best.cols.s1in).value) : null;
      const s2 = best.cols.s2in != null ? (cellNum(row.getCell(best.cols.s2in).value) ?? 0) : 0;
      const unitRaw = best.cols.unit != null ? cellText(row.getCell(best.cols.unit).value).trim().toUpperCase() : '';
      const unit: Unit = /^M(T|ETRE)?$/.test(unitRaw) || (!unitRaw && code === 'PIPE') ? 'M' : 'EA';
      rows.push({ code, s1, s2, qty, unit });
    }
    return { rows, sheet: best.sheet };
  })();
}

// Kod+çap düzeyinde karşılaştır (hat adları müşteri/model arasında değişir — anahtara girmez)
export function compareAnswer(ours: MtoRow[], answer: AnswerRow[], fileName: string, sheet: string): AnswerDiff {
  const key = (r: { code: string; s1: number | null; s2: number; unit: Unit }) =>
    `${r.code}|${r.s1 == null ? '?' : Math.round(r.s1 * 100) / 100}|${Math.round(r.s2 * 100) / 100}|${r.unit}`;

  const oursAgg = new Map<string, { qty: number; r: { code: string; s1: number | null; s2: number; unit: Unit } }>();
  for (const r of ours.filter(x => x.scope === 'MAIN')) {
    const k = key(r);
    const e = oursAgg.get(k);
    if (e) e.qty += r.qty; else oursAgg.set(k, { qty: r.qty, r });
  }
  const ansAgg = new Map<string, { qty: number; r: AnswerRow }>();
  for (const r of answer) {
    const k = key(r);
    const e = ansAgg.get(k);
    if (e) e.qty += r.qty; else ansAgg.set(k, { qty: r.qty, r });
  }

  const rows: AnswerDiffRow[] = [];
  let matched = 0, qtyDiff = 0, missing = 0, extra = 0;

  for (const [k, a] of ansAgg) {
    const o = oursAgg.get(k);
    if (!o) {
      missing++;
      rows.push({ status: 'missing', code: a.r.code, s1: a.r.s1, s2: a.r.s2, unit: a.r.unit, ours: 0, answer: round3(a.qty) });
      continue;
    }
    const tol = a.r.unit === 'M' ? Math.max(0.1, a.qty * 0.02) : 0.001;
    if (Math.abs(o.qty - a.qty) <= tol) {
      matched++;
      rows.push({ status: 'match', code: a.r.code, s1: a.r.s1, s2: a.r.s2, unit: a.r.unit, ours: round3(o.qty), answer: round3(a.qty) });
    } else {
      qtyDiff++;
      rows.push({ status: 'qty_diff', code: a.r.code, s1: a.r.s1, s2: a.r.s2, unit: a.r.unit, ours: round3(o.qty), answer: round3(a.qty) });
    }
  }
  for (const [k, o] of oursAgg) {
    if (!ansAgg.has(k)) {
      extra++;
      rows.push({ status: 'extra', code: o.r.code, s1: o.r.s1, s2: o.r.s2, unit: o.r.unit, ours: round3(o.qty), answer: 0 });
    }
  }

  // önce sorunlar (missing → qty_diff → extra → match), sonra kod adı
  const order: Record<string, number> = { missing: 0, qty_diff: 1, extra: 2, match: 3 };
  rows.sort((a, b) => order[a.status] - order[b.status] || a.code.localeCompare(b.code) || (b.s1 ?? -1) - (a.s1 ?? -1));

  const totalAns = ansAgg.size;
  return {
    fileName, sheet,
    accuracy: totalAns ? Math.round((matched / totalAns) * 1000) / 10 : 0,
    counts: { matched, qtyDiff, missing, extra },
    rows: rows.slice(0, 200),
    createdAt: new Date().toISOString(),
  };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
