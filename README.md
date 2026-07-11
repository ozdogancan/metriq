# metriq

**Modelden metraja, saniyeler içinde.** CAD modelini (Navisworks NWD) yükle → doğrulanmış boru + fitting + çelik metrajını gör → müşteri formatında Excel indir.

Motor anonimleştirilmiş gerçek proje fixture'larıyla doğrulanır; müşteri dosya kodları ve miktarlar bu depoda tutulmaz (bkz. `docs/04-calibration-log.md`).

## Özellikler
- 🔩 **NWD ayrıştırma** doğrudan sunucuda — Autodesk hesabı/harici servis gerekmez
- 📏 OD-doğrulamalı boyutlar: ASME B36.10 + DIN 11850-2 (hijyenik metrik TRU-BORE)
- 🧭 Hat-bazlı satırlar (S1…, STEAM MAIN HEADER…), çelik profil metrajı (m + kg)
- 🎛 **Kalibrasyon profilleri**: 45°→90 birleştirme, COLLAR 1:1, refakat flanşı, gross katsayısı, kod eşlemeleri — düzenlemelerden öğrenir
- 📤 Excel (müşteri şemasında), geçmiş, TR/EN arayüz

## Öğrenme döngüsü

Metriq'in çekirdek iddiası metraj çıkarmak değil, **müşteri konvansiyonunu öğrenmektir**. Aynı model iki müşteride iki farklı doğru MTO üretir (çelik tesis ↔ hijyenik gıda hattı); bu farklar koda gömülü değildir — bildirimsel `CalibrationRules` verisidir (`src/lib/types.ts`) ve tek noktadan uygulanır (`applyRules`, `src/lib/vocab.ts`).

Döngünün bugün canlı olan kısmı şöyledir: kullanıcı MTO tablosunda bir satırı düzeltir/ekler/siler → her düzeltme `before/after/context` alanlı bir **`learning_event`** olarak kayda geçer → kullanıcı isterse run'dan elle bir kalibrasyon profili kaydeder. Otomatik desen çıkarma, holdout replay ve güvenli kalibrasyon önerisi henüz yol haritasındadır; olay günlüğü tek başına "öğrenen sistem" sayılmaz.

Aynı olay kayıtları **JSONL** formatında (olay başına tek satır JSON) doğrudan eğitim verisidir: `girdi = context + before`, `hedef = after`. Bu sayede birikim ileride few-shot örnekleri veya fine-tune seti olarak sıfır dönüşümle kullanılabilir. Sözleşmenin tamamı: `docs/02-learning.md`.

## Dokümantasyon (`docs/`)

| Dosya | İçerik |
|---|---|
| [`docs/00-overview.md`](docs/00-overview.md) | Mimari (10 satır) + öğrenme döngüsü diyagramı |
| [`docs/01-methodology.md`](docs/01-methodology.md) | NWD metraj metodolojisi: OD-çifti, GUID-dedup, vokabüler profilleri, çapraz kontroller |
| [`docs/02-learning.md`](docs/02-learning.md) | **Öğrenme sözleşmesi**: `learning_events` şeması, kural türetme rehberi, JSONL ihracı |
| [`docs/03-decisions.md`](docs/03-decisions.md) | Karar günlüğü (ADR-lite) + yeni karar şablonu |
| [`docs/04-calibration-log.md`](docs/04-calibration-log.md) | 3 gerçek vakanın kalibrasyon karnesi + yeni vaka şablonu |

Drift kuralı: dokümanlardaki alan/dosya adları koddan (`src/lib/types.ts`) birebirdir; şema değişikliği doküman + migration ile **birlikte** yapılır.

## Kurulum (5 dakika)
1. **Supabase** → yeni proje aç → CLI ile projeyi bağlayıp `supabase db push` çalıştır (yerel temiz kurulum doğrulaması: `supabase db reset`) → Storage'da **private** `models` bucket'ı oluştur. Kayıtlı şemanın kanonik kaynağı tarih sıralı `supabase/migrations/` dizinidir; `supabase/migration.sql` yalnız eski/manual başlangıçlar için tutulur ve tek başına yeterli değildir.
2. `.env.local` (bkz. `.env.example`): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET=models`.
   `models` bucket private olmalı; `application/octet-stream` dışında MIME kabul etmemeli ve dosya limiti 50 MB olmalı.
3. `npm i && npm run dev` — env yoksa **yerel modda** çalışır (`.data/` klasörü; Vercel'de kalıcı değildir).

## Deploy
Vercel'e bağlıyken: `vercel --prod`. Env değişkenlerini Vercel'e ekle (`vercel env add`).

## Mimari
Next.js App Router (Node runtime) · Supabase (DB+Storage, servis rolü yalnız sunucuda) · exceljs · saf-TS NWD parser (`src/lib/parser/`) — regresyon testleri gerçek dosyalarla. Ayrıntı: `docs/00-overview.md`.
