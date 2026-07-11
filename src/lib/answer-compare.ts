// Metriq — müşteri cevap Excel'i karşılaştırması ("bu dosyanın doğru cevabı bu").
// Teklif-kritik: burada hiçbir rakam üretilmez/uydurulmaz — yalnız İKİ kaynak ölçülür:
// bizim deterministik motorun satırları ↔ müşterinin cevap dosyası.
import 'server-only';
import ExcelJS from 'exceljs';
import { createHash, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { asmeOdToNps, dnToNps } from './pipe-sizes.ts';
import type { AnswerDiff, AnswerDiffRow, AnswerSide, AnswerValue, MtoRow, Unit } from './types';

const MAX_XLSX_ENTRIES = 128;
const MAX_XLSX_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_XLSX_UNCOMPRESSED_BYTES = 16 * 1024 * 1024;
const MAX_XLSX_WORKSHEETS = 24;
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

export interface AnswerRow { code: string; s1: number | null; s2: number; qty: number; unit: Unit }

// Başlık eş anlamlıları — müşteri şablonları TR/EN karışık gelebilir
const HEADERS: Record<string, RegExp> = {
  code: /material\s*code|malzeme\s*kodu|^description\s*\(\s*1\s*\)$|^kalem$|^kod$/i,
  s1in: /size\s*1.*(inch|inç|")|çap\s*1|^size1"?$/i,
  s2in: /size\s*2.*(inch|inç|")|çap\s*2|^size2"?$/i,
  s1mm: /size\s*1.*(?:\(\s*mm\s*\)|\bmm\b)|çap\s*1.*\bmm\b/i,
  s2mm: /size\s*2.*(?:\(\s*mm\s*\)|\bmm\b)|çap\s*2.*\bmm\b/i,
  qty: /^(?:total\s+)?quantity$|^miktar$|adet-?boy|^qty\.?$/i,
  unit: /qty\.?\s*units?|unit\s*of\s*measure|^birim$|^units?$/i,
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
  const t = cellText(c).trim().replace(',', '.').replace(/[″”"]/g, '').trim();
  if (t === '' || t === '?' || /^(?:n\/?a|-+)$/i.test(t)) return null;
  const mixed = t.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const fraction = t.match(/^(\d+)\/(\d+)$/);
  if (fraction) return Number(fraction[1]) / Number(fraction[2]);
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

const HYGIENIC_OD_TO_NPS: Array<[number, number]> = [
  [19, 0.5], [23, 0.75], [29, 1], [35, 1.25], [41, 1.5], [53, 2],
  [70, 2.5], [85, 3], [104, 4], [129, 5], [154, 6], [204, 8], [254, 10],
];

function millimetresToNps(mm: number | null): number | null {
  if (mm == null) return null;
  const dn = dnToNps(Math.round(mm));
  if (dn != null) return dn;
  let closest: [number, number] | null = null;
  for (const candidate of HYGIENIC_OD_TO_NPS) {
    if (!closest || Math.abs(candidate[0] - mm) < Math.abs(closest[0] - mm)) closest = candidate;
  }
  if (closest && Math.abs(closest[0] - mm) <= 1.6) return closest[1];
  return asmeOdToNps(mm);
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
      for (let r = 1; r <= Math.min(ws.rowCount, 20); r++) {
        const row = ws.getRow(r);
        const cols: Record<string, number> = {};
        let score = 0;
        row.eachCell({ includeEmpty: false }, (cell, colNo) => {
          const txt = cellText(cell.value).trim().replace(/\s+/g, ' ');
          for (const [key, re] of Object.entries(HEADERS)) {
            if (re.test(txt) && (cols[key] == null || /^s[12](?:in|mm)$/.test(key))) {
              if (cols[key] == null) score++;
              cols[key] = colNo;
            }
          }
        });
        const rank = score
          + (cols.s1in != null ? 4 : 0)
          + (cols.s1mm != null ? 2 : 0)
          + (cols.unit != null ? 1 : 0)
          + (/^mto$/i.test(ws.name) ? 4 : /pricing/i.test(ws.name) ? 2 : 0);
        if (score >= 2 && cols.code != null && cols.qty != null && (!best || rank > best.score)) {
          best = { sheet: ws.name, headerRow: r, cols, score: rank };
        }
      }
    }
    if (!best) throw new Error('Cevap dosyasında tanınan başlık satırı bulunamadı (Material Code / Quantity / Size 1 beklenir).');

    const ws = wb.getWorksheet(best.sheet)!;
    const rows: AnswerRow[] = [];
    for (let r = best.headerRow + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const code = cellText(row.getCell(best.cols.code).value).trim().toUpperCase().replace(/\s+/g, ' ');
      if (!code || /^toplam|^total/i.test(code)) continue;
      const qty = cellNum(row.getCell(best.cols.qty).value);
      if (qty == null || qty <= 0) continue;
      const s1In = best.cols.s1in != null ? cellNum(row.getCell(best.cols.s1in).value) : null;
      const s2In = best.cols.s2in != null ? cellNum(row.getCell(best.cols.s2in).value) : null;
      const s1Mm = best.cols.s1mm != null ? cellNum(row.getCell(best.cols.s1mm).value) : null;
      const s2Mm = best.cols.s2mm != null ? cellNum(row.getCell(best.cols.s2mm).value) : null;
      const s1 = s1In ?? millimetresToNps(s1Mm);
      const s2 = s2In ?? millimetresToNps(s2Mm) ?? 0;
      const unitRaw = best.cols.unit != null ? cellText(row.getCell(best.cols.unit).value).trim().toUpperCase() : '';
      const unit: Unit = /^(?:M|MT|MTR|METRE|METRES|LM)$/.test(unitRaw) || (!unitRaw && code === 'PIPE') ? 'M' : 'EA';
      rows.push({ code, s1, s2, qty, unit });
    }
    return { rows, sheet: best.sheet };
  })();
}

const MAX_COMPARISON_ITEMS = 1_000;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const normCode = (code: string) => code.trim().toUpperCase().replace(/\s+/g, ' ');
const normSize = (size: number | null) => size == null ? '?' : String(Math.round(size * 1000) / 1000);
const valueKey = (r: Pick<AnswerValue, 'code' | 's1' | 's2' | 'unit'>) =>
  `${normCode(r.code)}|${normSize(r.s1)}|${normSize(r.s2)}|${r.unit}`;

interface OursAggregate {
  value: AnswerValue;
  rowIds: string[];
  lines: Set<string>;
  subs: Set<string>;
}

interface AnswerAggregate { value: AnswerValue }

function qtyMatches(a: AnswerValue, b: AnswerValue): boolean {
  const tolerance = b.unit === 'M' ? Math.max(0.1, Math.abs(b.qty) * 0.02) : 0.001;
  return Math.abs(a.qty - b.qty) <= tolerance;
}

function sameSizes(a: AnswerValue, b: AnswerValue): boolean {
  return a.s1 === b.s1 && Math.abs(a.s2 - b.s2) <= 0.001;
}

function logicalPairKind(ours: AnswerValue, answer: AnswerValue): 'size' | 'code' | null {
  if (ours.unit !== answer.unit || !qtyMatches(ours, answer)) return null;
  const codeSame = normCode(ours.code) === normCode(answer.code);
  const sizesEqual = sameSizes(ours, answer);
  if (codeSame && !sizesEqual) return 'size';
  if (!codeSame && sizesEqual) return 'code';
  return null;
}

function side(aggregate: OursAggregate | AnswerAggregate | undefined): AnswerSide | null {
  if (!aggregate) return null;
  if ('rowIds' in aggregate) {
    return {
      value: { ...aggregate.value, qty: round3(aggregate.value.qty) },
      rowIds: [...aggregate.rowIds],
      lines: [...aggregate.lines].sort(),
      subs: [...aggregate.subs].sort(),
    };
  }
  return { value: { ...aggregate.value, qty: round3(aggregate.value.qty) }, rowIds: [] };
}

function diffId(status: string, oursKey: string | null, answerKey: string | null): string {
  return `d-${createHash('sha256').update(`${status}\0${oursKey ?? ''}\0${answerKey ?? ''}`).digest('hex').slice(0, 24)}`;
}

function makeDiffRow(
  status: AnswerDiffRow['status'],
  kind: AnswerDiffRow['kind'],
  ours: OursAggregate | undefined,
  answer: AnswerAggregate | undefined,
  oursKey: string | null,
  answerKey: string | null,
): AnswerDiffRow {
  const display = answer?.value ?? ours!.value;
  return {
    id: diffId(status, oursKey, answerKey),
    status,
    kind,
    code: display.code,
    s1: display.s1,
    s2: display.s2,
    unit: display.unit,
    ours: round3(ours?.value.qty ?? 0),
    answer: round3(answer?.value.qty ?? 0),
    oursSide: side(ours),
    answerSide: side(answer),
  };
}

export function hashMtoRows(rows: MtoRow[]): string {
  const canonical = rows.map(row => ({
    id: row.id, line: row.line, code: row.code, sub: row.sub, s1: row.s1, s2: row.s2,
    qty: round3(row.qty), unit: row.unit, remark: row.remark, scope: row.scope,
  })).sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

// Exact anahtarları ölç; kalan missing+extra çiftlerini yalnız benzersiz ve
// miktarı aynıysa tek mantıksal çap/kod farkına dönüştür.
export function compareAnswer(
  ours: MtoRow[],
  answer: AnswerRow[],
  fileName: string,
  sheet: string,
  options: { comparisonId?: string; baseRowsRevision?: number } = {},
): AnswerDiff {
  const oursAgg = new Map<string, OursAggregate>();
  for (const row of ours.filter(value => value.scope === 'MAIN')) {
    const key = valueKey(row);
    const existing = oursAgg.get(key);
    if (existing) {
      existing.value.qty += row.qty;
      existing.rowIds.push(row.id);
      existing.lines.add(row.line);
      existing.subs.add(row.sub);
    } else {
      oursAgg.set(key, {
        value: { code: normCode(row.code), s1: row.s1, s2: row.s2, qty: row.qty, unit: row.unit },
        rowIds: [row.id], lines: new Set([row.line]), subs: new Set([row.sub]),
      });
    }
  }
  const answerAgg = new Map<string, AnswerAggregate>();
  for (const row of answer) {
    const key = valueKey(row);
    const existing = answerAgg.get(key);
    if (existing) existing.value.qty += row.qty;
    else answerAgg.set(key, { value: { ...row, code: normCode(row.code) } });
  }

  const rows: AnswerDiffRow[] = [];
  const exactKeys = new Set<string>();
  let matched = 0, qtyDiff = 0, fieldDiff = 0, missing = 0, extra = 0;

  for (const [key, expected] of answerAgg) {
    const actual = oursAgg.get(key);
    if (!actual) continue;
    exactKeys.add(key);
    if (qtyMatches(actual.value, expected.value)) {
      matched++;
      rows.push(makeDiffRow('match', 'quantity', actual, expected, key, key));
    } else {
      qtyDiff++;
      rows.push(makeDiffRow('qty_diff', 'quantity', actual, expected, key, key));
    }
  }

  const unmatchedOurs = [...oursAgg].filter(([key]) => !exactKeys.has(key));
  const unmatchedAnswers = [...answerAgg].filter(([key]) => !exactKeys.has(key));
  const answerCandidates = new Map<string, Array<{ oursKey: string; kind: 'size' | 'code' }>>();
  const oursCandidates = new Map<string, string[]>();
  for (const [answerKey, expected] of unmatchedAnswers) {
    for (const [oursKey, actual] of unmatchedOurs) {
      const kind = logicalPairKind(actual.value, expected.value);
      if (!kind) continue;
      const list = answerCandidates.get(answerKey) ?? [];
      list.push({ oursKey, kind });
      answerCandidates.set(answerKey, list);
      const reverse = oursCandidates.get(oursKey) ?? [];
      reverse.push(answerKey);
      oursCandidates.set(oursKey, reverse);
    }
  }

  const pairedOurs = new Set<string>();
  const pairedAnswers = new Set<string>();
  for (const [answerKey, candidates] of answerCandidates) {
    if (candidates.length !== 1) continue;
    const candidate = candidates[0];
    if ((oursCandidates.get(candidate.oursKey)?.length ?? 0) !== 1) continue;
    const actual = oursAgg.get(candidate.oursKey)!;
    const expected = answerAgg.get(answerKey)!;
    pairedOurs.add(candidate.oursKey);
    pairedAnswers.add(answerKey);
    fieldDiff++;
    rows.push(makeDiffRow('field_diff', candidate.kind, actual, expected, candidate.oursKey, answerKey));
  }

  for (const [key, expected] of unmatchedAnswers) {
    if (pairedAnswers.has(key)) continue;
    missing++;
    rows.push(makeDiffRow('missing', 'missing', undefined, expected, null, key));
  }
  for (const [key, actual] of unmatchedOurs) {
    if (pairedOurs.has(key)) continue;
    extra++;
    rows.push(makeDiffRow('extra', 'extra', actual, undefined, key, null));
  }

  if (rows.length > MAX_COMPARISON_ITEMS) {
    throw new Error('Cevap dosyası karşılaştırma için çok fazla benzersiz kalem içeriyor.');
  }
  const order: Record<AnswerDiffRow['status'], number> = { field_diff: 0, qty_diff: 1, missing: 2, extra: 3, match: 4 };
  rows.sort((a, b) => order[a.status] - order[b.status]
    || a.code.localeCompare(b.code) || (b.s1 ?? -1) - (a.s1 ?? -1) || (a.id ?? '').localeCompare(b.id ?? ''));

  return {
    id: options.comparisonId ?? randomUUID(),
    baseRowsHash: hashMtoRows(ours),
    baseRowsRevision: options.baseRowsRevision ?? 0,
    fileName,
    sheet,
    accuracy: rows.length ? Math.round((matched / rows.length) * 1000) / 10 : 0,
    targetAccuracy: 90,
    counts: { matched, qtyDiff, fieldDiff, missing, extra },
    rows,
    createdAt: new Date().toISOString(),
  };
}
