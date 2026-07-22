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
// Bulut işlerinde sunucu penceresiyle AYNI tavan: çeviri+property hazırlığı ≤3sa
// (gerçek vaka: Autodesk property veritabanını 1 saatte hazırlayamadı).
const MAX_PROCESSING_MS = 15 * 60_000;
const MAX_APS_MS = 3 * 60 * 60_000;

export function ProcessingLive({ lang, initial }: { lang: Lang; initial: Run }) {
  const router = useRouter();
  const [run, setRun] = useState<Run>(initial);
  const [timedOut, setTimedOut] = useState(false);
  const [resuming, setResuming] = useState(false);
  const doneRef = useRef(false);
  const apsRef = useRef(Boolean(initial.aps));
  const resumedRef = useRef<string | null>(initial.aps?.resumedAt ?? null);

  // "Buluttan devam et": bitmiş Autodesk çevirisini yeniden kullanır — yeni
  // token yakılmaz. Yalnız bulut aşamasına ulaşmış hatalı işlerde anlamlı.
  async function resumeFromCloud() {
    setResuming(true);
    try {
      const r = await fetch(`/api/runs/${initial.id}/resume`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lang }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error || `HTTP ${r.status}`);
      // Sayfa processing hâline döner; poll yeniden başlar
      window.location.reload();
    } catch (e) {
      setResuming(false);
      alert((lang === 'tr' ? 'Devam ettirilemedi: ' : 'Resume failed: ')
        + (e instanceof Error ? e.message : ''));
    }
  }

  useEffect(() => {
    let alive = true;
    let iv: ReturnType<typeof setInterval> | null = null;
    // Watchdog referansı: run'ın başlangıcı (geçersizse sayfanın açılış anı)
    const started = new Date(initial.createdAt).getTime();
    const base = Number.isFinite(started) ? started : Date.now();

    function stop() { if (iv) { clearInterval(iv); iv = null; } }

    async function tick() {
      if (!alive || doneRef.current) return;
      // "Buluttan devam et" pencereyi resumedAt'ten yeniden başlatır — createdAt
      // eski diye taze devam işini anında timeout'a düşürme
      const resumedMs = resumedRef.current ? (new Date(resumedRef.current).getTime() || 0) : 0;
      const deadline = Math.max(base, resumedMs) + (apsRef.current ? MAX_APS_MS : MAX_PROCESSING_MS);
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
        if (next.aps?.resumedAt) resumedRef.current = next.aps.resumedAt;
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
      errorAction={run.status === 'error' && run.aps?.urn ? (
        <button type="button" onClick={resumeFromCloud} disabled={resuming}
          className="rounded border border-copper/60 bg-copper/10 px-3 py-1.5 font-data text-[11.5px] text-copper transition-colors hover:bg-copper/20 disabled:opacity-50">
          {resuming
            ? (lang === 'tr' ? 'Devam ettiriliyor…' : 'Resuming…')
            : (lang === 'tr' ? '☁ Buluttan devam et (ücretsiz — çeviri tekrar ücretlendirilmez)' : '☁ Resume from cloud (free — translation is not billed again)')}
        </button>
      ) : undefined}
    />
  );
}
