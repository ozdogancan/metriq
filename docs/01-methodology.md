# 01 — Metraj Metodolojisi (NWD, platforma uyarlanmış)

> **Kaynak (tam runbook):** `C:\Users\canoz\dwg-takeoff\METODOLOJI.md` — üç gerçek müşteri
> vakasıyla doğrulanmış prosedür. Bu dosya onun NWD bölümünün Metriq'e uyarlanmış özetidir.
> Çelişki durumunda kaynak runbook + `src/lib/types.ts` kazanır.

## Çıktı sözleşmesi (müşteri formatı — değiştirilmez)

| Material Code | Size 1 (inch) | Size 2 (inch) | Quantity | Qty. Units | Comments |
|---|---|---|---|---|---|

- Boyutlar **nominal inç (NPS)**, mm-OD değil. `MtoRow.s1` / `s2` bu değeri taşır (`s2=0` = tek boyut).
- `PIPE` → **M** (merkez hattı metre); diğer her şey → **EA**. (`MtoRow.unit`)
- Redüksiyon = büyük×küçük; tee/olet = header×branch (branch ≤ header, tersse SWAP).
- **Comments = hat adı** (`MtoRow.line`) — metraj HAT-BAZLIDIR.
- **Kanıtsız kalem eklenmez**; çıkarılamayan `?`/remark ile işaretlenir.

## Boyut kuralı: OD-çifti (en kritik ders)

1. NWD'deki isimli `Size` alanına **GÜVENİLMEZ** — SCH 40/80 değeri DN sanılır (26010'da 1.5"/3" ~50 m şişti).
2. Doğru boyut = özellik akışındaki **bitişik (OD-float, DN-int) çifti**. Noktasız sayılar dahil (`'73'` → 2.5").
3. **Tutarlılık filtresi**: OD→NPS tablosu ile DN-int **aynı** boyuta çıkmalı; çıkmıyorsa boyut atanmaz.
4. İki OD tablosu var, otomatik denenir (`ParsedComponent.metric` bayrağı):

| Seri | Standart | OD→NPS örnekleri |
|---|---|---|
| Çelik (steel-plant) | ASME B36.10 | 21.3=½", 60.3=2", 88.9=3", 114.3=4" |
| Hijyenik metrik (hygienic) | DIN 11850-2 / EN 10357 (TRU-BORE) | 19=½", 23=¾", 29=1", 35=1¼", 41=1½", 53=2", 70=2½", 85=3", 104=4", 129=5", 154=6", 204=8", 254=10" |

`"METRIC TRU-BORE ... EN 10253-4 304L"` görülüyorsa hijyenik seri geçerlidir (içki/gıda tesisi ürün hatları).

## GUID-dedup

- Komponent başlangıcı: sınıf değeri (`Pipe`, `Elbow`, `Flange`, `Valve`, `Tee`, `Reducer`, ...) + bir sonraki değer GUID.
- Aynı parça birden çok zlib blob'unda tekrarlanır → **GUID ile tekilleştir** (`ParseResult.stats.uniqueComponents`).
- Çelik member dedup anahtarı = (profil, boy, koordinatlar); kayıt deseni `Member <PROFİL> x <BOY_mm>`, sınıf `ACPPSTRUCTUREBEAM`.
- Hat adı: named Line Number → aile düzeyi; hatsız komponente akış-sırası dolgusu (önceki komponentin hattı).
  Kısa hat kodları (`^S\d{1,2}$` tam eşleşme) hat adıdır; `SS01` gibi spec kodlarıyla karıştırma.

## Vokabüler profilleri (`VocabProfileId`)

**META-KURAL:** kapsam ve vokabüler MÜŞTERİYE ve sistem tipine göre değişir — müşterinin en güncel
şablonu aynalanır; her şey çıkarılır, hiçbir veri atılmaz (ana liste dışı kalanlar `scope='INFO'`).

| Konu | `steel-plant` (26010 buhar) | `hygienic` (26113 gıda/içki) | İlgili kural alanı |
|---|---|---|---|
| Kapsam | bulk piping 8 kod: PIPE, 90 BEND, RED TEE, EQ TEE, CON RED, FLANGE(+alt tip), BLIND FLANGE, WELDOLET | her şey ana listede (aşağıdaki farklarla) | — |
| 45° dirsek | 90 BEND'e birleşir, detay Remark'ta | aynı | `merge45Into90=true` |
| Flanş | `FLANGE` + alt tip (WELD NECK / SLIP ON / SCREWED) | `BACKING FLANGE` + `COLLAR` **ayrı sayılır (1:1)** | `collarOneToOne` |
| Refakat flanşı (vana/enstrüman ±2 komşu) | bulk **DIŞI** → INFO | **dahil** | `excludeCompanionFlanges` |
| Vana/süzgeç | INFO sayfası (`VALVE`/`STRAINER`) | ana listede tek kod `MV` (tip Comments'e) | `includeValvesInMain` |
| Redüksiyon | `CON RED` (ECC remark'ta) | `CON RED` + `ECC RED` **ayrı kod** | vocab'a gömülü |
| Conta/cıvata/stub-end | hariç (bilgi) | hariç (bilgi) | `includeFasteners=false` |
| PIPE net/gross | model NET kesim; müşteri GROSS merkez hattı (~×1.18) | net kesim gerçekle %99.4 uyumlu → 1.0 | `grossPipeFactor` |
| Boyutsuz flanş | — | **eleme yöntemiyle** atanır (hangi boyut eksikse o) | — |

Not: net/gross farkı **evrensel değildir**, takeoff yapana göre değişir → `grossPipeFactor` müşteri başına öğrenilir.

## Zorunlu çapraz kontroller (uymuyorsa yayınlanmaz)

| # | Kontrol | Beklenti |
|---|---|---|
| 1 | Sınıf sayısı = kod toplamı | `Elbow` = 90 BEND + 45 BEND; `Valve` = vana kodları; `Tee` = EQ TEE + RED TEE; `Reducer` = CON RED + ECC RED |
| 2 | Fastener dengesi | GASKET ≈ BOLT SET; STUB END ≈ BACKING FLANGE (lap-joint sistemde) |
| 3 | Boyut tutarlılığı | her satırda OD→NPS = DN-int (tutarlılık filtresi geçmiş olmalı) |
| 4 | Çelik birim ağırlık | kg/m profil kataloğuyla tutmalı (ör. UKPFC100x50x10 = 10.2 kg/m) |
| 5 | Adet kaynağı ≠ boyut kaynağı | aynı veriden iki kez türetme yok |
| 6 | Şüpheli sinyal taraması | bir boyutta boru var ama hiç fitting yok (veya tersi); OD standart tabloya oturmuyor; toplam merkez hattından %20+ sapıyor |

## Modelden üretilemeyenler (dürüstlük kuralları)

- `WELDOLET` modelde komponent değildir — müşteri spec ile ekler; "branş bağlantıları spec'e göre weldolet olabilir" notu düşülür.
- Fluid kolonu konmaz (spec'siz bilinemez); malzeme desc'te varsa (A105/A106/WPB=karbon, 304L/316L=paslanmaz) Remark'a yazılabilir.
- Kapsam-dışı hatlar (müşteri listesinde olmayan aileler) ayrı gösterilir, ana toplama katılmaz.
