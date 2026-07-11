// Metriq — müşteri cevap Excel'i karşılaştırması ("bu dosyanın doğru cevabı bu").
// Teklif-kritik: burada hiçbir rakam üretilmez/uydurulmaz — yalnız İKİ kaynak ölçülür:
// bizim deterministik motorun satırları ↔ müşterinin cevap dosyası.
import 'server-only';
import ExcelJS from 'exceljs';
import { inflateRawSync } from 'node:zlib';
import type { AnswerDiff, AnswerDiffRow, MtoRow, Unit } from './types';

const MAX_XLSX_ENTRIES = 128;
const MAX_XLSX_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_XLSX_UNCOMPRESSED_BYTES = 16 * 1024 * 1024;
const MAX_XLSX_WORKSHEETS = 12;
const MAX_WORKSHEET_ROWS = 5_000;
const MAX_WORKSHEET_COLUMNS = 64;
const MAX_WORKBOOK_ROWS = 10_000;
const MAX_WORKBOOK_CELLS = 100_000;
const MAX_CELL_TEXT_CHARS = 4_096;
const MAX_WORKBOOK_TEXT_CHARS = 4_000_000;
const EOCD = 0x06054b50;
const CENTRAL_FILE = 0x02014b50;
const LOCAL_FILE = 0x04034b50;

function assertSafeXlsxArchive(buf: Buffer): void {
  if (buf.length < 22 || buf.readUInt16LE(0) !== 0x4b50) {
    throw new Error('Cevap dosyası geçerli bir XLSX/ZIP arşivi değil.');
  }
  let eocd = -1;
  const floor = Math.max(0, buf.length - 65_557);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Cevap dosyasının ZIP dizini okunamadı.');
  const entries = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  const centralEnd = centralOffset + centralSize;
  if (entries === 0 || entries > MAX_XLSX_ENTRIES
    || centralEnd > eocd) {
    throw new Error('Cevap dosyası güvenli XLSX arşiv sınırlarını aşıyor.');
  }
  let pos = centralOffset;
  let total = 0;
  let worksheetEntries = 0;
  for (let i = 0; i < entries; i++) {
    if (pos + 46 > centralEnd || buf.readUInt32LE(pos) !== CENTRAL_FILE) {
      throw new Error('Cevap dosyasının ZIP dizini bozuk.');
    }
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const compressed = buf.readUInt32LE(pos + 20);
    const uncompressed = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const next = pos + 46 + nameLen + extraLen + commentLen;
    if (next > centralEnd) {
      throw new Error('Cevap dosyasının ZIP dizini bozuk.');
    }
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    if (/^xl\/worksheets\/[^/]+\.xml$/i.test(name)) worksheetEntries++;
    if (worksheetEntries > MAX_XLSX_WORKSHEETS) {
      throw new Error('Cevap dosyası çok fazla çalışma sayfası içeriyor.');
    }
    if ((flags & 0x1) !== 0 || compressed === 0xffffffff || uncompressed === 0xffffffff
      || localOffset === 0xffffffff || uncompressed > MAX_XLSX_ENTRY_BYTES
      || (method !== 0 && method !== 8)) {
      throw new Error('Cevap dosyası desteklenmeyen veya aşırı büyük ZIP girdisi içeriyor.');
    }

    // Do not trust the central directory's declared uncompressed size: a ZIP
    // bomb can forge it small and make JSZip/ExcelJS inflate far more data.
    if (localOffset + 30 > centralOffset || buf.readUInt32LE(localOffset) !== LOCAL_FILE) {
      throw new Error('Cevap dosyasının ZIP yerel başlığı bozuk.');
    }
    const localFlags = buf.readUInt16LE(localOffset + 6);
    const localMethod = buf.readUInt16LE(localOffset + 8);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressed;
    if ((localFlags & 0x1) !== 0 || localMethod !== method || dataEnd > centralOffset) {
      throw new Error('Cevap dosyasının ZIP veri sınırları bozuk.');
    }
    const localName = buf.subarray(localOffset + 30, localOffset + 30 + localNameLen).toString('utf8');
    if (localName !== name) throw new Error('Cevap dosyasının ZIP dosya adları uyuşmuyor.');

    let actualSize: number;
    if (method === 0) {
      actualSize = compressed;
    } else {
      try {
        actualSize = inflateRawSync(buf.subarray(dataStart, dataEnd), {
          maxOutputLength: MAX_XLSX_ENTRY_BYTES + 1,
        }).length;
      } catch {
        throw new Error('Cevap dosyası güvenli açılmış ZIP sınırını aşıyor.');
      }
    }
    if (actualSize !== uncompressed || actualSize > MAX_XLSX_ENTRY_BYTES) {
      throw new Error('Cevap dosyasının ZIP boyut beyanı geçersiz.');
    }
    total += actualSize;
    if (total > MAX_XLSX_UNCOMPRESSED_BYTES) {
      throw new Error('Cevap dosyasının açılmış boyutu güvenli sınırı aşıyor.');
    }
    pos = next;
  }
  if (pos !== centralEnd) {
    throw new Error('Cevap dosyasının ZIP dizini bozuk.');
  }
}

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

function assertSafeWorkbookShape(wb: ExcelJS.Workbook): void {
  if (wb.worksheets.length === 0 || wb.worksheets.length > MAX_XLSX_WORKSHEETS) {
    throw new Error('Cevap dosyası güvenli çalışma sayfası sınırını aşıyor.');
  }

  let workbookRows = 0;
  let workbookCells = 0;
  let workbookTextChars = 0;
  for (const ws of wb.worksheets) {
    if (ws.rowCount > MAX_WORKSHEET_ROWS || ws.columnCount > MAX_WORKSHEET_COLUMNS) {
      throw new Error('Cevap dosyası güvenli satır veya kolon sınırını aşıyor.');
    }
    ws.eachRow({ includeEmpty: false }, (row) => {
      workbookRows++;
      if (workbookRows > MAX_WORKBOOK_ROWS) {
        throw new Error('Cevap dosyası toplam satır bütçesini aşıyor.');
      }
      row.eachCell({ includeEmpty: false }, (cell) => {
        workbookCells++;
        if (workbookCells > MAX_WORKBOOK_CELLS) {
          throw new Error('Cevap dosyası hücre bütçesini aşıyor.');
        }
        const text = cellText(cell.value);
        if (text.length > MAX_CELL_TEXT_CHARS) {
          throw new Error('Cevap dosyası aşırı uzun hücre metni içeriyor.');
        }
        workbookTextChars += text.length;
        if (workbookTextChars > MAX_WORKBOOK_TEXT_CHARS) {
          throw new Error('Cevap dosyası metin bütçesini aşıyor.');
        }
      });
    });
  }
}

// Sayfalar içinde en çok başlık eşleştiren satırı bul → kolon haritası
export function parseAnswerXlsx(buf: Buffer): Promise<{ rows: AnswerRow[]; sheet: string }> {
  return (async () => {
    assertSafeXlsxArchive(buf);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    assertSafeWorkbookShape(wb);
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

  // Every unmatched key counts, including rows our engine invented. Using only
  // the answer-set size could report 100% even while exporting extra material.
  const evaluatedKeys = ansAgg.size + extra;
  return {
    fileName, sheet,
    accuracy: evaluatedKeys ? Math.round((matched / evaluatedKeys) * 1000) / 10 : 0,
    counts: { matched, qtyDiff, missing, extra },
    rows: rows.slice(0, 200),
    createdAt: new Date().toISOString(),
  };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
