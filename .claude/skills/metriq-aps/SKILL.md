---
name: metriq-aps
description: Autodesk Platform Services (APS) hattı — çeviri/property akışı, aile reçeteleri, maliyet, bilinen sınırlar. APS, Autodesk, Model Derivative, bulut çıkarım, Revit/DWG NWD işlerinde kullan.
---

# APS Bulut Hattı Runbook

## Akış (üründe)
Yerel parser yapısal komponent bulamaz veya boyutlu oran <%30 kalırsa `apsSubmit`
çalışır. Vercel Workflow, tarayıcıdan bağımsız olarak manifest durumunu bekler. Manifest
hazır olduğunda DB claim alınır; ardından property gövdesi streaming allowlist ile okunur,
`extractFromApsProps` aileyi ve kanıt kalitesini belirler. Bir saatlik ürün tavanı vardır.
`/api/runs/[id]/advance` yalnız idempotent operasyonel kurtarma endpoint'idir.

## Kimlik ve tekrar güvenliği
`APS_CLIENT_ID/SECRET` yalnız server ortamındadır. İlk çeviri isteği force kullanmaz;
aynı run'ın tekrarında kalıcı URN/claim okunur. Aylık çeviri tavanı `APS_MONTHLY_TRANSLATION_CAP`
ile korunur. Gerçek APS token'ı tarayıcıya verilmez: Viewer istekleri run/tenant sahipliğini
ve URN namespace'ini doğrulayan same-origin proxy'den geçer.

## Aile çıkarıcıları (`aps-extract.ts`)
- **revit-piping:** Element.Id/GlobalId dedup; piping kategorileri; açık BOM tanımı,
  Size ve Length property'leri. Sistem/alan bilgisi yalnız varsa kapsam olarak kullanılır.
- **plant3d-dwg:** ACPPPIPE/ACPPPIPEINLINEASSET/ACPPCONNECTOR ve AutoCAD grubundaki
  Class, Size, Length, port çapları. Insert yalnız fiziksel AutoCAD kanıtı varsa sayılır.
- **inventor-steel / ifc-tekla / generic-cad:** Açık profil, miktar, boyut veya uzunluk
  property'leri varsa çıkarılır; yalnız isim/geometri bulunan nesneler aday olarak gösterilir.
- **unsupported:** Yapısal ölçü/miktar kanıtı yoksa toplam üretilmez. Uydurma yoktur.

## Kalite kapısı
`structured` sonuç teklif adayı olabilir. `partial` sonuç cevap Excel'iyle hedef doğruluğa
ulaşana dek export edilemez. `none` terminal ve açıklamalı hatadır. Confidence, cevapla
ölçülen accuracy değildir.

## Büyük model ve hata davranışı
Property yanıtı tek JSON string'e alınmaz. Akış sırasında yalnız kullanılan alanlar tutulur;
yapısal obje sayısı üst sınırı aşarsa fail-closed hata verilir. Çeviri ve geçici property
hataları durable retry ile ele alınır; terminal manifest mesajları kullanıcıya sadeleştirilir.
