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
- **Gerekçe:** Kapsam/vokabüler müşteriye ve sistem tipine göre değişir. Öğrenme döngüsü ancak kurallar veri olursa mümkün.
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

## ADR-008 — Postgres-KV köprüsü (geçici kalıcı depolama)
- **Tarih:** 2026-07-10
- **Karar:** Vercel'de `/tmp` fallback'i instance-başına olduğundan (POST'un yazdığı run'ı GET göremiyordu) kullanıcının mevcut Supabase Postgres'inde izole `metriq` şeması açıldı: `metriq.kv` (jsonb doküman) + `metriq.files` (bytea). Sürücü `src/lib/store-pg.ts`; `DATABASE_URL` set + `SUPABASE_URL` yok iken aktif (`isPg`). Runlar per-key (`run-{id}`) — eşzamanlı yükleme yarışı yok.
- **Gerekçe:** Supabase projesi kullanıcı sign-in'ine bağlı; prod'un çalışır olması şart. Tek env değişkeniyle geri alınabilir: kendi Supabase projesi gelince `SUPABASE_URL/SERVICE_ROLE_KEY` set edilir, köprü otomatik devre dışı kalır (veri taşıma: kv → gerçek tablolar).
- **Sonuç:** Canlı — prod E2E doğrulandı (2026-07-10). Sınır: >4.5MB dosya yüklemesi Supabase Storage imzalı-URL akışı gelene dek kapalı (Vercel body limiti).

## ADR-009 — AI denetim yanıt bütçesi
- **Tarih:** 2026-07-10
- **Karar:** Denetim çağrısı `max_tokens: 8000`, `stop_reason === 'max_tokens'` ise tek sefer 16k ile tekrar; promptta "en fazla 15 bulgu, tek cümle" sınırı.
- **Gerekçe:** Prod'da yanıt tam 4000 tokende kesilip JSON parse'ı düşürüyordu → denetim sessizce null oluyordu (fail-soft doğru çalıştı ama değer kayboldu).
- **Sonuç:** Canlı — anonimleştirilmiş fixture üzerinde model yönlendirme + satır işaretleri doğrulandı.

## ADR-010 — Supabase birincil depolama (kendi projesi)
- **Tarih:** 2026-07-10
- **Karar:** Ayrı bir Frankfurt Supabase projesi birincil depolama oldu. `migration.sql` uygulandı, private `models` bucket'ı açıldı; Supabase env'leri server-only tanımlandı. Proje referansı, organizasyon ve fiyat bilgisi depoda tutulmaz.
- **Gerekçe:** Kullanıcı talebi (ayrı proje, Pro org); kalıcı depolama + Storage imzalı-URL akışı (>4.5MB dosyalar) ancak gerçek Supabase ile mümkün.
- **Sonuç:** Canlı — anonimleştirilmiş prod smoke testinde run + AI denetim + bildirim + Excel + learning_events doğrulandı.

## ADR-011 — QA sertleştirme paketi (fail-closed varsayılanı)
- **Tarih:** 2026-07-10
- **Karar:** (1) `AUTH_SECRET` prod'da zorunlu — yoksa token üretimi/doğrulaması fail-closed; (2) login'e IP başına 5/dk rate-limit; (3) 15 dk'yı aşan `processing` run'lar watchdog'la `error`a çekilir (`resolveStaleRun`); (4) API gövdeleri doğrulanır (bkz. ADR-012 zod); (5) Excel yalnız `done` run'da (409); (6) sayısal hücre girişleri blur-commit (as-you-type Number() coercion'ı yasak — 12.5→125 hatası).
- **Gerekçe:** Teklif-kritik platformda sessiz bozulma kabul edilemez; doğrulanan QA bulguları bu pakette kapatıldı.
- **Sonuç:** Canlı — canlı tarayıcı + prod API testleriyle doğrulandı (2026-07-10).

## ADR-012 — OSS seçimi: TanStack Table + react-virtual + zod + sonner
- **Tarih:** 2026-07-10
- **Karar:** MTO grid'i headless TanStack Table v8 (+ 80+ satırda react-virtual) üzerinde; API doğrulama zod v4 (`src/lib/schemas.ts`); anlık geri bildirim sonner. Reddedilenler: Glide Data Grid (React 19 stabil desteği yok, canvas=tema uyumsuz), react-dropzone (mevcut el yapımı dropzone yeterli), react-number-format (grid'de blur-commit deseni daha güvenli), three.js/NWD önizleme (MTO doğruluğuna katkısı yok, efor L).
- **Gerekçe:** Popülerlik/bakım/React-19 uyumu web araştırmasıyla doğrulandı (2026-07-10); headless yaklaşım bakır/grafit tasarımı birebir korur.
- **Sonuç:** Canlı — sıralama + virtualizasyon + zod 400 yolları prod'da test edildi.

## ADR-013 — Cevap-Excel = ground truth ("uydurma yasak" mimarisi)
- **Tarih:** 2026-07-10
- **Karar:** Metraj sayfasına "⇪ Cevapla karşılaştır": müşteri cevap Excel'i esnek başlık eşlemeyle (TR/EN) okunur, kod+çap anahtarında (hat adları hariç — adlandırma iki tarafta farklı) bizim MAIN satırlarla karşılaştırılır; doğruluk karnesi (`run.answer` jsonb) + `run_feedback` öğrenme olayı. Tolerans: M ±%2 (min 0.1m), EA birebir. Karşılaştırma YALNIZ ölçer — hiçbir rakamı değiştirmez; düzeltme kullanıcının ekran edit'i + "Kalibrasyon olarak kaydet" yoluyla öğrenilir. /calibrations'taki elle profil oluşturma butonları kaldırıldı (profiller yalnız gerçek metrajlardan doğar).
- **Gerekçe:** Teklif = ground truth işi; kullanıcının akışı "hızlıca çıktı → cevabı yükle → farkı gör → düzelt → sistem öğrensin". Rakam üretme yetkisi tek kaynakta (deterministik parser) kalmalı.
- **Sonuç:** Canlı — anonimleştirilmiş cevap fixture'ıyla prod E2E; karne kalıcı, olay günlükte.

---

## Yeni karar şablonu

```markdown
## ADR-NNN — <kısa başlık>
- **Tarih:** YYYY-MM-DD
- **Karar:** <ne yapılıyor — tek cümle, emir kipi>
- **Gerekçe:** <neden bu, neden alternatifler değil — 1-2 cümle>
- **Sonuç:** <durum: Canlı / Kısmen / Bekliyor + ilgili dosya yolları>
```

## ADR-014 — APS bulut çıkarım hattı (yerel kazıyıcı yetmediğinde)
- **Tarih:** 2026-07-20
- **Karar:** Yerel Plant3D string-kazıyıcı yapısal veri bulamaz **ya da boyutsuz** kalırsa (boyutlu oran <%30) dosya Autodesk Platform Services'a gider: OSS upload → Model Derivative çeviri → property koleksiyonu → `lib/parser/aps-extract.ts` (iki aile: Revit/Victaulic + Plant3D-in-DWG + vendor-Insert blokları). Çeviri dakikalar sürdüğü ve Vercel 300sn sınırı olduğu için tamamlama **istemci-güdümlü** `/api/runs/[id]/advance` endpoint'iyle ilerler (ProcessingLive 4sn'de bir ping; watchdog bulut işinde 60dk).
- **Gerekçe:** Format duvarı kanıtlı — Revit NWD'de boru uzunluğu binary parametre (string-kazıma tavanı ≈%78), karışık AutoCAD NWD'de yerel çıkarım çapsız (teklif verilemez). APS her formatı temiz property olarak okur (NWD=0.5 token ≈ ücretsiz kota içinde). Mesh/dumb-solid modelde (`family:'none'`) satır üretilmez — "uydurursa teklif yalan olur" ilkesi bulutta da geçerli.
- **Sonuç:** Canlı — `lib/aps.ts`, `lib/parser/aps-extract.ts`, migration `20260720093000` (runs.aps). Büyük property koleksiyonları streaming allowlist ile okunur; yalnız çıkarımın kullandığı alanlar bellekte tutulur ve tutulan yapısal obje sayısı fail-closed biçimde sınırlandırılır.
