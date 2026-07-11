'use client';
// Beklenmedik hata — marka kimliği en kötü anda da korunur.
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-6">
      <div className="panel panel-corners max-w-md px-8 py-10 text-center">
        <div className="dimline mx-auto mb-5 w-24" />
        <div className="font-data text-[11px] uppercase tracking-[0.2em] text-copper">hata</div>
        <h1 className="mt-2 text-[19px] font-bold">Bir şeyler ters gitti</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          Beklenmedik bir hata oluştu. Verilerin güvende — metrajlar ve kalibrasyonlar kalıcı depoda.
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <button onClick={reset} className="btn btn-primary">Tekrar dene</button>
          <a href="/" className="btn">Panele dön</a>
        </div>
      </div>
    </div>
  );
}
