import { cookies } from 'next/headers';
import { listCalibrations } from '@/lib/store';
import { t, langFromCookie } from '@/lib/i18n';
import { CalibrationsPanel } from '@/components/calibrations-panel';
import { getSessionIdentity } from '@/lib/session';
import { redirect } from 'next/navigation';

export default async function CalibrationsPage() {
  const store = await cookies();
  const scope = await getSessionIdentity();
  if (!scope) redirect('/login');
  const lang = langFromCookie(store.get('lang')?.value);
  const cals = await listCalibrations(scope);
  return (
    <div className="space-y-6">
      <h1 className="dimline rise text-[22px] font-bold tracking-tight">{t(lang, 'calibrations')}</h1>
      <CalibrationsPanel lang={lang} initial={cals} />
    </div>
  );
}
