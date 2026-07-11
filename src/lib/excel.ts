// Metriq — Excel dışa aktarım (müşteri formatı)
import 'server-only';
import ExcelJS from 'exceljs';
import { npsToDn } from './pipe-sizes';
import type { MtoRow, Run, SteelRow } from './types';

const COPPER = 'FFC55A11';
const HDR_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };

function styleHeader(ws: ExcelJS.Worksheet, cols: { header: string; key: string; width: number }[]) {
  ws.columns = cols;
  const row = ws.getRow(1);
  row.eachCell(c => {
    c.font = HDR_FONT;
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COPPER } };
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

export async function buildRunWorkbook(run: Run, rows: MtoRow[], steel: SteelRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Metriq';

  // --- MTO ---
  const ws = wb.addWorksheet('MTO');
  styleHeader(ws, [
    { header: 'Item No.', key: 'i', width: 8 },
    { header: 'Line / Drawing', key: 'line', width: 22 },
    { header: 'Material Code', key: 'code', width: 18 },
    { header: 'Sub Type', key: 'sub', width: 20 },
    { header: 'Size 1 (mm)', key: 'mm1', width: 11 },
    { header: 'Size 2 (mm)', key: 'mm2', width: 11 },
    { header: 'Size 1 (inch)', key: 's1', width: 11 },
    { header: 'Size 2 (inch)', key: 's2', width: 11 },
    { header: 'Quantity', key: 'qty', width: 11 },
    { header: 'Qty. Units', key: 'unit', width: 9 },
    { header: 'Remark', key: 'remark', width: 34 },
  ]);
  let i = 1;
  for (const r of rows.filter(x => x.scope === 'MAIN')) {
    ws.addRow({
      i: i++, line: r.line, code: r.code, sub: r.sub,
      mm1: npsToDn(r.s1) ?? '', mm2: r.s2 ? (npsToDn(r.s2) ?? '') : 0,
      s1: r.s1 ?? '?', s2: r.s2 || 0,
      qty: r.unit === 'M' ? Math.round(r.qty * 1000) / 1000 : Math.round(r.qty),
      unit: r.unit, remark: r.remark + (r.edited ? ' [düzenlendi]' : ''),
    });
  }

  // --- Çelik ---
  if (steel.length) {
    const ws2 = wb.addWorksheet('Çelik');
    styleHeader(ws2, [
      { header: 'Profil', key: 'p', width: 24 },
      { header: 'Boy (mm)', key: 'l', width: 12 },
      { header: 'Adet', key: 'n', width: 8 },
      { header: 'Toplam (m)', key: 'tm', width: 12 },
      { header: 'Toplam (kg)', key: 'tk', width: 12 },
    ]);
    for (const s of steel) {
      ws2.addRow({ p: s.profile, l: s.lengthMm, n: s.count, tm: Math.round(s.lengthMm * s.count) / 1000, tk: Math.round(s.totalKg * 10) / 10 });
    }
    const totM = steel.reduce((s, r) => s + r.lengthMm * r.count, 0) / 1000;
    const totKg = steel.reduce((s, r) => s + r.totalKg, 0);
    const tr = ws2.addRow({ p: 'TOPLAM', n: steel.reduce((s, r) => s + r.count, 0), tm: Math.round(totM * 100) / 100, tk: Math.round(totKg * 10) / 10 });
    tr.font = { bold: true };
  }

  // (Kapsam dışı / bilgi sayfası kullanıcı talebiyle kaldırıldı — INFO satırları
  // yalnız iç sınıflandırmada kalır; teklife girmeyen kalemler ayrı listelenmez.)

  // --- Yöntem ---
  const ws4 = wb.addWorksheet('Yöntem');
  ws4.getColumn(1).width = 110;
  const notes = [
    `Metriq v1 — ${run.fileName} — ${new Date(run.createdAt).toLocaleString('tr-TR')}`,
    '',
    'Kaynak: Navisworks NWD içindeki Plant 3D komponent verisi (sınıf + GUID tekilleştirme).',
    'Boyutlar: OD-doğrulamalı (ASME B36.10 + DIN 11850-2 hijyenik metrik tablo), nominal inç.',
    'Boru: model NET kesim boyu (gross istenirse kalibrasyondaki katsayı uygulanır).',
    'Bağlantı elemanları: ' + `conta ${run.fasteners.gaskets} · cıvata seti ${run.fasteners.boltSets} · collar/stub ${run.fasteners.stubEnds}`,
    'Yöntem üç gerçek müşteri vakasıyla kalibre edildi; kurallar kalibrasyon profilinde düzenlenebilir.',
  ];
  notes.forEach((n, idx) => { ws4.getCell(idx + 1, 1).value = n; if (idx === 0) ws4.getCell(1, 1).font = { bold: true }; });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
