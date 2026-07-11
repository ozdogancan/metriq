# 04 — Kalibrasyon Karnesi

> Güvenlik kuralı: müşteri adı, proje/dosya kodu, gerçek miktar, yerel dosya yolu,
> run kimliği ve cevap dosyası bu depoya yazılmaz. Ayrıntılı golden fixtures özel
> test deposunda tutulur; burada yalnız anonimleştirilmiş sonuç özeti yer alır.

## Anonim doğrulama özeti

| Vaka | Sistem | Kontrol | Sonuç |
|---|---|---|---|
| A | Endüstriyel borulama | NWD → deterministik MTO → müşteri cevabı | Sabit kalemler yüksek uyum; kalan farklar müşteri kapsam politikası olarak sınıflandırıldı |
| B | Hijyenik borulama | NWD → deterministik MTO → müşteri cevabı | Golden fixture üzerindeki kod, boyut ve miktar beklentileri geçti |

Bu kayıt bir pazarlama doğruluk yüzdesi değildir. Her parser/policy değişikliği özel
golden + holdout suite üzerinde yeniden oynatılmalı; yalnız aynı fixture üzerinde
kalibrasyon ve değerlendirme yapılmamalıdır.

## Yeni vaka şablonu

```markdown
## Vaka <anonim-id>

- Tarih: YYYY-MM-DD
- Fixture hash: <sha256; dosya adı yok>
- Parser/policy sürümü: <version>
- Golden mı, holdout mı: <golden|holdout>
- Satır coverage / precision / F1: <değerler>
- M ve EA miktar hatası: <ayrı değerler>
- Unknown-size oranı: <değer>
- Sonuç: <pass|review|required|fail>
- Sapma sınıfı: <parser_error|customer_policy|project_scope|one_off>
```
