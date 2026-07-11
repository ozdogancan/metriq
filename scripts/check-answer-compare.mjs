import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { compareAnswer, parseAnswerXlsx } from '../src/lib/answer-compare.ts';

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
assert.deepEqual(exact.counts, { matched: 1, qtyDiff: 0, missing: 0, extra: 0 });

const withExtra = compareAnswer(
  [row('1', 'ELBOW', 1), row('2', 'VALVE', 1)],
  answer,
  'answer.xlsx',
  'MTO',
);
assert.equal(withExtra.accuracy, 50, 'extra exported material must reduce accuracy');
assert.equal(withExtra.counts.extra, 1);

const wrongQuantity = compareAnswer([row('1', 'ELBOW', 2)], answer, 'answer.xlsx', 'MTO');
assert.equal(wrongQuantity.accuracy, 0);
assert.equal(wrongQuantity.counts.qtyDiff, 1);

const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet('MTO');
sheet.addRow(['Material Code', 'Size 1 (inch)', 'Quantity', 'Unit']);
sheet.addRow(['ELBOW', 2, 1, 'EA']);
const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
const parsed = await parseAnswerXlsx(xlsx);
assert.equal(parsed.rows.length, 1);
assert.equal(parsed.rows[0].code, 'ELBOW');

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

console.log('answer comparison: metrics, XLSX parse, and forged ZIP-size rejection verified');
