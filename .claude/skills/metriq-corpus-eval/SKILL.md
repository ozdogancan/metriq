---
name: metriq-corpus-eval
description: Metriq corpus değerlendirme harness'ı — gerçek dosyalarda çapraz doğruluk ölçümü, deney script kalıpları, APS property çekimi. Doğruluk ölçme, corpus, deney, benchmark işlerinde kullan.
---

# Corpus Değerlendirme Runbook

## Corpus
Gerçek model/cevap dosyaları repoya girmez. Harness, anonim vaka manifestini ve yalnız
yerel environment köklerini kullanır. Corpus kökü `METRIQ_CORPUS_ROOT`, APS property
snapshot kökü `METRIQ_CORPUS_PROPS_ROOT` ile verilir. Opsiyonel harici vaka çiftleri
manifestte tanımlanan env değişkenlerinden gelir.

## Deney script'i çalıştırma (server-only guard bypass)
```
cd C:\Users\canoz\metriq
npm run corpus:replay
npm run corpus:gate
```
Replay rapor üretir; gate desteklenen holdout vakalarda hedef precision/recall/F1
koşullarını uygular. Gate başarısızsa %90 iddiasıyla release yapılmaz.

## Hazır script'ler
- `scripts/replay-metriq-corpus.mjs` — ürün döngüsü replay ve release gate
- `scripts/check-answer-compare.mjs` — cevap adapter/matching regresyonları
- `scripts/check-aps-extract.mjs` — sentetik aile ve fail-closed regresyonları
- `scripts/analyze-aps-overlap.mjs` — model kanıtı ile cevap kapsamı arasındaki doğal tavan analizi

## Ölçüm dürüstlüğü
1. Önce cevabı ELLE doğrula (kod toplamları mantıklı mı) — parseAnswerXlsx her şablonu doğru okumaz.
2. Fark büyükse önce CEVABIN kapsamına bak (Area/GA kolonu) — model-dışı insan ekleri
   (RFI, "All" götürüleri, PIPE CUT) doğal tavandır, bunlara tune ETME.
3. Birebir eşleşen boyut bantları motorun doğru olduğunun kanıtıdır; kalan farkın
   sebebini sınıflandır: revizyon farkı / kapsam / vokabüler / gerçek bug.
4. Yeni dosya yeni bir model ailesi/vokabüler olabilir → önce şema kanıtını incele,
   sonra genel extractor veya onaylı profil kuralı ekle. Dosya adına özel branch ekleme.
