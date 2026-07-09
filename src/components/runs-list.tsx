'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { t, type Lang } from '@/lib/i18n';
import type { Run } from '@/lib/types';

const STATUS_COLOR: Record<Run['status'], string> = {
  done: 'var(--color-mint)', processing: 'var(--color-copper-bright)', error: 'var(--color-danger)',
};

export function RunsList({ lang, runs }: { lang: Lang; runs: Run[] }) {
  const router = useRouter();

  async function del(id: string) {
    if (!confirm(t(lang, 'confirm_delete'))) return;
    await fetch(`/api/runs/${id}`, { method: 'DELETE' });
    router.refresh();
  }

  if (!runs.length) {
    return <div className="panel panel-corners px-6 py-10 text-center text-[13px] text-muted">{t(lang, 'no_runs')}</div>;
  }

  return (
    <div className="grid gap-3">
      {runs.map((r, i) => (
        <div key={r.id} className={`panel rise flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4 hover:border-copper/40 transition-colors`} style={{ animationDelay: `${Math.min(i * 60, 400)}ms` }}>
          <div className="min-w-[180px] flex-1">
            <Link href={`/runs/${r.id}`} className="text-[14px] font-semibold hover:text-copper-bright transition-colors">
              {r.projectName}
            </Link>
            <div className="mt-0.5 font-data text-[11px] text-muted">
              {r.fileName} · {(r.fileSize / 1e6).toFixed(1)} MB · {new Date(r.createdAt).toLocaleString(lang === 'tr' ? 'tr-TR' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' })}
            </div>
          </div>
          <div className="flex items-center gap-5 font-data text-[12px]">
            <Stat label={t(lang, 'pipe_total')} value={`${r.totals.pipeM.toFixed(1)} m`} />
            <Stat label={t(lang, 'fittings')} value={String(r.totals.fittingsEa)} />
            <Stat label={t(lang, 'flanges')} value={String(r.totals.flangesEa)} />
            {r.totals.steelM > 0 && <Stat label={t(lang, 'steel')} value={`${r.totals.steelM.toFixed(1)} m`} />}
            <Stat label={t(lang, 'lines')} value={String(r.totals.lines.length)} />
          </div>
          <div className="flex items-center gap-2">
            <span className="chip">
              <span className="chip-dot" style={{ background: STATUS_COLOR[r.status] }} />
              {t(lang, r.status === 'done' ? 'status_done' : r.status === 'error' ? 'status_error' : 'status_processing')}
            </span>
            <a href={`/api/runs/${r.id}/excel`} className="btn btn-ghost !px-3" title={t(lang, 'download_excel')}>
              ⤓ XLSX
            </a>
            <button onClick={() => del(r.id)} className="btn btn-ghost !px-2.5 hover:!text-danger" title={t(lang, 'delete_run')}>✕</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center">
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className="text-[13px] font-semibold text-ink">{value}</div>
    </div>
  );
}
