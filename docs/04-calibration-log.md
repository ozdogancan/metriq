# 04 — Kalibrasyon Karnesi (gerçek vakalar)

> Motorun gerçek müşteri cevaplarıyla kalem-kalem uzlaştırıldığı vakaların kaydı.
> Kaynak: `C:\Users\canoz\dwg-takeoff\METODOLOJI.md` (tam ayrıntı orada). Yeni vaka = alttaki şablon.

## Vaka 1 — 26010-PIP-MOD-001 (buhar, `steel-plant`, NWD)

- **Uzlaştırma tarihi:** 2026-07-09 (müşteri `Metraj.xlsx` cevabıyla kalem-kalem)
- **Kapsam:** bulk piping MTO, 8 kod; vana/enstrüman/destek/fastener → INFO sayfası

| Kod | Müşteri (doğru cevap) | Motor (v3) | Uyum / açıklama |
|---|---|---|---|
| PIPE | 221.7 M (gross; net 186.8) | 186.8 M net | ✓ net birebir; gross = net × ~1.18 (`grossPipeFactor`) |
| 90 BEND | 173 | 180 | ~%96 — 45°→90 birleşimi ½"de 85=85 birebir doğrulandı |
| FLANGE | 152 (WN 79 + SLIP ON 69 + BACKING 4) | 148 | ~%97 — refakat-flanşı kuralıyla 151/152'ye kadar çıkıldı |
| RED TEE | 64 | 57 | %89 — spec/konvansiyon farkı |
| EQ TEE | 9 | 11 | konvansiyon farkı |
| CON RED | 35 | 37 | ✓ |
| WELDOLET | 14 | modelde yok | üretilemez — müşteri spec ile ekler (not düşülür) |
| BLIND FLANGE | 3 | — | müşteri referansı |

- **Türetilen kurallar:** `merge45Into90=true`, `excludeCompanionFlanges=true`, `includeValvesInMain=false`, `grossPipeFactor≈1.18` (gross istenirse) → `DEFAULT_RULES['steel-plant']`
- **Çapraz kontrol referansı:** 2381 tekil komponent; GASKET 225 ≈ BOLT SET 222 ✓; STUB END 196.

## Vaka 2 — 26113 (hijyenik gıda/içki, `hygienic`, NWD) 🏆

- **Uzlaştırma tarihi:** 2026-07-09
- **Sonuç:** **19/19 satır TAM eşleşme** — motorun en güçlü doğrulaması

| Ölçüt | Sonuç |
|---|---|
| MTO satırları | 19/19 birebir (kod + boyut + adet) |
| PIPE | net kesim, gerçekle **%99.4** uyum → bu müşteride `grossPipeFactor=1.0` |
| Çelik profil | 49 adet UKPFC100x50x10 = 62.39 m / 636.3 kg (kg/m katalog kontrolü ✓) |
| Boyut serisi | DIN 11850-2 / EN 10357 (TRU-BORE) otomatik tanındı |

- **Türetilen kurallar (hijyenik vokabüler):** `collarOneToOne=true` (BACKING FLANGE + COLLAR 1:1 ayrı sayılır), `includeValvesInMain=true` (`MV` kodu, filtre/süzgeç dahil), ECC RED ayrı kod, `excludeCompanionFlanges=false` → `DEFAULT_RULES['hygienic']`
- **Meta-ders:** kapsam/vokabüler müşteri + sistem tipine göre değişir; net/gross farkı evrensel değil.

## Vaka 3 — Vat49-31 (dumb-3D DWG, YOL A — NWD dışı, metodoloji kalibrasyonu)

- **Uzlaştırma:** müşteri doğruladı ("New C Line Vat49-31 Transfer to B Line Filling Rev 1", tümü 3")

| Kod | Doğrulanan gerçek |
|---|---|
| PIPE 3" | 36.7 M (0.6 EA anomali satırı ayrı) |
| 90 BEND 3" | 3 EA |
| CON RED 3×2 | 1 EA |
| WELDOLET 3×3 | 1 EA |
| Flanş / vana | YOK |

- **Not:** Metriq v1 kapsamı NWD'dir; bu vaka metodolojinin (nominal-inç dili, kanıtsız kalem yasağı, YAKLAŞIK etiketi) genel kalibrasyonunu sağlar.

---

## Yeni vaka şablonu

```markdown
## Vaka N — <vaka kodu> (<sistem tipi>, `<vocab>`, <dosya tipi>)

- **Uzlaştırma tarihi:** YYYY-MM-DD
- **Kaynak dosya:** <fileName> · **Run:** <runId> · **Kalibrasyon:** <calibrationId>
- **Müşteri referansı:** <Metraj.xlsx / cevap maili / vb.>

| Kod | Müşteri (doğru cevap) | Motor | Uyum / açıklama |
|---|---|---|---|
| ... | ... | ... | ... |

- **Türetilen kurallar:** <CalibrationRules alan değişiklikleri — 02-learning.md eşlemesiyle>
- **Sapma nedenleri:** <konvansiyon / spec / parser hatası — parser hatasıysa issue linki>
- **learning_events:** <bu run'daki olay sayısı; JSONL ihracına dahil edildi mi>
```
