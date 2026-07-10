'use client';
// Metriq — işleme sürecini canlı izler: run'ı poll eder, ProcessingTheater'a besler,
// bitince run detayına geçer.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ProcessingTheater, type StageEvent } from '@/components/processing-theater';
import { STAGE_ORDER, type Run } from '@/lib/types';
import type { Lang } from '@/lib/i18n';

export function ProcessingLive({ lang, initial }: { lang: Lang; initial: Run }) {
  const router = useRouter();
  const [run, setRun] = useState<Run>(initial);
  const doneRef = useRef(false);

  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const r = await fetch(`/api/runs/${initial.id}`, { cache: 'no-store' });
        if (!r.ok) return;
        const d = (await r.json()) as { run?: Run } | Run;
        const next = (d as { run?: Run }).run ?? (d as Run);
        if (!alive || !next?.id) return;
        setRun(next);
        if (next.status !== 'processing' && !doneRef.current) {
          doneRef.current = true;
          // aşamaların "done" hali kısa bir an görünsün, sonra detaya geç
          setTimeout(() => router.refresh(), 900);
        }
      } catch { /* geçici ağ hatası — sıradaki tikte tekrar */ }
    }
    const iv = setInterval(tick, 800);
    tick();
    return () => { alive = false; clearInterval(iv); };
  }, [initial.id, router]);

  const stages: StageEvent[] = (run.progress && run.progress.length
    ? run.progress
    : STAGE_ORDER.map(key => ({ key, status: 'pending' as const }))) as StageEvent[];

  return (
    <ProcessingTheater
      lang={lang}
      fileName={run.fileName}
      fileSizeMb={run.fileSize / 1e6}
      stages={stages}
      error={run.status === 'error' ? (run.error || 'işleme hatası') : undefined}
    />
  );
}
