import { cookies } from 'next/headers';
import { listCalibrations } from '@/lib/store';
import type { Lang } from '@/lib/i18n';
import { t } from '@/lib/i18n';
import { CalibrationsPanel } from '@/components/calibrations-panel';

export default async function CalibrationsPage() {
  const store = await cookies();
  const lang = (store.get('lang')?.value === 'en' ? 'en' : 'tr') as Lang;
  const cals = await listCalibrations();
  return (
    <div className="space-y-6">
      <h1 className="dimline rise text-[22px] font-bold tracking-tight">{t(lang, 'calibrations')}</h1>
      <CalibrationsPanel lang={lang} initial={cals} />
    </div>
  );
}
