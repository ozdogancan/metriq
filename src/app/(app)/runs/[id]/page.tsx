import { cookies } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getRun, getRows, getSteel, listCalibrations } from '@/lib/store';
import type { Lang } from '@/lib/i18n';
import { RunDetail } from '@/components/run-detail';
import { ProcessingLive } from '@/components/processing-live';

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await getRun(id);
  if (!run) notFound();
  const store = await cookies();
  const lang = (store.get('lang')?.value === 'en' ? 'en' : 'tr') as Lang;

  // işleniyor → canlı pipeline tiyatrosu (poll eder, bitince detaya geçer)
  if (run.status === 'processing') {
    return <ProcessingLive lang={lang} initial={run} />;
  }

  // hata → boş grid yerine açık hata paneli
  if (run.status === 'error') {
    return (
      <div className="rise panel panel-corners mx-auto max-w-xl px-6 py-8 text-center">
        <div className="text-[28px]">⚠</div>
        <h1 className="mt-2 text-[18px] font-bold tracking-tight">
          {lang === 'tr' ? 'Metraj başarısız oldu' : 'Take-off failed'}
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          {run.fileName} · {(run.fileSize / 1e6).toFixed(1)} MB
        </p>
        <p className="mt-3 rounded border border-danger/30 bg-danger/10 px-4 py-3 font-data text-[12px] text-danger">
          {run.error || (lang === 'tr' ? 'bilinmeyen işleme hatası' : 'unknown processing error')}
        </p>
        <p className="mt-4 text-[12.5px] text-muted">
          {lang === 'tr'
            ? 'Dosyayı yeniden yükleyebilir veya farklı bir sözlük profiliyle deneyebilirsin.'
            : 'You can re-upload the file or try a different vocabulary profile.'}
        </p>
        <Link href="/" className="btn btn-primary mt-5 inline-block">
          {lang === 'tr' ? '← Yeni metraj' : '← New take-off'}
        </Link>
      </div>
    );
  }

  const [rows, steel, cals] = await Promise.all([getRows(id), getSteel(id), listCalibrations()]);
  return <RunDetail lang={lang} run={run} initialRows={rows} steel={steel} calibrations={cals} />;
}
