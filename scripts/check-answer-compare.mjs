import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import * as SheetJS from '@e965/xlsx';
import { compareAnswer, parseAnswerXlsx } from '../src/lib/answer-compare.ts';
import { metriqCorpusManifest } from './metriq-corpus-manifest.mjs';

assert.equal(metriqCorpusManifest.length, 9, 'committed corpus manifest must keep all nine fixture slots');
assert.equal(metriqCorpusManifest.filter(value => value.expectation === 'unsupported').length, 1);
assert.equal(metriqCorpusManifest.find(value => value.id === 'golden-optional')?.optional, true);
assert.equal(metriqCorpusManifest.every(value => !/ENQ|\d{5}/i.test(`${value.id} ${value.label}`)), true);

const row = (id, code, qty) => ({
  id,
  line: 'L1',
  code,
  sub: '',
  s1: 2,
  s2: 0,
  qty,
  unit: 'EA',
  remark: '',
  scope: 'MAIN',
});
const answer = [{ code: 'ELBOW', s1: 2, s2: 0, qty: 1, unit: 'EA' }];

const exact = compareAnswer([row('1', 'ELBOW', 1)], answer, 'answer.xlsx', 'MTO');
assert.equal(exact.accuracy, 100);
assert.deepEqual(exact.counts, { matched: 1, qtyDiff: 0, fieldDiff: 0, missing: 0, extra: 0 });
assert.deepEqual(
  { precision: exact.metrics.precision, recall: exact.metrics.recall, f1: exact.metrics.f1 },
  { precision: 100, recall: 100, f1: 100 },
);
assert.equal(exact.metrics.quantityWeightedOverlap.percent, 100);

const withExtra = compareAnswer(
  [row('1', 'ELBOW', 1), row('2', 'VALVE', 1)],
  answer,
  'answer.xlsx',
  'MTO',
);
assert.equal(withExtra.accuracy, 50, 'extra exported material must reduce accuracy');
assert.equal(withExtra.counts.extra, 1);
assert.deepEqual(
  { precision: withExtra.metrics.precision, recall: withExtra.metrics.recall, f1: withExtra.metrics.f1 },
  { precision: 50, recall: 100, f1: 66.7 },
);
assert.equal(withExtra.metrics.quantityWeightedOverlap.percent, 50);

const wrongQuantity = compareAnswer([row('1', 'ELBOW', 2)], answer, 'answer.xlsx', 'MTO');
assert.equal(wrongQuantity.accuracy, 0);
assert.equal(wrongQuantity.counts.qtyDiff, 1);
assert.equal(wrongQuantity.metrics.f1, 0);
assert.equal(wrongQuantity.metrics.quantityWeightedOverlap.percent, 50);

const recoveredSize = compareAnswer(
  [{ ...row('1', 'BACKING FLANGE', 2), s1: null }],
  [{ code: 'BACKING FLANGE', s1: 10, s2: 0, qty: 2, unit: 'EA' }],
  'answer.xlsx',
  'MTO',
);
assert.equal(recoveredSize.rows.length, 1, 'unique missing+extra size pair must be one logical difference');
assert.equal(recoveredSize.counts.fieldDiff, 1);
assert.equal(recoveredSize.counts.missing, 0);
assert.equal(recoveredSize.counts.extra, 0);
assert.equal(recoveredSize.rows[0].kind, 'size');
assert.deepEqual(recoveredSize.rows[0].oursSide?.rowIds, ['1']);

const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet('MTO');
sheet.addRow(['Material Code', 'Size 1 (inch)', 'Quantity', 'Unit']);
sheet.addRow(['ELBOW', 2, 1, 'EA']);
const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
const parsed = await parseAnswerXlsx(xlsx);
assert.equal(parsed.rows.length, 1);
assert.equal(parsed.rows[0].code, 'ELBOW');

// A richer occurrence-level Master sheet must not outrank the explicit MTO
// output sheet. Both horizontal MTO blocks are part of the same answer.
const multi = new ExcelJS.Workbook();
const master = multi.addWorksheet('Master');
master.addRow(['Material Code', 'Size 1 (inch)', 'Quantity', 'Unit']);
for (let i = 0; i < 150; i++) master.addRow(['RAW OCCURRENCE', 2, 1, 'EA']);
const summary = multi.addWorksheet('MTO');
summary.addRow([
  'Material Code', 'Size 1 (mm)', 'Quantity', 'Qty. Units', null,
  'Material Code', 'Size 1 (mm)', 'Quantity', 'Qty. Units',
]);
summary.addRow(['PIPE', 100, 12.5, 'M', null, 'GASKET', 100, 4, 'EA']);
const multiParsed = await parseAnswerXlsx(Buffer.from(await multi.xlsx.writeBuffer()));
assert.equal(multiParsed.sheet, 'MTO');
assert.deepEqual(multiParsed.rows.map(value => value.code), ['PIPE', 'GASKET']);

// Row-ID templates expose both customer-norm and raw inch columns. The latter
// (last matching header) is the comparison key; Total Quantity is the quantity.
const rowIdBook = new ExcelJS.Workbook();
const rowIdSheet = rowIdBook.addWorksheet('MTO');
rowIdSheet.addRow(['report title']);
rowIdSheet.addRow([]);
rowIdSheet.addRow([
  'Row ID Number', 'Description (1)', 'Size1/Items (INCH)_TPMG Norms',
  'Size1/Items (INCH)', 'Unit of Measure', 'Total Quantity',
]);
rowIdSheet.addRow([1, 'PIPE', '14"', 6, 'M', 12.5]);
const rowIdParsed = await parseAnswerXlsx(Buffer.from(await rowIdBook.xlsx.writeBuffer()));
assert.equal(rowIdParsed.rows.length, 1);
assert.deepEqual(rowIdParsed.rows[0], { code: 'PIPE', s1: 6, s2: 0, qty: 12.5, unit: 'M' });

// Legacy BIFF8 adapter is selected by CFB signature, not filename. The generic
// DN + Description + Quantity BOM semantics map descriptions without fixture branches.
const legacyBook = SheetJS.utils.book_new();
const legacySheet = SheetJS.utils.aoa_to_sheet([
  ['DN', 'Description', 'Quantity'],
  [100, 'Pipe DIN 2448', 2500],
  [50, 'Bend DIN 2605-1-45-3', 2],
  [80, 'Flange C 10 DIN 2527', 1],
]);
SheetJS.utils.book_append_sheet(legacyBook, legacySheet, 'Bill of Material');
const legacyBuffer = Buffer.from(SheetJS.write(legacyBook, { type: 'buffer', bookType: 'biff8' }));
const legacyParsed = await parseAnswerXlsx(legacyBuffer);
assert.deepEqual(legacyParsed.rows, [
  { code: 'PIPE', s1: 4, s2: 0, qty: 2.5, unit: 'M' },
  { code: '45 BEND', s1: 2, s2: 0, qty: 2, unit: 'EA' },
  { code: 'BLIND FLANGE', s1: 3, s2: 0, qty: 1, unit: 'EA' },
]);
const oversizedLegacy = Buffer.alloc(4 * 1024 * 1024 + 1);
legacyBuffer.copy(oversizedLegacy, 0, 0, 8);
await assert.rejects(() => parseAnswerXlsx(oversizedLegacy), /4 MB/);
const malformedLegacy = Buffer.alloc(512);
legacyBuffer.copy(malformedLegacy, 0, 0, 8);
malformedLegacy.writeUInt16LE(3, 0x1a);
malformedLegacy.writeUInt16LE(0xfffe, 0x1c);
malformedLegacy.writeUInt16LE(9, 0x1e);
malformedLegacy.writeUInt16LE(6, 0x20);
malformedLegacy.writeUInt32LE(100, 0x2c);
await assert.rejects(() => parseAnswerXlsx(malformedLegacy), /sektör/);

// Forge a tiny declared size for a genuinely larger deflated entry. The
// preflight must count actual inflate output before ExcelJS gets the archive.
const forged = Buffer.from(xlsx);
let forgedEntry = false;
for (let i = 0; i + 46 <= forged.length; i++) {
  if (forged.readUInt32LE(i) !== 0x02014b50) continue;
  const method = forged.readUInt16LE(i + 10);
  const uncompressed = forged.readUInt32LE(i + 24);
  if (method === 8 && uncompressed > 32) {
    forged.writeUInt32LE(1, i + 24);
    forgedEntry = true;
    break;
  }
}
assert.equal(forgedEntry, true);
await assert.rejects(() => parseAnswerXlsx(forged), /ZIP/);

console.log('answer comparison: extended metrics, multi-block/Row-ID, XLS/CFB, and archive guards verified');

// Model-disi satirlar (GA/DWG referans kolonu): bos ref veya RFI karsilastirmaya
// GIRMEZ, externalItems'ta raporlanir. Kolon yoksa hicbir sey isaretlenmez.
{
  const extBook = new ExcelJS.Workbook();
  const extSheet = extBook.addWorksheet('MTO');
  extSheet.addRow(['Item No.', 'GA', 'Material Code', 'Size 1 (inch)', 'Quantity', 'Unit']);
  extSheet.addRow([1, '008', 'PIPE', 6, 100, 'M']);      // modelden
  extSheet.addRow([2, '', 'PIPE', 6, 50, 'M']);          // GA bos -> insan eki
  extSheet.addRow([3, 'RFI', 'GASKET', 6, 10, 'EA']);    // RFI -> insan eki
  const extBuf = Buffer.from(await extBook.xlsx.writeBuffer());
  const { rows: extRows } = await parseAnswerXlsx(extBuf);
  assert.equal(extRows.length, 3, 'uc satir da okunmali');
  assert.equal(extRows.filter(r => r.external).length, 2, 'GA-bos + RFI external olmali');
  const oursExt = [{ id: 'p1', line: 'L', code: 'PIPE', sub: '', s1: 6, s2: 0, qty: 100, unit: 'M', remark: '', scope: 'MAIN' }];
  const extDiff = compareAnswer(oursExt, extRows, 'f.xlsx', 'MTO');
  assert.equal(extDiff.accuracy, 100, 'external satirlar skoru dusurmemeli (tek karsilastirilabilir satir birebir)');
  assert.equal(extDiff.externalItems?.length, 2, 'externalItems iki kalem tasimali');
  assert.ok(extDiff.externalItems.some(x => x.code === 'PIPE' && x.qty === 50), 'GA-bos boru external listede');

  // referans kolonu OLMAYAN sablonda davranis degismez
  const plainBook = new ExcelJS.Workbook();
  const plainSheet = plainBook.addWorksheet('MTO');
  plainSheet.addRow(['Material Code', 'Size 1 (inch)', 'Quantity', 'Unit']);
  plainSheet.addRow(['PIPE', 6, 100, 'M']);
  const { rows: plainRows } = await parseAnswerXlsx(Buffer.from(await plainBook.xlsx.writeBuffer()));
  assert.equal(plainRows.filter(r => r.external).length, 0, 'ref kolonu yokken external isaretlenmemeli');
}
console.log('answer comparison: model-external (GA/RFI) split verified');
