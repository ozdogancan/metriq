import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { getRun, getRows, getSteel, listCalibrations } from '@/lib/store';
import type { Lang } from '@/lib/i18n';
import { RunDetail } from '@/components/run-detail';

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await getRun(id);
  if (!run) notFound();
  const store = await cookies();
  const lang = (store.get('lang')?.value === 'en' ? 'en' : 'tr') as Lang;
  const [rows, steel, cals] = await Promise.all([getRows(id), getSteel(id), listCalibrations()]);
  return <RunDetail lang={lang} run={run} initialRows={rows} steel={steel} calibrations={cals} />;
}
