import { NextRequest, NextResponse } from 'next/server';
import { getRun, getRows, getSteel } from '@/lib/store';
import { isApiDenial, requireApiIdentity } from '@/lib/session';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Gemini ile kısa mühendis-özeti (opsiyonel — GEMINI_API_KEY yoksa 404)
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const identity = await requireApiIdentity();
  if (isApiDenial(identity)) return identity;
  const key = process.env.GEMINI_API_KEY;
  if (!key) return NextResponse.json({ error: 'disabled' }, { status: 404 });
  const { id } = await ctx.params;
  const run = await getRun(identity, id);
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const { lang = 'en' } = await req.json().catch(() => ({}));

  const [rows, steel] = await Promise.all([getRows(identity, id), getSteel(identity, id)]);
  const main = rows.filter(r => r.scope === 'MAIN');
  const compact = main.map(r => `${r.line}|${r.code}${r.sub ? '/' + r.sub : ''}|${r.s1 ?? '?'}x${r.s2 || 0}|${r.qty}${r.unit}`).join('\n');
  const steelTxt = steel.map(s => `${s.profile} ${s.lengthMm}mm x${s.count} (${s.totalKg.toFixed(0)}kg)`).join('; ');

  const prompt = lang === 'tr'
    ? `Sen kıdemli bir tesisat metraj mühendisisin. Aşağıdaki MTO'yu 4-5 cümlede özetle: sistemin karakteri (çaplar, dominant hat), dikkat çeken noktalar (büyük redüksiyonlar, yoğun flanş bölgeleri, çelik), ve teklif hazırlarken kontrol edilmesi gereken 1-2 risk. Rakam uydurma, sadece verilenleri kullan. Düz metin yaz.\n\nMTO:\n${compact}\n\nÇelik: ${steelTxt || 'yok'}`
    : `You are a senior piping estimator. Summarize this MTO in 4-5 sentences: system character (sizes, dominant lines), notable items, and 1-2 risks to verify before quoting. Use only given numbers. Plain text.\n\nMTO:\n${compact}\n\nSteel: ${steelTxt || 'none'}`;

  try {
    // gemini-2.0-flash 2026'da emekli edildi (404); 2.5-flash-lite hızlı ve
    // düşünme-bütçesi olmadan doğrudan metin döndürüyor (2.5-flash kısa
    // maxOutputTokens'ta thinking'e harcayıp boş dönebiliyor).
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 400, temperature: 0.4 } }),
    });
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('empty response');
    return NextResponse.json({ text });
  } catch (e) {
    console.error('insight failed', e);
    return NextResponse.json({ error: 'insight failed' }, { status: 500 });
  }
}
