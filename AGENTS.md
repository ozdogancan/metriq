<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Metriq — Proje Kuralları

NWD → MTO metraj platformu (teklif işi için). **Rakam asla uydurulmaz** — motor yalnız
modeldeki yapısal veriden satır üretir; AI'ın rakam yazma yetkisi yok.

## Alan-özel runbook'lar (.claude/skills/ — ilgili işte OKU)
- `metriq-kalibrasyon` — cevap karşılaştırma, 3-modlu tezgâh, kural semantiği
- `metriq-aps` — Autodesk bulut hattı (çeviri/props/aileler/maliyet)
- `metriq-corpus-eval` — gerçek dosyalarda çapraz doğruluk ölçümü
- `metriq-deploy` — deploy zinciri (tsc kapısı → test → push=prod), migration uygulama

## Sabit kurallar
- Deploy = commit + `git push origin main` (otomatik prod). `vercel --prod` KULLANMA.
- tsc/lint/test geçmeden push YOK (PowerShell'de `$LASTEXITCODE` kontrol et, `;` zinciri exit'e bakmaz).
- `_aps/` gitignored: müşteri model/cevap verileri repoya GİRMEZ; secrets transkripte yazılmaz.
- Migration: MCP erişemez → `.env.local` DATABASE_URL + pg script (repo içinden), sonra
  `supabase_migrations.schema_migrations`'a version kaydı ekle.
- UI dili: default EN, TR switch; i18n anahtar eşliği `npm test` içinde denetlenir.
