---
name: metriq-aps
description: Autodesk Platform Services (APS) hattı — çeviri/property akışı, aile reçeteleri, maliyet, bilinen sınırlar. APS, Autodesk, Model Derivative, bulut çıkarım, Revit/DWG NWD işlerinde kullan.
---

# APS Bulut Hattı Runbook

## Akış (üründe)
Yerel parser 0 komponent VEYA boyutlu oran <%30 → `apsSubmit` (OSS signeds3upload +
translate svf) → run.aps{urn} → istemci `/api/runs/[id]/advance` ping'leri (4sn) →
manifest success → guid → properties `?forceget=true` (202=hazırlanıyor, dakikalar) →
`extractFromApsProps` → tamamlama. Watchdog: bulut işinde 60dk (istemci+sunucu).

## Kimlik & maliyet
`APS_CLIENT_ID/SECRET` (.env.local + Vercel prod). 2-legged OAuth v2:
`POST /authentication/v2/token` Basic(id:secret) grant_type=client_credentials.
**NWD çevirisi = 0.5 token/dosya (~$1.5)**, ücretsiz aylık kota ~20 dosya — gereksiz
tekrar çeviri yapma; çevrilen urn'ler yeniden kullanılabilir (`_aps/urns.json`).

## Aile reçeteleri (aps-extract.ts)
- **revit** (ENQ-223): Element.Id dedup → Pipes/Pipe Fittings/Pipe Accessories →
  kod=Custom["Description BOM"] regex → boyut=Element.Size "200-200-100" (max→s1, farklı-min→s2,
  dnToNps) → boru=Element.Length ft×0.3048 → hat=**Vic_Area_PT** (System Name değil!) → DNS→INFO
- **plant3d-dwg** (ENQ-238): Item.Type=ACPPPIPE/ACPPPIPEINLINEASSET (AutoCAD grubu:
  Class/Size=DN/Length mm/Spec/Port*_NominalDiameter) + ACPPCONNECTOR fastener'ları
  (boyutlu GASKET/BOLT SET) + tanınan vendor Insert blokları (PRESS COLLAR→COLLAR,
  SO Flange→BACKING FLANGE, *Valve→MV...) → hat=çizim dosya adı
- **none**: mesh/dumb (SolidWorks/3D Solid) → satır üretilmez, dürüst hata. UYDURMA YOK.

## Bilinen sınırlar / tuzaklar
- Properties yanıtı >100MB → guard dürüst hata verir (ENQ-223 462MB — Vercel OOM önlemi;
  gelecek: properties:query sayfalama). `properties:query` endpoint'i güvenilmez (400/404) — düz GET kullan.
- Advance istemci-güdümlü: sekme kapanırsa iş durur (bilinen sınır; cron ile sertleştirilebilir).
- Yerel deneyde props çekimi: `node _aps/fetchprops.mjs <key> <guid> <out.json>`.
- Çeviri hatası mesajları manifest.derivatives[].messages'ta.
