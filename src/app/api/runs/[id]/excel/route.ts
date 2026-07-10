import { NextRequest, NextResponse } from 'next/server';
import { getRun, getRows, getSteel } from '@/lib/store';
import { buildRunWorkbook } from '@/lib/excel';

export const runtime = 'nodejs';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 });
  // İşlem bitmeden Excel indirilemesin — boş/yarım dosya teklifi kirletir
  if (run.status !== 'done') {
    const msg = run.status === 'processing'
      ? 'Metraj hâlâ işleniyor — Excel indirmek için işlemin tamamlanmasını bekleyin.'
      : 'Bu çalışma hatayla sonuçlandı — Excel çıktısı üretilemiyor. Dosyayı yeniden yükleyin.';
    return NextResponse.json({ error: msg }, { status: 409 });
  }
  try {
    const [rows, steel] = await Promise.all([getRows(id), getSteel(id)]);
    const buf = await buildRunWorkbook(run, rows, steel);
    const safe = run.projectName.replace(/[^\w\-. ]+/g, '').slice(0, 60) || 'metraj';
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="MTO - ${safe}.xlsx"`,
      },
    });
  } catch (e) {
    console.error('excel export failed', { id, error: e });
    return NextResponse.json({ error: 'excel failed' }, { status: 500 });
  }
}
