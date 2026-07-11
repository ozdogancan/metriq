# Metriq orchestration roadmap

## Karar

Metriq çok sayıda serbest konuşan ajan değil, **tek merkezli ve durable bir durum
makinesi** kullanacak. Parser ve kural motoru rakamların tek kaynağıdır; AI yalnız
anomali bulur, gerekçe üretir ve insan incelemesini önceliklendirir.

Kaynak fikir: [Yapay Zeka Orkestrası](https://www.linkedin.com/pulse/yapay-zeka-orkestras%C4%B1-emre-ozan-memi%C5%9F-4j0sf/).

## Hedef akış

```text
intake → parse → policy_resolve → deterministic_qa → ai_audit
       → human_review (gerekiyorsa) → approved → export
```

Her aşama idempotent olacak; giriş hash'i, parser/kural sürümü, başlangıç-bitiş
zamanı, çıktı özeti ve hata sınıfı kaydedilecek. Retry aynı sayıları ikinci kez
yazmayacak. Kritik QA veya AI bulgusu `approved` kapısını geçmeden teklif Excel'i
üretemeyecek.

## Sorumluluk sınırları

- **Deterministik çekirdek:** NWD ayrıştırma, sınıflandırma, miktar, birim, toplama.
- **Müşteri politikası:** Sürümlü kalibrasyon; kim onayladı, hangi golden/holdout
  dosyalarında denendi ve hangi sürüme geri dönülebilir bilgisiyle.
- **AI denetçi:** Yalnız belirsiz/aykırı satırları görür; miktar değiştiremez.
- **İnsan kapısı:** Kritik bulgu, düşük güven veya yeni kural önerisinde zorunlu.
- **Operasyon:** Retry, timeout, maliyet bütçesi, alarm ve audit trail.

Vercel Workflow durable yürütme için ana orkestratördür. Küçük n8n sunucusu yalnız
bildirim/operasyon işlerinde kullanılmalı; büyük dosya veya parser verisi n8n'e
taşınmamalı ve eşzamanlılık 2 ile sınırlı kalmalıdır.

## Ölçüm ve öğrenme kapısı

Bir kural yalnız aşağıdakilerin tümü sağlanırsa `proposed` durumundan `active`
durumuna geçebilir:

1. Golden dosyalarda gerileme yok.
2. Holdout dosyalarda precision, recall ve F1 eşikleri geçiliyor.
3. Fazla satırlar da doğruluk paydasına giriyor.
4. M ve EA için miktar hatası ayrı ölçülüyor.
5. Bir kullanıcı öneriyi açıkça onaylıyor; önceki sürüme rollback mümkün.

## Uygulama sırası

1. **Güvenilir temel:** CI, migration zinciri, RLS, upload/outbox, kaynak bütçeleri,
   deterministik QA ve export gate.
2. **Durable pipeline:** `run_steps`, lease/idempotency anahtarları, Vercel Workflow,
   retry/timeout ve gerçek zamanlı ilerleme.
3. **Ölçülebilir öğrenme:** anonim golden/holdout seti, sürümlü politikalar,
   öneri→replay→onay→promote→rollback akışı.
4. **Verim:** dosya-hash + parser-sürümü cache'i; AI yalnız anomali alt kümesinde,
   istek başına süre/token/maliyet bütçesi.

Başarı ölçütü “kaç ajan çalıştı” değil; onaysız kritik export sayısı **0**, aynı
girdinin aynı sürümde aynı çıktıyı verme oranı **%100**, regresyon geçmeden aktif
olan kural sayısı **0** ve manuel inceleme süresinin düzenli düşmesidir.
