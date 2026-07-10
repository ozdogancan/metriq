# 03 — Karar Günlüğü (ADR-lite)

> Mimari kararların kısa kaydı. Format sabittir (aşağıdaki şablon); yeni karar **en üste değil,
> sıradaki numarayla en alta** eklenir. Kararı geri almak = yeni ADR (eskisini "İptal: ADR-XXX" ile işaretle).
> İlk 7 kayıt 2026-07-10'da geri-doldurulmuştur (kararlar proje başlangıcında alındı).

## ADR-001 — Cookie-auth (HMAC imzalı oturum)
- **Tarih:** 2026-07 (geri-doldurma)
- **Karar:** NextAuth / Supabase Auth yerine kendi hafif oturum katmanı: HMAC-SHA256 imzalı cookie (`metriq_session`), kullanıcılar `AUTH_USERS` env değişkeninde (`email:sifre;...`).
- **Gerekçe:** Az sayıda bilinen kullanıcı; sıfır ek bağımlılık/tablo; timing-safe doğrulama yeterli güvenlik.
- **Sonuç:** Canlı — `src/lib/auth.ts`, `/api/auth/login`, `/api/auth/logout`. `AUTH_SECRET` prod'da zorunlu.

## ADR-002 — Proxy kapısı (varsayılan-korumalı rotalar)
- **Tarih:** 2026-07 (geri-doldurma)
- **Karar:** Tüm rotalar Next proxy'de (`src/proxy.ts`) oturum kontrolünden geçer; matcher yalnız statikleri, `/api/auth/login`'i ve marka varlıklarını açık bırakır. Token doğrulama Web Crypto ile (lib importsuz, edge-uyumlu).
- **Gerekçe:** Allowlist > denylist — yeni eklenen her sayfa/API otomatik korumalı doğar. API'ler 401 JSON, sayfalar `/login?next=` yönlendirmesi alır.
- **Sonuç:** Canlı — `src/proxy.ts`.

## ADR-003 — Store fallback (Supabase / yerel JSON)
- **Tarih:** 2026-07 (geri-doldurma)
- **Karar:** Tek depolama arayüzü (`src/lib/store.ts`); env varsa Supabase (DB + Storage), yoksa `.data/` yerel JSON sürücüsü (`isSupabase` bayrağı).
- **Gerekçe:** Sıfır kurulumla lokal geliştirme; prod'da Supabase'e şeffaf geçiş; test verisi izole.
- **Sonuç:** Canlı. Uyarı: `.data` Vercel'de kalıcı DEĞİLDİR — prod her zaman Supabase.

## ADR-004 — Kalibrasyon profilleri (kural = veri, kod değil)
- **Tarih:** 2026-07 (geri-doldurma)
- **Karar:** Metraj konvansiyonları koda gömülmez; bildirimsel `CalibrationRules` (`src/lib/types.ts`) + vocab başına `DEFAULT_RULES` olarak tutulur ve tek noktadan uygulanır (`applyRules`, `src/lib/vocab.ts`).
- **Gerekçe:** Kapsam/vokabüler müşteriye ve sistem tipine göre değişir (26010 çelik ↔ 26113 hijyenik META-dersi). Öğrenme döngüsü ancak kurallar veri olursa mümkün.
- **Sonuç:** Canlı — öğrenme sözleşmesinin temeli (`02-learning.md`).

## ADR-005 — Görsel/içgörü AI: Gemini
- **Tarih:** 2026-07 (geri-doldurma)
- **Karar:** Ucuz/hızlı AI işleri Gemini'ye: (a) MTO mühendis-özeti `/api/runs/[id]/insight` (gemini-2.0-flash, `GEMINI_API_KEY` yoksa 404 → tamamen opsiyonel), (b) marka görselleri (logo, login-hero, opengraph) Gemini görsel üretimiyle.
- **Gerekçe:** Özet/görsel işleri düşük risk + yüksek hacim; promptta "rakam uydurma, sadece verilenleri kullan" kuralı sabit.
- **Sonuç:** Canlı — `src/app/api/runs/[id]/insight/route.ts`.

## ADR-006 — Complexity-router: karmaşık akıl yürütme → Claude
- **Tarih:** 2026-07 (geri-doldurma)
- **Karar:** AI görevleri karmaşıklığa göre yönlendirilir: basit özet/görsel → Gemini Flash (ADR-005); karmaşık akıl yürütme (learning_events desen analizi, kalibrasyon önerisi gerekçelendirme) → Claude.
- **Gerekçe:** Maliyet/kalite dengesi — kural türetme yanlış olursa metraj bozulur, güçlü model şart; özet yanlış olursa zarar küçük.
- **Sonuç:** Karar verildi; Gemini tarafı canlı, Claude entegrasyonu öğrenme döngüsüyle birlikte gelecek (henüz kodda yok).

## ADR-007 — Parser sözleşmesi (sabit arayüz, değiştirilebilir motor)
- **Tarih:** 2026-07 (geri-doldurma)
- **Karar:** `src/lib/parser/nwd.ts` yalnız sözleşmeyi taşır (`ParsedComponent`, `ParseResult`, `parseNwd`); gerçek implementasyon `dwg-takeoff/nwd_mto3.py`'nin TS portu olarak bu sözleşmenin arkasına takılır.
- **Gerekçe:** Platform kodu ile ayrıştırma motoru bağımsız evrilsin; motor 3 vakayla regresyon-testli, sözleşme kırılmadan güncellenebilir.
- **Sonuç:** Sözleşme canlı; TS portu entegrasyonu sürüyor.

---

## Yeni karar şablonu

```markdown
## ADR-NNN — <kısa başlık>
- **Tarih:** YYYY-MM-DD
- **Karar:** <ne yapılıyor — tek cümle, emir kipi>
- **Gerekçe:** <neden bu, neden alternatifler değil — 1-2 cümle>
- **Sonuç:** <durum: Canlı / Kısmen / Bekliyor + ilgili dosya yolları>
```
