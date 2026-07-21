import { cookies } from 'next/headers';
import { listCalibrations, listRuns, isSupabase } from '@/lib/store';
import { isPg } from '@/lib/store-pg';
import { t, langFromCookie } from '@/lib/i18n';
import { UploadZone } from '@/components/upload-zone';
import { RunsList } from '@/components/runs-list';
import { getSessionIdentity } from '@/lib/session';
import { redirect } from 'next/navigation';

export default async function Dashboard() {
  const store = await cookies();
  const scope = await getSessionIdentity();
  if (!scope) redirect('/login');
  const lang = langFromCookie(store.get('lang')?.value);
  const [runs, calibrations] = await Promise.all([listRuns(scope), listCalibrations(scope)]);

  return (
    <div className="space-y-8">
      {!isSupabase && !isPg && (
        <div className="rise panel px-4 py-3 text-[12px] text-steel border-steel/25">
          ⚙ {t(lang, 'setup_needed')}
        </div>
      )}

      <section className="rise rise-1">
        <h1 className="dimline mb-6 text-[22px] font-bold tracking-tight">{t(lang, 'upload_title')}</h1>
        <UploadZone lang={lang} calibrations={calibrations} />
      </section>

      <section className="rise rise-3">
        <h2 className="dimline mb-6 text-[17px] font-bold tracking-tight">{t(lang, 'recent_runs')}</h2>
        <RunsList lang={lang} runs={runs} />
      </section>
    </div>
  );
}
