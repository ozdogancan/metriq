# metriq

**Modelden metraja, saniyeler içinde.** CAD modelini (Navisworks NWD) yükle → doğrulanmış boru + fitting + çelik metrajını gör → müşteri formatında Excel indir.

Motor, üç gerçek proje dosyasıyla kalem-kalem kalibre edildi (bir vakada müşteri cevabıyla **19/19 satır birebir**).

## Özellikler
- 🔩 **NWD ayrıştırma** doğrudan sunucuda — Autodesk hesabı/harici servis gerekmez
- 📏 OD-doğrulamalı boyutlar: ASME B36.10 + DIN 11850-2 (hijyenik metrik TRU-BORE)
- 🧭 Hat-bazlı satırlar (S1…, STEAM MAIN HEADER…), çelik profil metrajı (m + kg)
- 🎛 **Kalibrasyon profilleri**: 45°→90 birleştirme, COLLAR 1:1, refakat flanşı, gross katsayısı, kod eşlemeleri — düzenlemelerden öğrenir
- 📤 Excel (müşteri şemasında), geçmiş, TR/EN arayüz

## Kurulum (5 dakika)
1. **Supabase** → yeni proje aç → SQL Editor'de `supabase/migration.sql`'i çalıştır → Storage'da **private** `models` bucket'ı oluştur.
2. `.env.local` (bkz. `.env.example`): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET=models`.
3. `npm i && npm run dev` — env yoksa **yerel modda** çalışır (`.data/` klasörü; Vercel'de kalıcı değildir).

## Deploy
Vercel'e bağlıyken: `vercel --prod`. Env değişkenlerini Vercel'e ekle (`vercel env add`).

## Mimari
Next.js App Router (Node runtime) · Supabase (DB+Storage, servis rolü yalnız sunucuda) · exceljs · saf-TS NWD parser (`src/lib/parser/`) — regresyon testleri gerçek dosyalarla.
