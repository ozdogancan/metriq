---
name: metriq-kalibrasyon
description: Metriq kalibrasyon/doğruluk çalışması — cevap-Excel karşılaştırma, 3-modlu tezgâh, kural semantiği, doğruluk ölçüm disiplini. Kalibrasyon, doğruluk, cevap karşılaştırma, profil, accuracy konularında çalışırken kullan.
---

# Metriq Kalibrasyon Runbook

## Altın kural
**Rakam ASLA uydurulmaz** ("uydurursa teklif yalan olur"). Motor yalnız modeldeki yapısal
veriden satır üretir. Cevap dosyasındaki RFI/götürü/PIPE CUT gibi insan ekleri motorun
üretemeyeceği kalemlerdir — bunlar doğruluk hedefine DAHİL EDİLMEZ, karşılaştırmada
kullanıcıya ayrıca gösterilir.

## Üç kalibrasyon modu (kullanıcının istediği akış)
1. **Toplu kabul**: "Cevabın tamamını kabul et" — tüm farklar cevap değerine çekilir.
2. **Tek tek**: her fark satırında [Biz | Cevap | Özel] pill'leri.
3. **Özel değer**: iki tarafın dışında elle değer girme.
Sonra "Kalibre et ve öğren" → `/api/runs/[id]/answer/apply` → satırlar güncellenir +
`deriveCalibrationRules` profil üretir → sonraki dosyalara otomatik uygulanır.

## Kural semantiği (CalibrationRules)
- `vocab`: steel-plant | hygienic (otomatik algılanır, detectVocab)
- `collarOneToOne`: açıkça seçilmiş profilde destek halkası/collar türetme davranışı
- `includeFasteners`: conta/cıvata MAIN listede mi (kapalıysa INFO'da boyutlu satır olarak DURUR, kaybolmaz)
- `excludeLines`: kapsam-dışı hatlar (satır silinmez, INFO'ya iner) — Revit'te hat=Vic_Area_PT, P3D-DWG'de hat=çizim-adı
- `itemCorrections`: kabul edilen kararlardan öğrenilen kesin imza eşlemeleri
  (code+s1+s2+unit[+line+sub]); `candidate/active/rejected` yaşam döngüsü vardır.
- Geniş etkili kurallar iki bağımsız run kanıtı biriktirmeden `active` olmaz. Hat/alt-tip
  bağlamlı dar kurallar bir açık kullanıcı kararıyla etkinleşebilir.
- `codeRenames`: yalnız mevcut onaylı legacy/genel eşlemeler; yeni tek örnekler buraya
  doğrudan yazılmaz. `grossPipeFactor`: net→brüt boru çarpanı.

## Doğruluk ölçüm disiplini
- Karne = `compareAnswer` (kod+çap+birim anahtarı; M ±%2, EA birebir). Bu bir
  **karşılaştırma metriğidir**, "model doğruluğu" değil — cevabı kabul edip aynı cevapla
  karşılaştırmak %100 çıkarır, bu öğrenme kanıtı DEĞİLDİR.
- Gerçek kanıt = **çapraz dosya**: bir dosyada öğren, BAŞKA dosyada ölç (corpus runbook:
  `metriq-corpus-eval` skill).
- Release kanıtı = corpus'ta bağımsız holdout dosyaların precision, recall, F1 ve miktar
  örtüşmesi. Tek bir dosyada cevapları kabul ederek oluşan %100 yalnız o run'ın düzeltilmiş
  karne sonucudur; gelecek dosya doğruluğu iddiası değildir.

## Cevap şablonları
- **Master şablonu:** başlık satırı
  "Material Code / Size 1 (mm) / Size 1 (inch) / Quantity / Qty. Units" → parseAnswerXlsx tanır.
- **Row ID ve BOM şablonları:** tekrar eden kolon blokları, çoklu sheet, DN+Description
  BOM ve legacy `.xls` adapter'ları desteklenir. Tanınmayan şablon fail-closed hata verir.
