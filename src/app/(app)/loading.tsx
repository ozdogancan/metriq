// Metriq — panel (dashboard) iskeleti: veri gelirken düzeni koruyan sade yer tutucu.
// Mevcut tasarım diliyle: panel sınıfları, dimline başlık, pulse animasyonu.
export default function Loading() {
  return (
    <div className="space-y-8" aria-busy="true">
      {/* Yükleme bölümü */}
      <section>
        <div className="dimline mb-6">
          <span className="pulse block h-[22px] w-40 rounded bg-line" />
        </div>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            {[0, 1, 2].map(i => (
              <div key={i} className="panel pulse h-[42px]" style={{ animationDelay: `${i * 100}ms` }} />
            ))}
          </div>
          <div className="panel panel-corners pulse min-h-[190px]" />
        </div>
      </section>

      {/* Geçmiş metrajlar bölümü */}
      <section>
        <div className="dimline mb-6">
          <span className="pulse block h-[17px] w-48 rounded bg-line" />
        </div>
        <div className="space-y-2">
          {[0, 1, 2].map(i => (
            <div key={i} className="panel pulse h-[64px]" style={{ animationDelay: `${i * 120}ms` }} />
          ))}
        </div>
      </section>
    </div>
  );
}
