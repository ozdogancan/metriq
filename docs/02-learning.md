# 02 — Öğrenme Sözleşmesi (learning_events)

> Bu dosya Metriq'in **makine öğrenmesine uygunluğunun kalbidir**: her kullanıcı düzeltmesi
> aşağıdaki şemayla kayda geçer; desenler `CalibrationRules` alanlarına deterministik eşlenir;
> aynı kayıtlar JSONL olarak doğrudan eğitim verisidir. Alan adları `src/lib/types.ts`'e sabitlenmiştir —
> şema değişikliği bu dosya + `supabase/migration.sql` ile **birlikte** yapılır (drift kuralı).

## 1. Olay şeması

Her olay tek JSON nesnesidir (DB: `learning_events` tablosu; ihraç: JSONL, olay başına bir satır):

```json
{
  "id": "uuid",
  "runId": "uuid",
  "ts": "iso",
  "kind": "row_edit|row_add|row_delete|calibration_saved|run_feedback",
  "before": {"code": "…", "s1": 3, "s2": 2, "qty": 1, "line": "…", "scope": "MAIN"},
  "after": {"code": "…", "s1": 3, "s2": 2, "qty": 1, "line": "…", "scope": "MAIN"},
  "context": {"vocab": "hygienic", "fileName": "…", "calibrationId": null}
}
```

### Alanlar

| Alan | Tip | Anlam |
|---|---|---|
| `id` | uuid | Olay kimliği |
| `runId` | uuid | `runs.id` — olayın gerçekleştiği çalıştırma |
| `ts` | ISO 8601 | Olay zamanı |
| `kind` | enum | Olay türü (aşağıdaki tablo) |
| `before` | MtoRow alt kümesi \| null | Düzeltme ÖNCESİ satır durumu |
| `after` | MtoRow alt kümesi \| null | Düzeltme SONRASI satır durumu |
| `context.vocab` | `VocabProfileId` | `'steel-plant'` \| `'hygienic'` |
| `context.fileName` | string | Kaynak NWD dosya adı |
| `context.calibrationId` | uuid \| null | Olay sırasında aktif `calibrations.id` (null = DEFAULT_RULES) |

`before`/`after` satır nesnesi `MtoRow`'un öğrenmeye anlamlı alt kümesidir:
`code`, `s1`, `s2`, `qty`, `line`, `scope` (+ gerektiğinde `sub`, `unit`). Alan adları `MtoRow` ile birebirdir.

### Olay türleri (`kind`)

| kind | before | after | Anlam / sinyal |
|---|---|---|---|
| `row_edit` | dolu | dolu | Satır alanı değişti — motor yanlış sınıfladı/boyutladı/kapsamladı |
| `row_add` | null | dolu | Kullanıcı satır ekledi — motor bu kalemi KAÇIRDI |
| `row_delete` | dolu | null | Kullanıcı satır sildi — motor FAZLA saydı / kapsam dışıydı |
| `calibration_saved` | null | kaydedilen `CalibrationRules` anlık görüntüsü | Kural seti onaylandı — bu ana kadarki olaylar "çözüldü" etiketi alır |
| `run_feedback` | null | `{ "rating": 1-5, "note": "…" }` | Çalıştırma-düzeyi serbest geri bildirim |

## 2. Kural türetme rehberi (desen → CalibrationRules alanı)

Öneri motoru olayları `runId` + `context.vocab` bazında gruplar ve şu eşlemeyi uygular.
**Hiçbir kural otomatik yazılmaz — çıktı her zaman ÖNERİdir, kullanıcı onaylar (`calibration_saved`).**

| Gözlenen desen | İşaret ettiği kural | Öneri eşiği |
|---|---|---|
| `row_edit`: `before.code="45 BEND"` → `after.code="90 BEND"` | `merge45Into90: true` | run'daki 45 BEND satırlarının ≥%80'i |
| `row_edit`: `before.code=X` → `after.code=Y` tutarlı biçimde | `codeRenames[X] = Y` | ≥3 olay, çelişkili yön yok |
| `row_delete`: `code` FLANGE-ailesi, satır vana/enstrüman komşuluğunda | `excludeCompanionFlanges: true` | refakat-adayı flanş silmelerinin ≥%80'i |
| `row_edit`: `code ∈ {MV, VALVE, STRAINER}`, `scope: "INFO"` → `"MAIN"` | `includeValvesInMain: true` | vana satırlarının çoğunluğu |
| `row_add`: `code="COLLAR"`, BACKING FLANGE adediyle 1:1 | `collarOneToOne: true` | eklenen COLLAR ≈ BACKING FLANGE sayısı |
| `row_add`: `code ∈ {GASKET, BOLT SET, STUB END}` | `includeFasteners: true` | ≥1 fastener kalemi ana listeye eklendi |
| `row_edit`: `code="PIPE"`, `after.qty / before.qty ≈ k` (sabit) | `grossPipeFactor: k` (medyan oran) | ≥5 PIPE satırı, oran varyasyonu <%5 |
| `row_edit`: yalnız `s1`/`s2` değişiyor | **kural DEĞİL** → parser boyut hatası (OD-çifti/tutarlılık filtresi); parser issue aç |
| `row_edit`: yalnız `line` değişiyor | **kural DEĞİL** → hat-adı çıkarım hatası (dolgu/kara-liste); parser issue aç |

Eşleşmeyen kalıcı desenler `codeRenames`'e düşmüyorsa yeni `CalibrationRules` alanı adayıdır →
önce `03-decisions.md`'ye karar kaydı, sonra `types.ts` + bu dosya birlikte güncellenir.

## 3. Eğitim verisi ihracı (JSONL)

- **Format:** olay başına tek satır JSON (yukarıdaki şema, minified). Dosya: `learning_events.jsonl`.
- **Kaynak:** `learning_events` tablosunun ham dökümü — dönüştürme yok, filtre serbest
  (tipik: `kind IN ('row_edit','row_add','row_delete')`, vocab bazında ayrılmış).
- **Eğitim çifti formülasyonu:**
  - girdi = `context` + `before` (+ istenirse run özeti `RunTotals`)
  - hedef = `after`
- **Few-shot kullanımı:** aynı `context.vocab` profilinden en güncel N olay, prompt'a örnek olarak
  eklenir ("bu müşteri bu deseni böyle düzeltiyor").
- **Etiket hijyeni:** `calibration_saved` sonrası gelen olaylar YENİ kural setine aittir —
  eğitim setinde `context.calibrationId` ile ayrıştırılır (aynı düzeltme deseninin iki kez
  öğrenilmesini önler).
