import { NextRequest, NextResponse } from 'next/server';
import { getRun, getRows, getSteel } from '@/lib/store';
import { buildRunWorkbook } from '@/lib/excel';
import { requireApiSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireApiSession();
  if (denied) return denied;
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
    // Türkçe karakterler indirme adında KORUNUR: modern tarayıcılar RFC 5987
    // filename* (UTF-8) okur; eski istemciler için TR-çevirili ASCII fallback.
    // (Önceki \w regex'i ASCII-only olduğundan Ç/Ö/Ş/İ/Ğ/Ü harflerini siliyordu.)
    const clean = (run.projectName.replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 60) || 'metraj');
    const trMap: Record<string, string> = { ı: 'i', İ: 'I', ş: 's', Ş: 'S', ğ: 'g', Ğ: 'G', ç: 'c', Ç: 'C', ö: 'o', Ö: 'O', ü: 'u', Ü: 'U' };
    const ascii = clean
      .replace(/[ıİşŞğĞçÇöÖüÜ]/g, ch => trMap[ch] ?? ch)
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^\x20-\x7E]/g, '_');
    const utf8Name = encodeURIComponent(`MTO - ${clean}.xlsx`);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="MTO - ${ascii}.xlsx"; filename*=UTF-8''${utf8Name}`,
      },
    });
  } catch (e) {
    console.error('excel export failed', { id, error: e });
    return NextResponse.json({ error: 'excel failed' }, { status: 500 });
  }
}
