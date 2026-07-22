// Metriq — müşteri cevap Excel'i karşılaştırması ("bu dosyanın doğru cevabı bu").
// Teklif-kritik: burada hiçbir rakam üretilmez/uydurulmaz — yalnız İKİ kaynak ölçülür:
// bizim deterministik motorun satırları ↔ müşterinin cevap dosyası.
import 'server-only';
import ExcelJS from 'exceljs';
import * as SheetJS from '@e965/xlsx';
import { createHash, randomUUID } from 'node:crypto';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { asmeOdToNps, dnToNps } from './pipe-sizes.ts';
import type { AnswerDiff, AnswerDiffRow, AnswerSide, AnswerValue, MtoRow, Unit } from './types';

const MAX_XLSX_ENTRIES = 128;
const MAX_ANSWER_FILE_BYTES = 4 * 1024 * 1024;
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
const CFB_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function assertSafeXlsxArchive(buf: Buffer): void {
  if (buf.length <= 0 || buf.length > MAX_ANSWER_FILE_BYTES) {
    throw new Error('Cevap dosyası 4 MB güvenli boyut sınırını aşıyor.');
  }
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

function isLegacyXls(buf: Buffer): boolean {
  return buf.length >= CFB_SIGNATURE.length && buf.subarray(0, CFB_SIGNATURE.length).equals(CFB_SIGNATURE);
}

// BIFF8 .xls dosyaları ZIP değildir; CFB (Compound File Binary) sektörlerinden
// oluşur. SheetJS'e vermeden önce boyutu, başlığı ve sektör sayaçlarını sınırla.
// Makro/formül çalıştırılmaz; yalnız önceden hesaplanmış hücre değerleri okunur.
function assertSafeLegacyXls(buf: Buffer): void {
  if (buf.length <= 0 || buf.length > MAX_ANSWER_FILE_BYTES) {
    throw new Error('Cevap dosyası 4 MB güvenli boyut sınırını aşıyor.');
  }
  if (buf.length < 512 || !isLegacyXls(buf)) {
    throw new Error('Cevap dosyası geçerli bir XLS/CFB arşivi değil.');
  }
  const major = buf.readUInt16LE(0x1a);
  const byteOrder = buf.readUInt16LE(0x1c);
  const sectorShift = buf.readUInt16LE(0x1e);
  const miniSectorShift = buf.readUInt16LE(0x20);
  const sectorSize = 2 ** sectorShift;
  if (byteOrder !== 0xfffe || miniSectorShift !== 6
    || !((major === 3 && sectorShift === 9) || (major === 4 && sectorShift === 12))) {
    throw new Error('Cevap dosyası desteklenmeyen XLS/CFB başlığı içeriyor.');
  }
  const payloadStart = major === 4 ? sectorSize : 512;
  if (buf.length < payloadStart || (buf.length - payloadStart) % sectorSize !== 0) {
    throw new Error('Cevap dosyasının XLS/CFB sektör sınırları bozuk.');
  }
  const sectorCount = (buf.length - payloadStart) / sectorSize;
  const directorySectors = buf.readUInt32LE(0x28);
  const fatSectors = buf.readUInt32LE(0x2c);
  const miniFatSectors = buf.readUInt32LE(0x40);
  const difatSectors = buf.readUInt32LE(0x48);
  if (sectorCount <= 0 || fatSectors > sectorCount || directorySectors > sectorCount
    || miniFatSectors > sectorCount || difatSectors > sectorCount
    || fatSectors + directorySectors + miniFatSectors + difatSectors > sectorCount * 2) {
    throw new Error('Cevap dosyası güvenli XLS/CFB sektör bütçesini aşıyor.');
  }
}

// Hücre verisi İÇİN GEREKMEYEN her parça (vbaProject, drawing, externalLink,
// metadata, webextension, 692KB'lık definedNames yığını…) exceljs'i Vercel
// çalışma zamanında YAKALANAMAZ biçimde çökertebilir (gerçek bir büyük .xlsm —
// süreç ölür, catch çalışamaz, HTML 500). Çözüm ALLOWLIST: yalnız değer-taşıyan
// parçalar tutulur, workbook/sheet/rels XML'leri düşürülen parçalara işaret eden
// elemanlardan arındırılır. Veri bayt-kopya taşınır (dönüşen XML'ler hariç).
const KEEP_XLSX_PART = /^(?:\[Content_Types\]\.xml|_rels\/\.rels|docProps\/(?:core|app)\.xml|xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|worksheets\/[^/]+\.xml|sharedStrings\.xml|styles\.xml|theme\/[^/]+\.xml))$/i;

// sayfa XML'i: düşürülen parça referansları + değer-dışı bloklar
function cleanSheetXml(xml: string): string {
  return xml
    .replace(/<drawing\b[^>]*\/>/gi, '')
    .replace(/<legacyDrawing(?:HF)?\b[^>]*\/>/gi, '')
    .replace(/<picture\b[^>]*\/>/gi, '')
    .replace(/<oleObjects\b[\s\S]*?<\/oleObjects>|<oleObjects\b[^>]*\/>/gi, '')
    .replace(/<controls\b[\s\S]*?<\/controls>|<controls\b[^>]*\/>/gi, '')
    .replace(/<tableParts\b[\s\S]*?<\/tableParts>|<tableParts\b[^>]*\/>/gi, '')
    .replace(/<hyperlinks\b[\s\S]*?<\/hyperlinks>|<hyperlinks\b[^>]*\/>/gi, '')
    .replace(/<extLst\b[\s\S]*?<\/extLst>/gi, '');
}

// workbook.xml: dış referanslar, definedNames yığını, pivot önbelleği vb. atılır
function cleanWorkbookXml(xml: string): string {
  return xml
    .replace(/<externalReferences\b[\s\S]*?<\/externalReferences>|<externalReferences\b[^>]*\/>/gi, '')
    .replace(/<definedNames\b[\s\S]*?<\/definedNames>|<definedNames\b[^>]*\/>/gi, '')
    .replace(/<pivotCaches\b[\s\S]*?<\/pivotCaches>|<pivotCaches\b[^>]*\/>/gi, '')
    .replace(/<customWorkbookViews\b[\s\S]*?<\/customWorkbookViews>/gi, '')
    .replace(/<extLst\b[\s\S]*?<\/extLst>/gi, '');
}

// workbook.xml.rels: yalnız tutulan parçalara giden ilişkiler kalır
function cleanWorkbookRels(xml: string): string {
  return xml.replace(/<Relationship\b[^>]*\/>/gi, m =>
    /Target="(?:worksheets\/[^"]+|sharedStrings\.xml|styles\.xml|theme\/[^"]+)"/i.test(m) ? m : '');
}

export function stripRiskyXlsxParts(buf: Buffer): Buffer {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 65_557);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Cevap dosyasının ZIP dizini okunamadı.');
  const entries = buf.readUInt16LE(eocd + 10);
  const centralOffset = buf.readUInt32LE(eocd + 16);

  type Kept = { name: Buffer; method: number; time: number; date: number; crc: number; compressed: number; uncompressed: number; data: Buffer };
  const kept: Kept[] = [];
  let pos = centralOffset;
  for (let i = 0; i < entries; i++) {
    const method = buf.readUInt16LE(pos + 10);
    const time = buf.readUInt16LE(pos + 12);
    const date = buf.readUInt16LE(pos + 14);
    const crc = buf.readUInt32LE(pos + 16);
    const compressed = buf.readUInt32LE(pos + 20);
    const uncompressed = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen);
    pos += 46 + nameLen + extraLen + commentLen;
    const nameStr = name.toString('utf8');
    if (!KEEP_XLSX_PART.test(nameStr)) continue;
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const entry: Kept = { name: Buffer.from(name), method, time, date, crc, compressed, uncompressed, data: buf.subarray(dataStart, dataStart + compressed) };
    const transform =
      /^xl\/worksheets\/[^/]+\.xml$/i.test(nameStr) ? cleanSheetXml
        : /^xl\/workbook\.xml$/i.test(nameStr) ? cleanWorkbookXml
          : /^xl\/_rels\/workbook\.xml\.rels$/i.test(nameStr) ? cleanWorkbookRels
            : null;
    if (transform) {
      const xml = (method === 0 ? entry.data : inflateRawSync(entry.data, { maxOutputLength: MAX_XLSX_ENTRY_BYTES + 1 })).toString('utf8');
      const cleaned = transform(xml);
      if (cleaned !== xml) {
        const raw = Buffer.from(cleaned, 'utf8');
        entry.data = deflateRawSync(raw);
        entry.method = 8;
        entry.compressed = entry.data.length;
        entry.uncompressed = raw.length;
        entry.crc = crc32(raw) >>> 0;
      }
    }
    kept.push(entry);
  }

  const chunks: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of kept) {
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(LOCAL_FILE, 0);
    lh.writeUInt16LE(20, 4);            // version needed
    lh.writeUInt16LE(0, 6);             // flags: descriptor yok, isimler ASCII
    lh.writeUInt16LE(e.method, 8);
    lh.writeUInt16LE(e.time, 10); lh.writeUInt16LE(e.date, 12);
    lh.writeUInt32LE(e.crc, 14);
    lh.writeUInt32LE(e.compressed, 18); lh.writeUInt32LE(e.uncompressed, 22);
    lh.writeUInt16LE(e.name.length, 26); lh.writeUInt16LE(0, 28);
    chunks.push(lh, e.name, e.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(CENTRAL_FILE, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(e.method, 10);
    ch.writeUInt16LE(e.time, 12); ch.writeUInt16LE(e.date, 14);
    ch.writeUInt32LE(e.crc, 16);
    ch.writeUInt32LE(e.compressed, 20); ch.writeUInt32LE(e.uncompressed, 24);
    ch.writeUInt16LE(e.name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, e.name);
    offset += 30 + e.name.length + e.data.length;
  }
  const centralStart = offset;
  let centralSize = 0;
  for (const c of centrals) centralSize += c.length;
  const eo = Buffer.alloc(22);
  eo.writeUInt32LE(EOCD, 0);
  eo.writeUInt16LE(kept.length, 8); eo.writeUInt16LE(kept.length, 10);
  eo.writeUInt32LE(centralSize, 12); eo.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...chunks, ...centrals, eo]);
}

export interface AnswerRow {
  code: string; s1: number | null; s2: number; qty: number; unit: Unit;
  /**
   * Model-dışı satır: şablonda çizim-referans kolonu (GA/DWG/ISO) varken referansı
   * boş ya da RFI/FUTURE olan kalemler. Bunlar modelden ÖLÇÜLEMEZ (saha payı,
   * RFI ekleri) — karşılaştırmaya sokulursa skoru haksız düşürür. Gerçek vaka
   * GR-166: 170,7m boru + conta/flanş ekleri; ayrıştırılınca 10″ birebir çıktı.
   */
  external?: boolean;
}

export interface QuantityWeightedOverlap {
  percent: number;
  intersection: number;
  union: number;
  oursTotal: number;
  answerTotal: number;
}

export interface AnswerComparisonMetrics {
  // Exact code+size+unit+quantity item metrics. `accuracy` remains untouched for
  // backward compatibility; these make false-positive/false-negative behavior explicit.
  precision: number;
  recall: number;
  f1: number;
  quantityWeightedOverlap: QuantityWeightedOverlap;
  quantityWeightedOverlapByUnit: Record<Unit, QuantityWeightedOverlap>;
}

export type AnswerDiffWithMetrics = AnswerDiff & { metrics: AnswerComparisonMetrics };

type HeaderKey = 'code' | 'description' | 'dn' | 's1in' | 's2in' | 's1mm' | 's2mm' | 'qty' | 'unit' | 'ref';
type HeaderColumns = Partial<Record<HeaderKey, number>>;

interface AnswerSheetView {
  name: string;
  state: 'visible' | 'hidden' | 'veryHidden';
  rowCount: number;
  columnCount: number;
  valueAt(row: number, column: number): unknown;
}

interface HeaderBlock {
  sheet: AnswerSheetView;
  kind: 'standard' | 'bom-breakdown';
  headerRow: number;
  startCol: number;
  endCol: number;
  cols: HeaderColumns;
  score: number;
}

// Başlık eş anlamlıları — müşteri şablonları TR/EN karışık gelebilir.
// `description` yalnız genel BOM adapterının semantik ankrajıdır; normal cevap
// şablonundaki Description (1) açıkça `code` olarak kalır.
const HEADERS: Record<HeaderKey, RegExp> = {
  code: /material\s*code|malzeme\s*kodu|^description\s*\(\s*1\s*\)$|^kalem$|^kod$/i,
  description: /^(?:item\s+|component\s+)?description$/i,
  dn: /^(?:dn|nominal\s+(?:diameter|size))(?:\s*\(\s*mm\s*\))?$/i,
  s1in: /size\s*1.*(inch|inç|")|çap\s*1|^size1"?$/i,
  s2in: /size\s*2.*(inch|inç|")|çap\s*2|^size2"?$/i,
  s1mm: /size\s*1.*(?:\(\s*mm\s*\)|\bmm\b)|çap\s*1.*\bmm\b/i,
  s2mm: /size\s*2.*(?:\(\s*mm\s*\)|\bmm\b)|çap\s*2.*\bmm\b/i,
  qty: /^(?:total\s+)?quantity$|^miktar$|adet-?boy|^qty\.?$/i,
  unit: /qty\.?\s*units?|unit\s*of\s*measure|^birim$|^units?$/i,
  // çizim referans kolonu: satırı modele bağlayan kimlik (Grissan'da "GA")
  ref: /^ga$|^dwg(?:\s*no\.?)?$|^drawing(?:\s*(?:no\.?|ref))?$|^iso(?:metric)?(?:\s*no\.?)?$|^izo(?:metri)?(?:\s*no\.?)?$|^çizim(?:\s*no)?$/i,
};

function cellText(c: unknown): string {
  if (c == null) return '';
  if (typeof c === 'object' && 'richText' in (c as object)) {
    return ((c as { richText: { text: string }[] }).richText || []).map(t => t.text).join('');
  }
  if (typeof c === 'object' && 'result' in (c as object)) return String((c as { result: unknown }).result ?? '');
  if (typeof c === 'object' && 'text' in (c as object)) return String((c as { text: unknown }).text ?? '');
  return String(c);
}

function cellNum(c: unknown): number | null {
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

function assertSafeWorkbookShape(sheets: AnswerSheetView[]): void {
  if (sheets.length === 0 || sheets.length > MAX_XLSX_WORKSHEETS) {
    throw new Error('Cevap dosyası güvenli çalışma sayfası sınırını aşıyor.');
  }
  let workbookRows = 0;
  let workbookCells = 0;
  let workbookTextChars = 0;
  for (const sheet of sheets) {
    if (sheet.rowCount > MAX_WORKSHEET_ROWS || sheet.columnCount > MAX_WORKSHEET_COLUMNS) {
      throw new Error('Cevap dosyası güvenli satır veya kolon sınırını aşıyor.');
    }
    for (let row = 1; row <= sheet.rowCount; row++) {
      let rowUsed = false;
      for (let column = 1; column <= sheet.columnCount; column++) {
        const value = sheet.valueAt(row, column);
        if (value == null || value === '') continue;
        rowUsed = true;
        workbookCells++;
        if (workbookCells > MAX_WORKBOOK_CELLS) {
          throw new Error('Cevap dosyası hücre bütçesini aşıyor.');
        }
        const text = cellText(value);
        if (text.length > MAX_CELL_TEXT_CHARS) {
          throw new Error('Cevap dosyası aşırı uzun hücre metni içeriyor.');
        }
        workbookTextChars += text.length;
        if (workbookTextChars > MAX_WORKBOOK_TEXT_CHARS) {
          throw new Error('Cevap dosyası metin bütçesini aşıyor.');
        }
      }
      if (rowUsed && ++workbookRows > MAX_WORKBOOK_ROWS) {
        throw new Error('Cevap dosyası toplam satır bütçesini aşıyor.');
      }
    }
  }
}

async function loadOpenXmlSheets(buf: Buffer): Promise<AnswerSheetView[]> {
  assertSafeXlsxArchive(buf);
  // Parse öncesi makro/gömülü parçaları at — ExcelJS bunlara hiç dokunmasın.
  const clean = stripRiskyXlsxParts(buf);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(clean as unknown as ArrayBuffer);
  return workbook.worksheets.map(sheet => ({
    name: sheet.name,
    state: sheet.state,
    rowCount: sheet.rowCount,
    columnCount: sheet.columnCount,
    valueAt: (row, column) => sheet.getRow(row).getCell(column).value,
  }));
}

function loadLegacySheets(buf: Buffer): AnswerSheetView[] {
  assertSafeLegacyXls(buf);
  let workbook: SheetJS.WorkBook;
  try {
    workbook = SheetJS.read(buf, {
      type: 'buffer', dense: false, sheetRows: MAX_WORKSHEET_ROWS + 1,
      cellFormula: false, cellHTML: false, cellStyles: false,
      bookVBA: false, bookDeps: false, bookFiles: false, WTF: false,
    });
  } catch {
    throw new Error('Cevap dosyası güvenli biçimde okunabilen bir XLS çalışma kitabı değil.');
  }
  const metadata = (workbook as unknown as { Workbook?: { Sheets?: Array<{ Hidden?: number }> } }).Workbook?.Sheets ?? [];
  return workbook.SheetNames.map((name, index) => {
    const worksheet = workbook.Sheets[name];
    let range: SheetJS.Range = { s: { r: 0, c: 0 }, e: { r: -1, c: -1 } };
    try {
      if (worksheet?.['!ref']) range = SheetJS.utils.decode_range(worksheet['!ref']);
    } catch {
      throw new Error('Cevap dosyasının XLS çalışma sayfası aralığı bozuk.');
    }
    const hidden = metadata[index]?.Hidden ?? 0;
    return {
      name,
      state: hidden === 2 ? 'veryHidden' : hidden === 1 ? 'hidden' : 'visible',
      rowCount: range.e.r >= 0 ? range.e.r + 1 : 0,
      columnCount: range.e.c >= 0 ? range.e.c + 1 : 0,
      valueAt: (row: number, column: number) => {
        const cell = worksheet?.[SheetJS.utils.encode_cell({ r: row - 1, c: column - 1 })] as SheetJS.CellObject | undefined;
        return cell?.v;
      },
    };
  });
}

function headerKeys(text: string): HeaderKey[] {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (!normalized) return [];
  return (Object.entries(HEADERS) as Array<[HeaderKey, RegExp]>)
    .filter(([, pattern]) => pattern.test(normalized)).map(([key]) => key);
}

function findHeaderBlocks(sheet: AnswerSheetView): HeaderBlock[] {
  const blocks: HeaderBlock[] = [];
  for (let row = 1; row <= sheet.rowCount; row++) {
    const matches: Array<{ column: number; keys: HeaderKey[] }> = [];
    for (let column = 1; column <= sheet.columnCount; column++) {
      const keys = headerKeys(cellText(sheet.valueAt(row, column)));
      if (keys.length) matches.push({ column, keys });
    }
    const codeAnchors = matches.filter(match => match.keys.includes('code'));
    const anchors = codeAnchors.length ? codeAnchors : matches.filter(match => match.keys.includes('description'));
    for (let index = 0; index < anchors.length; index++) {
      const anchor = anchors[index];
      const kind: HeaderBlock['kind'] = anchor.keys.includes('code') ? 'standard' : 'bom-breakdown';
      const nextAnchor = anchors[index + 1]?.column;
      const scanStart = kind === 'bom-breakdown' ? Math.max(1, anchor.column - 8) : anchor.column;
      const endCol = Math.min(sheet.columnCount, nextAnchor ? nextAnchor - 1 : anchor.column + 31);
      const cols: HeaderColumns = kind === 'standard' ? { code: anchor.column } : { description: anchor.column };
      for (const match of matches) {
        if (match.column < scanStart || match.column > endCol) continue;
        for (const key of match.keys) {
          const preferLast = /^s[12](?:in|mm)$/.test(key);
          if (cols[key] == null || preferLast) cols[key] = match.column;
        }
      }
      // Çizim-referans (GA/DWG) kolonu tipik olarak kod ankrajının SOLUNDA durur
      // (Grissan: "GA" 3. kolon, "Material Code" 4.). Yalnız ref için, önceki
      // ankrajı aşmayan dar bir sol pencere taranır — diğer başlıklar etkilenmez.
      if (cols.ref == null) {
        const prevAnchor = anchors[index - 1]?.column ?? 0;
        const leftStart = Math.max(1, prevAnchor + 1, anchor.column - 6);
        for (const match of matches) {
          if (match.column >= leftStart && match.column < anchor.column && match.keys.includes('ref')) {
            cols.ref = match.column;
          }
        }
      }
      if (cols.qty == null) continue;
      if (kind === 'bom-breakdown' && cols.dn == null && cols.s1mm == null && cols.s1in == null) continue;
      const score = Object.keys(cols).length
        + (cols.s1in != null ? 4 : 0) + (cols.s1mm != null || cols.dn != null ? 2 : 0)
        + (cols.unit != null ? 1 : 0) + (kind === 'standard' ? 2 : 0);
      blocks.push({ sheet, kind, headerRow: row, startCol: anchor.column, endCol, cols, score });
    }
  }
  return blocks;
}

function standardUnit(code: string, raw: unknown): Unit {
  const unit = cellText(raw).trim().toUpperCase();
  return /^(?:M|MT|MTR|METRE|METRES|LM)$/.test(unit) || (!unit && code === 'PIPE') ? 'M' : 'EA';
}

function mapBomDescription(description: string): { code: string; unit: Unit } | null {
  const value = description.trim().toUpperCase().replace(/\s+/g, ' ');
  if (/^PIPE\b/.test(value)) return { code: 'PIPE', unit: 'M' };
  if (/^(?:BEND|ELBOW)\b/.test(value)) {
    return { code: /(?:-45-|45\s*(?:DEG|°)?|\b45\b)/.test(value) ? '45 BEND' : '90 BEND', unit: 'EA' };
  }
  if (/WELDING NECK BORDER|LAPPED FLANGE/.test(value)) return { code: 'COLLAR', unit: 'EA' };
  if (/^FLANGE\b/.test(value) && (/(?:BLIND|DIN\s*2527)/.test(value))) return { code: 'BLIND FLANGE', unit: 'EA' };
  if (/^FLANGE\b/.test(value)) return { code: 'FLANGE', unit: 'EA' };
  if (/^GASKET\b/.test(value)) return { code: 'GASKET', unit: 'EA' };
  if (/^BOLT\s*SET\b/.test(value)) return { code: 'BOLT SET', unit: 'EA' };
  if (/REDUCER|^RED\b/.test(value)) return { code: 'CON RED', unit: 'EA' };
  if (/^(?:TEE|T-PIECE)\b/.test(value)) {
    return { code: /\bRED(?:\.|\b)/.test(value) ? 'RED TEE' : 'EQ TEE', unit: 'EA' };
  }
  if (/VALVE|VLV|BALL COCK|\bCOCK\b/.test(value)) return { code: 'VALVE', unit: 'EA' };
  if (/\bCAP\b/.test(value)) return { code: 'CAP', unit: 'EA' };
  return null;
}

function blockEndRow(block: HeaderBlock, blocks: HeaderBlock[]): number {
  const next = blocks.find(candidate => candidate.headerRow > block.headerRow
    && candidate.kind === block.kind && Math.abs(candidate.startCol - block.startCol) <= 1);
  return next ? next.headerRow - 1 : block.sheet.rowCount;
}

function parseBlock(block: HeaderBlock, blocks: HeaderBlock[]): AnswerRow[] {
  const rows: AnswerRow[] = [];
  const { sheet, cols } = block;
  for (let row = block.headerRow + 1; row <= blockEndRow(block, blocks); row++) {
    let qtyRaw = cellNum(sheet.valueAt(row, cols.qty!));
    // Bazı BIFF raporlarında başlık ve veri farklı birleşik hücre genişlikleri
    // kullanır (örn. Quantity başlığı AA'da, değer Z'de). Yalnız BOM adapterında
    // en yakın komşu sayısal hücreye sınırlı bir geri dönüş yap.
    if (qtyRaw == null && block.kind === 'bom-breakdown') {
      for (const offset of [-1, 1, -2, 2]) {
        const column = cols.qty! + offset;
        if (column < 1 || column > sheet.columnCount) continue;
        const candidate = cellNum(sheet.valueAt(row, column));
        if (candidate != null) { qtyRaw = candidate; break; }
      }
    }
    if (qtyRaw == null || qtyRaw <= 0 || qtyRaw > 1_000_000_000) continue;
    if (block.kind === 'bom-breakdown') {
      const mapped = mapBomDescription(cellText(sheet.valueAt(row, cols.description!)));
      if (!mapped) continue;
      const diameter = cellNum(sheet.valueAt(row, cols.dn ?? cols.s1mm ?? cols.s1in!));
      const s1 = cols.s1in != null && cols.dn == null
        ? diameter : millimetresToNps(diameter);
      rows.push({ code: mapped.code, s1, s2: 0, qty: mapped.unit === 'M' ? qtyRaw / 1000 : qtyRaw, unit: mapped.unit });
      continue;
    }
    const code = cellText(sheet.valueAt(row, cols.code!)).trim().toUpperCase().replace(/\s+/g, ' ');
    if (!code || code.length > 160 || /^(?:TOPLAM|TOTAL)\b/i.test(code)) continue;
    const s1In = cols.s1in != null ? cellNum(sheet.valueAt(row, cols.s1in)) : null;
    const s2In = cols.s2in != null ? cellNum(sheet.valueAt(row, cols.s2in)) : null;
    const s1Mm = cols.s1mm != null ? cellNum(sheet.valueAt(row, cols.s1mm)) : null;
    const s2Mm = cols.s2mm != null ? cellNum(sheet.valueAt(row, cols.s2mm)) : null;
    // Referans kolonu VARSA: boş referans ya da RFI/FUTURE = modele bağlanamayan
    // insan eki. Kolon hiç yoksa hiçbir satır işaretlenmez (tam geriye uyum).
    let external: boolean | undefined;
    if (cols.ref != null) {
      const refText = cellText(sheet.valueAt(row, cols.ref)).trim();
      if (!refText || /\b(?:RFI|FUTURE|ALLOWANCE|SITE\s*RUN)\b/i.test(refText)) external = true;
    }
    rows.push({
      code,
      s1: s1In ?? millimetresToNps(s1Mm),
      s2: s2In ?? millimetresToNps(s2Mm) ?? 0,
      qty: qtyRaw,
      unit: standardUnit(code, cols.unit != null ? sheet.valueAt(row, cols.unit) : null),
      ...(external ? { external } : {}),
    });
  }
  return rows;
}

function sheetPreference(sheet: AnswerSheetView): number {
  const name = sheet.name.trim();
  const semantic = /^mto(?:\b|_)/i.test(name) ? 300
    : /pricing|metraj|take.?off|bill\s+of\s+material|\bbom\b/i.test(name) ? 220
      : /master(?:\b|_)/i.test(name) ? 80 : 0;
  return semantic + (sheet.state === 'visible' ? 0 : -500);
}

// Adı geriye uyum için korunuyor; içerik imzasından hem güvenli OOXML
// (.xlsx/.xlsm) hem legacy BIFF8 (.xls) algılar. Bir sayfadaki yatay/dikey MTO
// bloklarını birlikte okur, sonra özet/çıktı sayfasını veri kalitesiyle seçer.
export async function parseAnswerXlsx(buf: Buffer): Promise<{ rows: AnswerRow[]; sheet: string }> {
  const sheets = isLegacyXls(buf) ? loadLegacySheets(buf) : await loadOpenXmlSheets(buf);
  assertSafeWorkbookShape(sheets);
  const candidates: Array<{ sheet: AnswerSheetView; rows: AnswerRow[]; score: number }> = [];
  for (const sheet of sheets) {
    const blocks = findHeaderBlocks(sheet);
    if (!blocks.length) continue;
    const rows = blocks.flatMap(block => parseBlock(block, blocks));
    if (!rows.length) continue;
    const unique = new Set(rows.map(row => `${row.code}|${row.s1 ?? '?'}|${row.s2}|${row.unit}`)).size;
    const score = sheetPreference(sheet) + Math.min(rows.length, 100) + Math.min(unique, 100)
      + blocks.reduce((sum, block) => sum + block.score, 0);
    candidates.push({ sheet, rows, score });
  }
  candidates.sort((a, b) => b.score - a.score || a.sheet.name.localeCompare(b.sheet.name));
  const best = candidates[0];
  if (!best) {
    throw new Error('Cevap dosyasında tanınan başlık satırı bulunamadı (Material Code / Quantity / Size 1 beklenir).');
  }
  return { rows: best.rows, sheet: best.sheet.name };
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

function percent(numerator: number, denominator: number, emptyValue = 100): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : emptyValue;
}

function quantityOverlap(
  ours: Map<string, OursAggregate>,
  answer: Map<string, AnswerAggregate>,
  unit?: Unit,
): QuantityWeightedOverlap {
  const keys = new Set([...ours.keys(), ...answer.keys()]);
  let intersection = 0, union = 0, oursTotal = 0, answerTotal = 0;
  for (const key of keys) {
    const oursValue = ours.get(key)?.value;
    const answerValue = answer.get(key)?.value;
    const keyUnit = oursValue?.unit ?? answerValue?.unit;
    if (unit && keyUnit !== unit) continue;
    const oursQty = Math.max(0, oursValue?.qty ?? 0);
    const answerQty = Math.max(0, answerValue?.qty ?? 0);
    intersection += Math.min(oursQty, answerQty);
    union += Math.max(oursQty, answerQty);
    oursTotal += oursQty;
    answerTotal += answerQty;
  }
  return {
    percent: percent(intersection, union),
    intersection: round3(intersection),
    union: round3(union),
    oursTotal: round3(oursTotal),
    answerTotal: round3(answerTotal),
  };
}

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
): AnswerDiffWithMetrics {
  // Model-dışı satırlar (external) karşılaştırmaya GİRMEZ: modelden ölçülemeyen
  // insan eklerini skora karıştırmak "motor kötü" yanılgısı üretir. Ayrı blokta
  // raporlanır — teklife elle eklenecek kalemler olarak görünür kalırlar.
  const externalAgg = new Map<string, AnswerValue>();
  for (const row of answer.filter(value => value.external)) {
    const key = `${normCode(row.code)}|${row.s1 ?? '?'}|${row.s2}|${row.unit}`;
    const existing = externalAgg.get(key);
    if (existing) existing.qty += row.qty;
    else externalAgg.set(key, { code: normCode(row.code), s1: row.s1, s2: row.s2, qty: row.qty, unit: row.unit });
  }
  const externalItems = [...externalAgg.values()].sort((a, b) => b.qty - a.qty);
  answer = answer.filter(value => !value.external);

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

  const predictedItems = matched + qtyDiff + fieldDiff + extra;
  const referenceItems = matched + qtyDiff + fieldDiff + missing;
  const precision = percent(matched, predictedItems, referenceItems ? 0 : 100);
  const recall = percent(matched, referenceItems, predictedItems ? 0 : 100);
  const f1 = precision + recall > 0 ? Math.round((2 * precision * recall / (precision + recall)) * 10) / 10 : 0;
  const metrics: AnswerComparisonMetrics = {
    precision,
    recall,
    f1,
    quantityWeightedOverlap: quantityOverlap(oursAgg, answerAgg),
    quantityWeightedOverlapByUnit: {
      M: quantityOverlap(oursAgg, answerAgg, 'M'),
      EA: quantityOverlap(oursAgg, answerAgg, 'EA'),
    },
  };

  return {
    id: options.comparisonId ?? randomUUID(),
    baseRowsHash: hashMtoRows(ours),
    baseRowsRevision: options.baseRowsRevision ?? 0,
    fileName,
    sheet,
    accuracy: rows.length ? Math.round((matched / rows.length) * 1000) / 10 : 0,
    targetAccuracy: 90,
    counts: { matched, qtyDiff, fieldDiff, missing, extra },
    metrics,
    rows,
    ...(externalItems.length ? { externalItems } : {}),
    createdAt: new Date().toISOString(),
  };
}
