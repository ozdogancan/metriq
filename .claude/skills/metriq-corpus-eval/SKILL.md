---
name: metriq-corpus-eval
description: Metriq corpus değerlendirme harness'ı — gerçek dosyalarda çapraz doğruluk ölçümü, deney script kalıpları, APS property çekimi. Doğruluk ölçme, corpus, deney, benchmark işlerinde kullan.
---

# Corpus Değerlendirme Runbook

## Corpus
`C:\Users\canoz\AppData\Local\Temp\metriq-corpus\New folder (2)\` — 8-9 gerçek model+cevap
çifti (kaynak: Desktop'taki "Model & Metraj.zip"). Temp silinirse zip'ten yeniden aç.
- ENQ-223: 32MB Revit/Victaulic + Metraj.xlsx (Row-ID şablonu) — props: `_aps/enq223-props.json` (462MB!)
- ENQ-238: Grissan karışık AutoCAD + "Grissan GR-0166 MTO_rev02.xlsm" (Master şablonu)
- ENQ-268: WG&S SolidWorks mesh (yapısal veri YOK — dürüst-hata vakası)
- Bekleyen: ENQ-129 (124MB), ENQ-133, ENQ-228, Aberlour (çelik), ENQ-237 (.xls legacy)

## Deney script'i çalıştırma (server-only guard bypass)
```
cd C:\Users\canoz\metriq
node --experimental-strip-types --import ./_aps/reg.mjs _aps/<script>.mts
```
`reg.mjs+hooks.mjs`: 'server-only'→boş modül + uzantısız TS importlarına .ts dener.
pg gerektiren script'ler repo İÇİNDEN koşmalı (paket çözümü). Scratchpad'den koşarsan
`Cannot find package` alırsın.

## Hazır script'ler (_aps/, gitignored)
- `product-loop.mts` — ÜRÜN döngüsü ölçümü: aps-extract × parseAnswerXlsx × compareAnswer
  (kullanıcının tezgâhta göreceği karne). `PROFILE=grissan` env'i collarOneToOne+fasteners açar.
- `exp5.mts` — GA-bazlı kapsama tablosu (hangi cevap bölümü modelle örtülü)
- `inspect.mjs/inspect2.mjs` — yeni props dosyasının yapı sondajı (aile tespiti)
- `submit.mjs / status.mjs / fetchprops.mjs` — APS yükle/çevir/props çek (202→dakikalar→200)
- `smoke-extract.mts` — üç aile regresyonu (238=plant3d-dwg, 223=revit, 268=none)

## Ölçüm dürüstlüğü
1. Önce cevabı ELLE doğrula (kod toplamları mantıklı mı) — parseAnswerXlsx her şablonu doğru okumaz.
2. Fark büyükse önce CEVABIN kapsamına bak (Area/GA kolonu) — model-dışı insan ekleri
   (RFI, "All" götürüleri, PIPE CUT) doğal tavandır, bunlara tune ETME.
3. Birebir eşleşen boyut bantları motorun doğru olduğunun kanıtıdır; kalan farkın
   sebebini sınıflandır: revizyon farkı / kapsam / vokabüler / gerçek bug.
4. Yeni dosya = yeni müşteri vokabüleri olabilir → önce inspect, sonra eşleme.
