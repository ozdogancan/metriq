// Metriq — AI denetçi: dosya komplexity'sine göre Claude modeli seç, MTO'yu çapraz denetle.
// Kullanıcı kuralı: sonuç teklife girer → yanlış kaldırmaz. AI ek bir güvenlik ağıdır,
// deterministik parser çıktısını DEĞİŞTİRMEZ; yalnız şüpheli satırları işaretler.
import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import type { MtoRow, SteelRow, AiAudit, AiFinding } from './types';

const KEY = process.env.ANTHROPIC_API_KEY;
export const aiEnabled = Boolean(KEY);

let _client: Anthropic | null = null;
function client(): Anthropic {
  // timeout: denetim pipeline'ı kilitlemesin — 90 sn'de hata verip fail-soft'a düşer
  if (!_client) _client = new Anthropic({ apiKey: KEY, timeout: 90_000, maxRetries: 2 });
  return _client;
}

// ---------- Komplexity puanı (0-100) ----------
export interface ComplexityInput {
  fileMb: number;
  components: number;
  distinctClasses: number;
  lines: number;
  unknownSizeRatio: number; // boyutu çözülemeyen satır oranı 0-1
  steelMembers: number;
  fastenerCount: number;
}

export function computeComplexity(x: ComplexityInput): { score: number; tier: AiAudit['tier']; model: string } {
  let s = 0;
  s += Math.min(25, (x.components / 3000) * 25);        // komponent hacmi
  s += Math.min(15, (x.distinctClasses / 12) * 15);     // sınıf çeşitliliği
  s += Math.min(15, (x.lines / 20) * 15);               // hat sayısı
  s += Math.min(20, x.unknownSizeRatio * 100 * 2);      // belirsizlik = zorluk
  s += Math.min(10, (x.steelMembers > 0 ? 5 : 0) + (x.steelMembers / 100) * 5);
  s += Math.min(10, (x.fastenerCount / 500) * 10);
  s += Math.min(5, (x.fileMb / 50) * 5);
  const score = Math.round(Math.min(100, s));
  // Kullanıcı talebi: komplexity'ye göre en uygun model. Sonuç kritik olduğundan
  // eşikler muhafazakâr: yalnız gerçekten küçük/temiz dosyalar Haiku'ya düşer.
  if (score < 18) return { score, tier: 'basit', model: 'claude-haiku-4-5' };
  if (score < 55) return { score, tier: 'orta', model: 'claude-sonnet-5' };
  return { score, tier: 'karmaşık', model: 'claude-opus-4-8' };
}

// ---------- Denetim ----------
const AUDIT_SCHEMA = {
  type: 'object' as const,
  properties: {
    findings: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          severity: { type: 'string' as const, enum: ['info', 'warn', 'critical'] },
          message: { type: 'string' as const },
          rowId: { type: 'string' as const },
        },
        required: ['severity', 'message'],
        additionalProperties: false,
      },
    },
    summary: { type: 'string' as const },
  },
  required: ['findings', 'summary'],
  additionalProperties: false,
};

export async function runAudit(args: {
  rows: MtoRow[];
  steel: SteelRow[];
  fasteners: { gaskets: number; boltSets: number; stubEnds: number };
  vocab: string;
  fileName: string;
  complexity: { score: number; tier: AiAudit['tier']; model: string };
  lang: 'tr' | 'en';
}): Promise<AiAudit | null> {
  if (!aiEnabled) return null;
  const { rows, steel, fasteners, vocab, fileName, complexity } = args;

  const main = rows.filter(r => r.scope === 'MAIN');
  const info = rows.filter(r => r.scope === 'INFO');
  const compact = main.map(r =>
    `${r.id.slice(0, 8)}|${r.line}|${r.code}${r.sub ? '/' + r.sub : ''}|${r.s1 ?? '?'}x${r.s2 || 0}|${r.qty}${r.unit}`
  ).join('\n');
  const steelTxt = steel.slice(0, 60).map(s => `${s.profile} ${s.lengthMm}mm x${s.count} = ${s.totalKg.toFixed(0)}kg`).join('; ');

  const prompt = `Sen kıdemli bir tesisat metraj (MTO) denetçisisin. Aşağıdaki metraj deterministik bir NWD parser'dan çıktı ve TEKLİFE GİRECEK — hatalar para kaybettirir. Görevin satırları ÇAPRAZ DENETLEMEK, düzeltmek değil.

Şunları kontrol et ve bulgu olarak raporla:
1) Boyutsuz satırlar (s1='?') — hangileri, önem derecesi.
2) Tutarsızlıklar: bir hat üzerinde boru var ama hiç fitting yok (veya tersi); redüksiyon var ama iki farklı çap o hatta görünmüyor; branş fittingi (TEE/WELDOLET) header çapı hat borusuyla uyuşmuyor.
3) Şüpheli miktarlar: aynı hat+kod+çapta mükerrer görünen satırlar; sıfır/negatif miktar; alışılmadık büyük adet.
4) Vokabüler uyumu (profil: ${vocab}): kod adları profile aykırıysa belirt.
5) Bağlantı elemanı sağlaması: conta=${fasteners.gaskets}, cıvata seti=${fasteners.boltSets}, stub/collar=${fasteners.stubEnds} — flanşlı sistemde conta≈cıvata beklenir; ciddi sapmayı raporla.

Kurallar: SADECE verilen verilerden çalış, rakam uydurma. Her bulguda mümkünse rowId ver (satırın başındaki 8 haneli kimlik). Kritik=teklifi etkiler, warn=kontrol edilmeli, info=not. EN FAZLA 15 bulgu — en önemlileri seç, her mesaj tek cümle. Bulgu yoksa boş findings + kısa olumlu özet döndür. Özet 2-3 cümle, Türkçe.

Dosya: ${fileName} | Ana satır: ${main.length} | Bilgi satırı: ${info.length}
MTO (id|hat|kod|çap1xçap2|miktar):
${compact}

Çelik: ${steelTxt || 'yok'}`;

  try {
    console.log(`[ai] denetim başlıyor: model=${complexity.model} satır=${main.length}`);
    // max_tokens tavanına çarpan yanıt JSON'u yarıda keser — bir kez daha geniş tavanla dene
    let res = await client().messages.create({
      model: complexity.model,
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }],
      output_config: { format: { type: 'json_schema', schema: AUDIT_SCHEMA } },
    });
    if (res.stop_reason === 'max_tokens') {
      console.warn('[ai] yanıt kesildi (max_tokens), 16k tavanla tekrar');
      res = await client().messages.create({
        model: complexity.model,
        max_tokens: 16_000,
        messages: [{ role: 'user', content: prompt }],
        output_config: { format: { type: 'json_schema', schema: AUDIT_SCHEMA } },
      });
    }
    console.log(`[ai] denetim yanıtı geldi: ${res.usage?.output_tokens ?? '?'} token, stop=${res.stop_reason}`);
    const text = res.content.find(b => b.type === 'text');
    if (!text || text.type !== 'text') return null;
    const parsed = JSON.parse(text.text) as { findings: AiFinding[]; summary: string };
    // rowId'leri tam id'ye geri eşle
    const byPrefix = new Map(main.map(r => [r.id.slice(0, 8), r.id]));
    const findings = (parsed.findings || []).slice(0, 40).map(f => ({
      severity: f.severity, message: f.message,
      rowId: f.rowId ? byPrefix.get(f.rowId.slice(0, 8)) : undefined,
    }));
    return {
      model: complexity.model,
      complexity: complexity.score,
      tier: complexity.tier,
      findings,
      summary: parsed.summary || '',
      createdAt: new Date().toISOString(),
    };
  } catch (e) {
    console.error('AI denetim hatası (fail-soft):', e);
    return null;
  }
}
