// 404 — teknik-çizim kimliğiyle.
import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-6">
      <div className="panel panel-corners max-w-md px-8 py-10 text-center">
        <div className="dimline mx-auto mb-5 w-24" />
        <div className="font-data text-[11px] uppercase tracking-[0.2em] text-copper">404</div>
        <h1 className="mt-2 text-[19px] font-bold">Sayfa bulunamadı</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          Aradığın metraj silinmiş ya da bağlantı hatalı olabilir.
        </p>
        <div className="mt-6">
          <Link href="/" className="btn btn-primary">Panele dön</Link>
        </div>
      </div>
    </div>
  );
}
