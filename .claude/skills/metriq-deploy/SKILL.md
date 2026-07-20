---
name: metriq-deploy
description: Metriq deploy ve migration disiplini — commit+push zinciri, tsc kapısı, canlı doğrulama, Supabase migration uygulama. Deploy, yayınlama, migration, prod işlerinde kullan.
---

# Metriq Deploy Runbook

## Deploy zinciri (SIRASI ÖNEMLİ)
1. `npx tsc --noEmit` — **KAPI: exit 0 değilse push YOK** (PowerShell `;` zinciri exit'e bakmaz, `if ($LASTEXITCODE -eq 0)` kullan!)
2. `npm run lint` (0 error; TanStack react-hooks uyarısı bilinen/kabul)
3. `npm test` (test:answer `--conditions=react-server` ile çalışır — script'i elle çağırma, npm üzerinden koş)
4. `git add -A && git commit && git push origin main` → **main push = otomatik prod deploy** (Vercel Git entegrasyonu)
5. Deploy'u canlıda doğrula (aşağıda) — kullanıcıya sormadan otomatik yap ve haber ver.

## Kritik kurallar
- **`vercel --prod` KULLANMA** — working tree'yi deploy eder, git-deploy'la yarışır, değişiklik prod'dan düşebilir. Kalıcılık = commit+push.
- Push kimliği: sandbox GCM prompt edemez → repo config'de `credential.username=ozdogancan` ayarlı (bir kez `git config credential.username ozdogancan`).
- Prod URL: https://metriq-seven.vercel.app (alias: metriq-ozdogancans-projects.vercel.app)
- `_aps/` klasörü gitignored — müşteri model verileri (NWD/props/cevap) ASLA repoya girmez.

## Migration uygulama (MCP Supabase erişemez!)
`.env.local`'deki DATABASE_URL ile repo İÇİNDEN pg script'i (paket çözümü için):
```js
// _aps/apply-*.mjs kalıbı: pg.Client({ connectionString, ssl: { rejectUnauthorized: false } })
```
Migration SQL'i `supabase/migrations/YYYYMMDDHHMMSS_ad.sql` olarak yaz, script'le uygula,
information_schema'dan doğrula. Uyguladıktan sonra `supabase_migrations.schema_migrations`
tablosuna version kaydını da ekle (yoksa ileride `db push` çakışır).

## Canlı doğrulama
- Yeni route eklendiyse: eski build'de 404 / yenide 401 dönen bir probe ile bekle.
- Route değişmediyse: ~4 dk sabit bekleme sonra fonksiyonel smoke.
- Prod E2E kalıbı: `_aps/e2e-cloud.mjs` (login→signed upload→run→advance döngüsü;
  `METRIQ_E2E_PASSWORD` env değişkeni ister, parola dosyada tutulmaz).
- Test run'ı bittikten sonra `_aps/cleanup-run.mjs <uuid>` ile prod'dan temizle.
