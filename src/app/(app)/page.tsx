import { cookies } from 'next/headers';
import { listRuns, isSupabase } from '@/lib/store';
import { isPg } from '@/lib/store-pg';
import { t, type Lang } from '@/lib/i18n';
import { UploadZone } from '@/components/upload-zone';
import { RunsList } from '@/components/runs-list';

export default async function Dashboard() {
  const store = await cookies();
  const lang = (store.get('lang')?.value === 'en' ? 'en' : 'tr') as Lang;
  const runs = await listRuns();

  return (
    <div className="space-y-8">
      {!isSupabase && !isPg && (
        <div className="rise panel px-4 py-3 text-[12px] text-steel border-steel/25">
          ⚙ {t(lang, 'setup_needed')}
        </div>
      )}

      <section className="rise rise-1">
        <h1 className="dimline mb-6 text-[22px] font-bold tracking-tight">{t(lang, 'upload_title')}</h1>
        <UploadZone lang={lang} />
      </section>

      <section className="rise rise-3">
        <h2 className="dimline mb-6 text-[17px] font-bold tracking-tight">{t(lang, 'recent_runs')}</h2>
        <RunsList lang={lang} runs={runs} />
      </section>
    </div>
  );
}
