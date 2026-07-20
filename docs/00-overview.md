# 00 — Genel Bakış

> Metriq: CAD modelinden (Navisworks NWD) doğrulanmış boru + fitting + çelik metrajı (MTO) üreten,
> kullanıcı düzeltmelerinden **öğrenen** platform. Bu doküman seti makine-okunur olacak şekilde
> yapılandırılmıştır: alan adları koddan (`src/lib/types.ts`) birebir alınır, serbest prose minimumdur.

## Platform ne yapar

| Adım | Bileşen | Girdi → Çıktı |
|---|---|---|
| 1. Yükle | `src/app/api/upload-url/route.ts`, `src/components/upload-zone.tsx` | NWD dosyası → Storage (`models` bucket / `.data/files`) |
| 2. Ayrıştır | `src/lib/parser/nwd.ts` — `parseNwd(buf)` | NWD → `ParseResult { components, steelMembers, fasteners, stats }` |
| 2b. Bulut çıkarım | `src/lib/aps.ts` + `src/lib/parser/aps-extract.ts` | Yerel parser 0-komponent/boyutsuz ise Autodesk APS: NWD → çeviri → property → `MtoRow[]` (Revit/Plant3D-DWG aileleri) |
| 3. Kural uygula | `src/lib/vocab.ts` — `applyRules(parsed, rules)` | `ParseResult` + `CalibrationRules` → `MtoRow[]`, `SteelRow[]`, `RunTotals` |
| 4. Düzelt | `src/components/run-detail.tsx` | Kullanıcı satır düzenler (`MtoRow.edited=true`) → `learning_event` |
| 5. Öğren | Kalibrasyon katmanı (`src/app/(app)/calibrations`) | learning_events deseni → `CalibrationRules` önerisi → onay → `Calibration` kaydı |
| 6. Teslim | `src/lib/excel.ts`, `/api/runs/[id]/excel` | Müşteri şemasında Excel (exceljs) |

## Mimari (10 satır)

1. **Next.js App Router** (Node runtime), TS strict — tek repo, tek deploy (Vercel).
2. **Oturum kapısı**: `src/proxy.ts` (Next proxy, Web Crypto) — her rota varsayılan korumalı.
3. **Auth**: `src/lib/auth.ts` — HMAC imzalı cookie (`metriq_session`), kullanıcılar `AUTH_USERS` env.
4. **Depolama**: `src/lib/store.ts` — Supabase (prod) / `.data` yerel JSON (dev fallback), `isSupabase` bayrağı.
5. **Parser**: `src/lib/parser/nwd.ts` — saf-TS NWD ayrıştırma; sözleşme sabit (`ParsedComponent`, `ParseResult`).
6. **Kural motoru**: `src/lib/vocab.ts` — `CalibrationRules`'u bildirimsel uygular (tek nokta).
7. **Tipler**: `src/lib/types.ts` — `MtoRow`, `Calibration`, `CalibrationRules`, `Run`; **tüm dokümanlar bu adlara sabitlenir**.
8. **DB şeması**: `supabase/migrations/` (tarih sıralı, `supabase db reset` ile yeniden kurulabilir) — `runs`, `mto_rows`, `steel_rows`, `calibrations` (+ `learning_events`, bkz. `02-learning.md`).
9. **AI katmanı**: `/api/runs/[id]/insight` — Gemini Flash özeti (opsiyonel, `GEMINI_API_KEY`).
10. **i18n**: `src/lib/i18n.ts` — TR/EN.

## Bulut çıkarım yolu (APS) — 2026-07-20

Yerel string-kazıyıcı yalnız AutoCAD Plant3D exportlarını okur. Yapısal veri **yoksa**
(Revit MEP) veya **boyutsuz** kalırsa (karışık AutoCAD, boyutlu oran <%30) run otomatik
Autodesk Platform Services'a düşer: OSS upload → Model Derivative çeviri (asenkron,
dakikalar) → property koleksiyonu → `extractFromApsProps`. Çeviri Vercel 300sn sınırını
aştığı için tamamlama **istemci-güdümlü** `/api/runs/[id]/advance` ile ilerler (ProcessingLive
4sn ping + 60dk watchdog; DB-seviyesi `claimApsRun` çift-tamamlamayı önler).

İki yapısal aile (`aps-extract.ts`): **revit** (Element.Category + `Custom["Description BOM"]`,
hat=Vic_Area_PT) ve **plant3d-dwg** (Item.Type=ACPP*, hat=çizim adı). Mesh/dumb-solid
modellerde (`family:'none'`) satır üretilmez — **asla uydurma yok**. Öğrenilmiş profil
bulut yolunda da otomatik uygulanır (`advance/resolveRules`).

## Öğrenme döngüsü

```
        ┌────────────────────────────────────────────────────────────┐
        │                                                            │
        ▼                                                            │
  NWD yükle ──► parseNwd() ──► applyRules(CalibrationRules) ──► MtoRow[] tablosu
                                        ▲                            │
                                        │                            ▼
                                 YENİ KURAL SETİ            kullanıcı düzeltir
                              (Calibration kaydı)          (edit / add / delete)
                                        ▲                            │
                                        │ onay                       ▼
                              kalibrasyon önerisi ◄──── learning_event kaydı
                              (desen analizi,            (before/after/context,
                               bkz. 02-learning.md)       JSONL)
```

Döngünün sözleşmesi: her kullanıcı düzeltmesi bir `learning_event` üretir; olay desenleri
`CalibrationRules` alanlarına eşlenir (`02-learning.md`); onaylanan kural seti bir sonraki
`applyRules` çağrısında otomatik uygulanır. **Model hiçbir kuralı kendiliğinden değiştirmez —
onay adımı zorunludur.**

## Doküman haritası

| Dosya | İçerik |
|---|---|
| `00-overview.md` | Bu dosya — mimari + öğrenme döngüsü |
| `01-methodology.md` | NWD metraj metodolojisi (platforma uyarlanmış özet) |
| `02-learning.md` | **Öğrenme sözleşmesi**: `learning_events` şeması + kural türetme rehberi + JSONL ihracı |
| `03-decisions.md` | Karar günlüğü (ADR-lite) |
| `04-calibration-log.md` | Gerçek vaka kalibrasyon karnesi + yeni vaka şablonu |
