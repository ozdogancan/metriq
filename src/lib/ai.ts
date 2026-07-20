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
          messageEn: { type: 'string' as const },
          rowId: { type: 'string' as const },
        },
        required: ['severity', 'message', 'messageEn'],
        additionalProperties: false,
      },
    },
    summary: { type: 'string' as const },
    summaryEn: { type: 'string' as const },
  },
  required: ['findings', 'summary', 'summaryEn'],
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

Kurallar: SADECE verilen verilerden çalış, rakam uydurma. Her bulguda mümkünse rowId ver (satırın başındaki 8 haneli kimlik). Kritik=teklifi etkiler, warn=kontrol edilmeli, info=not. EN FAZLA 15 bulgu — en önemlileri seç, her mesaj tek cümle. Bulgu yoksa boş findings + kısa olumlu özet döndür.
DİL: UI iki dilli — her bulguyu İKİ dilde yaz: "message"=Türkçe, "messageEn"=İngilizce (aynı içerik, çeviri). Özet de iki dilde: "summary"=Türkçe 2-3 cümle, "summaryEn"=English aynı içerik.

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
    const parsed = JSON.parse(text.text) as { findings: AiFinding[]; summary: string; summaryEn?: string };
    // rowId'leri tam id'ye geri eşle
    const byPrefix = new Map(main.map(r => [r.id.slice(0, 8), r.id]));
    const findings = (parsed.findings || []).slice(0, 40).map(f => ({
      severity: f.severity, message: f.message, messageEn: f.messageEn,
      rowId: f.rowId ? byPrefix.get(f.rowId.slice(0, 8)) : undefined,
    }));
    return {
      model: complexity.model,
      complexity: complexity.score,
      tier: complexity.tier,
      findings,
      summary: parsed.summary || '',
      summaryEn: parsed.summaryEn,
      createdAt: new Date().toISOString(),
    };
  } catch (e) {
    console.error('AI denetim hatası (fail-soft):', e);
    return null;
  }
}

// ---------- Geri bildirim yorumlama ----------
// Serbest metin geri bildirimi MEVCUT kural sözlüğüne çevirir (codeRenames /
// excludeLines / itemCorrections). Rakam uydurma yetkisi YOK: miktar değişikliği,
// satır ekleme, çarpan gibi istekler 'unmappable' olarak dürüstçe geri döner.
export interface FeedbackActions {
  codeRenames: Array<{ from: string; to: string }>;
  excludeLines: string[];
  itemCorrections: Array<{
    match: { code: string; s1: number | null; s2: number; unit: 'M' | 'EA'; line?: string; sub?: string };
    set: { code?: string; s1?: number | null; s2?: number; unit?: 'M' | 'EA'; scope?: 'MAIN' | 'INFO' };
  }>;
}
export interface FeedbackInterpretation {
  actions: FeedbackActions;
  unmappable: string;   // kurala çevrilemeyen kısım — boşsa hepsi eşlendi
  summaryTr: string;
  summaryEn: string;
}

const FEEDBACK_SCHEMA = {
  type: 'object' as const,
  properties: {
    actions: {
      type: 'object' as const,
      properties: {
        codeRenames: {
          type: 'array' as const,
          items: {
            type: 'object' as const,
            properties: { from: { type: 'string' as const }, to: { type: 'string' as const } },
            required: ['from', 'to'], additionalProperties: false,
          },
        },
        excludeLines: { type: 'array' as const, items: { type: 'string' as const } },
        itemCorrections: {
          type: 'array' as const,
          items: {
            type: 'object' as const,
            properties: {
              match: {
                type: 'object' as const,
                properties: {
                  code: { type: 'string' as const },
                  s1: { type: ['number', 'null'] as const },
                  s2: { type: 'number' as const },
                  unit: { type: 'string' as const, enum: ['M', 'EA'] },
                  line: { type: 'string' as const },
                  sub: { type: 'string' as const },
                },
                required: ['code', 's1', 's2', 'unit'], additionalProperties: false,
              },
              set: {
                type: 'object' as const,
                properties: {
                  code: { type: 'string' as const },
                  s1: { type: ['number', 'null'] as const },
                  s2: { type: 'number' as const },
                  unit: { type: 'string' as const, enum: ['M', 'EA'] },
                  scope: { type: 'string' as const, enum: ['MAIN', 'INFO'] },
                },
                additionalProperties: false,
              },
            },
            required: ['match', 'set'], additionalProperties: false,
          },
        },
      },
      required: ['codeRenames', 'excludeLines', 'itemCorrections'],
      additionalProperties: false,
    },
    unmappable: { type: 'string' as const },
    summaryTr: { type: 'string' as const },
    summaryEn: { type: 'string' as const },
  },
  required: ['actions', 'unmappable', 'summaryTr', 'summaryEn'],
  additionalProperties: false,
};

export async function interpretFeedback(args: {
  text: string;
  rows: MtoRow[];
  vocab: string;
}): Promise<FeedbackInterpretation | null> {
  if (!aiEnabled) return null;
  const { text, rows, vocab } = args;
  const lines = [...new Set(rows.map(r => r.line).filter(l => l && l !== '?' && l !== '*'))].sort();
  const codes = [...new Set(rows.map(r => r.code))].sort();
  const compact = rows.filter(r => r.scope === 'MAIN').slice(0, 400).map(r =>
    `${r.line}|${r.code}${r.sub ? '/' + r.sub : ''}|${r.s1 ?? '?'}x${r.s2 || 0}|${r.qty}${r.unit}`).join('\n');

  const prompt = `Sen Metriq metraj platformunun kural çevirmenisin. Kullanıcı, metraj sonucuna serbest metinle geri bildirim verdi. Görevin bu geri bildirimi platformun MEVCUT kural sözlüğüne çevirmek — başka hiçbir şey.

KURAL SÖZLÜĞÜ (yalnız bunlar):
1) codeRenames: bir kodu başka koda çevir (ör. "CAP yerine KEP yazılsın" → {from:"CAP",to:"KEP"}).
2) excludeLines: bir hattı kapsam dışına al (satırlar silinmez, bilgi bölümüne iner). Hat adları AŞAĞIDAKİ listeden birebir seçilmeli.
3) itemCorrections: TAM imza eşleşen kalemi düzelt (match: code+s1+s2+unit[+line]) → set: code/s1/s2/unit/scope değişebilir. scope:"INFO" = kapsam dışına al, "MAIN" = kapsama geri al.

YETKİN OLMAYANLAR (bunları actions'a KOYMA, 'unmappable' alanında açıkla):
- Miktar değiştirme/uydurma, yeni satır ekleme, çarpan/faktör, "daha doğru ölç" gibi genel istekler.
- Listede olmayan hat/kod adları (tahmin etme).

Tesisat profili: ${vocab}
MEVCUT HATLAR: ${lines.join(' · ') || '(yok)'}
MEVCUT KODLAR: ${codes.join(' · ')}
SATIRLAR (hat|kod|çap|miktar — ilk 400):
${compact}

KULLANICI GERİ BİLDİRİMİ:
"""${text.slice(0, 2000)}"""

Kurallar: SADECE geri bildirimde açıkça istenen değişiklikleri çıkar; emin olmadığını unmappable'a yaz. summaryTr/summaryEn: yapılacak değişikliklerin 1-2 cümlelik özeti (iki dil aynı içerik). Hiçbir eylem çıkmıyorsa boş diziler + unmappable'da nedenini ve İŞE YARAYAN örnek geri bildirim biçimlerini yaz.`;

  try {
    const res = await client().messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
      output_config: { format: { type: 'json_schema', schema: FEEDBACK_SCHEMA } },
    });
    const textBlock = res.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') return null;
    return JSON.parse(textBlock.text) as FeedbackInterpretation;
  } catch (e) {
    console.error('geri bildirim yorumlama hatası (fail-soft):', e);
    return null;
  }
}
