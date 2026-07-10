// Metriq — metraj detayı iskeleti: sol aşama/özet sütunu + sağ geniş içerik alanı.
// ProcessingTheater / RunDetail yerleşimini yansıtan sade yer tutucu.
export default function Loading() {
  return (
    <section className="panel panel-corners overflow-hidden" aria-busy="true">
      {/* Başlık çubuğu: dosya çipi + durum */}
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
        <span className="pulse block h-[22px] w-44 rounded-full bg-line" />
        <span className="pulse block h-[20px] w-16 rounded bg-line" />
      </div>

      {/* Gövde: sol liste + sağ sahne */}
      <div className="grid gap-6 p-5 md:grid-cols-[248px_minmax(0,1fr)]">
        <div className="space-y-3">
          {[0, 1, 2, 3, 4, 5].map(i => (
            <div key={i} className="pulse h-[14px] rounded bg-line"
              style={{ width: `${88 - i * 7}%`, animationDelay: `${i * 90}ms` }} />
          ))}
        </div>
        <div className="pulse h-[300px] rounded-lg border border-line" style={{ background: 'var(--chip-bg)' }} />
      </div>

      {/* Alt ilerleme çizgisi */}
      <div className="px-5 pb-5">
        <span className="pulse block h-px w-full bg-line" />
      </div>
    </section>
  );
}
