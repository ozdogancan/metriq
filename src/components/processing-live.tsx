'use client';
// Metriq — işleme sürecini canlı izler: run'ı poll eder, ProcessingTheater'a besler,
// bitince run detayına geçer.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ProcessingTheater, type StageEvent } from '@/components/processing-theater';
import { STAGE_ORDER, type Run } from '@/lib/types';
import { t, type Lang } from '@/lib/i18n';

// İstemci tarafı emniyet süresi: 15 dk'yı aşan processing'de poll durur, hata gösterilir
// (sunucu watchdog'u da error yazar ama istemci kendini korur).
// APS bulut çevirisi dakikalar sürer → bulut işlerinde tavan 60 dk.
const MAX_PROCESSING_MS = 15 * 60_000;
const MAX_APS_MS = 60 * 60_000;

export function ProcessingLive({ lang, initial }: { lang: Lang; initial: Run }) {
  const router = useRouter();
  const [run, setRun] = useState<Run>(initial);
  const [timedOut, setTimedOut] = useState(false);
  const doneRef = useRef(false);
  const apsRef = useRef(Boolean(initial.aps));

  useEffect(() => {
    let alive = true;
    let iv: ReturnType<typeof setInterval> | null = null;
    // Watchdog referansı: run'ın başlangıcı (geçersizse sayfanın açılış anı)
    const started = new Date(initial.createdAt).getTime();
    const base = Number.isFinite(started) ? started : Date.now();

    function stop() { if (iv) { clearInterval(iv); iv = null; } }

    async function tick() {
      if (!alive || doneRef.current) return;
      const deadline = base + (apsRef.current ? MAX_APS_MS : MAX_PROCESSING_MS);
      if (Date.now() > deadline) {
        doneRef.current = true; // terminal: poll bir daha başlamasın
        setTimedOut(true);
        stop();
        return;
      }
      try {
        // slim=1: yalnız {run} döner (rows/steel taşınmaz) — poll yükü küçük kalır
        const r = await fetch(`/api/runs/${initial.id}?slim=1`, { cache: 'no-store' });
        if (!r.ok) return;
        const d = (await r.json()) as { run?: Run } | Run;
        const next = (d as { run?: Run }).run ?? (d as Run);
        if (!alive || !next?.id) return;
        if (next.aps) apsRef.current = true; // sunucu bulut yoluna geçti → uzun watchdog + advance ping
        setRun(next);
        if (next.status !== 'processing' && !doneRef.current) {
          doneRef.current = true;
          stop();
          // aşamaların "done" hali kısa bir an görünsün, sonra detaya geç
          setTimeout(() => router.refresh(), 900);
        }
      } catch { /* geçici ağ hatası — sıradaki tikte tekrar */ }
    }

    function start() {
      if (iv || doneRef.current) return;
      iv = setInterval(tick, 800);
      tick();
    }
    // Sekme gizliyken poll duraklar; görünür olunca hemen bir tik atılır
    function onVis() { if (document.hidden) stop(); else start(); }
    document.addEventListener('visibilitychange', onVis);
    if (!document.hidden) start();

    return () => { alive = false; stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [initial.id, initial.createdAt, router]);

  const stages: StageEvent[] = (run.progress && run.progress.length
    ? run.progress
    : STAGE_ORDER.map(key => ({ key, status: 'pending' as const }))) as StageEvent[];

  return (
    <ProcessingTheater
      lang={lang}
      fileName={run.fileName}
      fileSizeMb={run.fileSize / 1e6}
      stages={stages}
      error={run.status === 'error'
        ? (run.error || t(lang, 'processing_failed'))
        : timedOut ? t(lang, 'processing_timeout') : undefined}
    />
  );
}
