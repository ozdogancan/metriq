'use client';
// Metriq — "modelde göster": Autodesk APS Viewer paneli (v2).
// Model zaten Model Derivative'de çevrili (SVF); görüntüleme token yakmaz.
//
// v2 mimarisi:
// • Panel kapanınca YOK EDİLMEZ, gizlenir → model bellekte kalır, ikinci açılış
//   ANINDA (yeniden akıtma yok); "Close çalışmıyor" sınıfı teardown'suz tamamen kapanır.
// • İki görünüm modu — satıra basınca ne görmek anlamlı:
//   İZOLE: yalnız o satırın parçaları (gerisi silik) + kamera üstüne süzülür.
//   BAĞLAMDA: tüm tesis görünür, satırın parçaları BAKIR renkle yanar + zoom —
//   "bu 8 dirsek hattın neresinde?" sorusunun cevabı.
// • ESC ve arka-plan tıklaması da kapatır.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Lang } from '@/lib/i18n';

const VIEWER_JS = 'https://developer.api.autodesk.com/modelderivative/v2/viewers/7.*/viewer3D.min.js';
const VIEWER_CSS = 'https://developer.api.autodesk.com/modelderivative/v2/viewers/7.*/style.min.css';

// Autodesk global'i (tipleri paketlemeye değmez — dar kullanım)
/* eslint-disable @typescript-eslint/no-explicit-any */
declare global { interface Window { Autodesk?: any; THREE?: any } }

let viewerAssetsPromise: Promise<void> | null = null;
function loadViewerAssets(): Promise<void> {
  if (window.Autodesk?.Viewing) return Promise.resolve();
  if (viewerAssetsPromise) return viewerAssetsPromise;
  viewerAssetsPromise = new Promise<void>((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = VIEWER_CSS;
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = VIEWER_JS; s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { viewerAssetsPromise = null; reject(new Error('Viewer script yüklenemedi')); };
    document.head.appendChild(s);
  });
  return viewerAssetsPromise;
}

type ViewMode = 'isolate' | 'context';

export function ModelViewerPanel({ lang, runId, open, focusRowIds, focusLabel, onClose }: {
  lang: Lang;
  runId: string;
  open: boolean;                // false = gizli (viewer sıcak kalır)
  focusRowIds: string[] | null; // odaklanılacak satır(lar) (null/boş = tüm model)
  focusLabel: string;           // panel başlığında gösterilen satır etiketi
  onClose: () => void;
}) {
  const tr = lang === 'tr';
  const holderRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const mapRef = useRef<Record<string, number[]> | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [focusInfo, setFocusInfo] = useState('');
  const [mode, setMode] = useState<ViewMode>('isolate');
  const modeRef = useRef<ViewMode>('isolate');
  const focusRef = useRef<string[] | null>(focusRowIds);
  const [attempt, setAttempt] = useState(0); // "Tekrar dene": viewer tam sıfırlanır (zehirli doc-cache temizlenir)

  const applyFocus = useCallback((rowIds: string[] | null, m?: ViewMode) => {
    const viewer = viewerRef.current;
    const map = mapRef.current;
    if (!viewer || !map) return;
    const useMode = m ?? modeRef.current;
    const ids = (rowIds ?? []).flatMap(rid => map[rid] ?? []);
    const model = viewer.model;
    try { viewer.clearThemingColors?.(model); } catch { /* model henüz yoksa */ }
    if (!ids.length) {
      viewer.isolate([]);
      viewer.fitToView();
      setFocusInfo(rowIds?.length
        ? (tr ? 'Bu satır için nesne eşlemesi yok — tüm model gösteriliyor.' : 'No object mapping for this row — showing the whole model.')
        : '');
      return;
    }
    if (useMode === 'isolate') {
      viewer.isolate(ids);
    } else {
      // bağlamda: her şey görünür, odak parçaları bakır yanar
      viewer.isolate([]);
      const THREE = window.THREE;
      if (THREE?.Vector4) {
        const copper = new THREE.Vector4(0.85, 0.55, 0.25, 0.9);
        for (const id of ids) { try { viewer.setThemingColor(id, copper, model, true); } catch { /* tekil id hatası akışı bozmasın */ } }
      }
    }
    viewer.fitToView(ids);
    setFocusInfo(`${ids.length} ${tr
      ? (useMode === 'isolate' ? 'parça izole edildi' : 'parça bağlamda vurgulandı')
      : (useMode === 'isolate' ? 'parts isolated' : 'parts highlighted in context')}`);
  }, [tr]);

  // kurulum: script + token + urn + model — panel İLK açıldığında bir kez
  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const [, om] = await Promise.all([
          loadViewerAssets(),
          fetch(`/api/runs/${runId}/objectmap`).then(r => r.ok ? r.json() : Promise.reject(new Error('eşleme alınamadı'))),
        ]);
        if (disposed) return;
        mapRef.current = om.map ?? {};
        const av = window.Autodesk!.Viewing;
        await new Promise<void>(resolve => av.Initializer({
          env: 'AutodeskProduction',
          api: 'derivativeV2',
          // Chrome üçüncü-taraf çerez engeli viewer'ın varsayılan cookie akışını kırar
          useCookie: false,
          useCredentials: false,
          getAccessToken: (done: (token: string, expires: number) => void) => {
            fetch('/api/aps/viewer-token').then(r => r.json())
              .then(d => done(d.access_token, d.expires_in))
              .catch(() => done('', 0));
          },
        }, resolve));
        if (disposed || !holderRef.current) return;
        // TÜM derivative istekleri same-origin proxy'den — eklenti/çerez engelleri kesemez
        av.endpoint.setEndpointAndApi(`${window.location.origin}/api/aps/proxy`, 'derivativeV2');
        const viewer = new av.GuiViewer3D(holderRef.current, { theme: 'dark-theme' });
        viewer.start();
        viewerRef.current = viewer;
        av.Document.load(`urn:${om.urn}`, (doc: any) => {
          if (disposed) return;
          const viewable = doc.getRoot().getDefaultGeometry();
          viewer.loadDocumentNode(doc, viewable).then(() => {
            if (disposed) return;
            viewer.addEventListener(av.GEOMETRY_LOADED_EVENT, () => applyFocus(focusRef.current), { once: true });
            // küçük modellerde geometry çoktan yüklü olabilir
            setTimeout(() => applyFocus(focusRef.current), 800);
            setState('ready');
          });
        }, (code: unknown) => {
          if (disposed) return;
          setError(`${tr ? 'Model yüklenemedi' : 'Model failed to load'} (${String(code)})`);
          setState('error');
        });
      } catch (e) {
        if (disposed) return;
        setError(e instanceof Error ? e.message : 'viewer hata');
        setState('error');
      }
    })();
    return () => {
      disposed = true;
      try { viewerRef.current?.finish(); } catch { /* teardown */ }
      viewerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, attempt]);

  function retry() {
    // Viewer, başarısız Document'ı oturum içinde önbellekler — shutdown() sıfırlar.
    try { window.Autodesk?.Viewing?.shutdown?.(); } catch { /* yoksay */ }
    viewerAssetsPromise = null;
    setState('loading'); setError('');
    setAttempt(a => a + 1);
  }

  // odak satırı değişince (panel açıkken başka satır ikonuna basılırsa)
  useEffect(() => {
    focusRef.current = focusRowIds;
    if (state === 'ready' && open) applyFocus(focusRowIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRowIds]);

  // gizliyken canvas 0×0 kalır — açılınca resize + odağı tazele
  useEffect(() => {
    if (!open || state !== 'ready') return;
    const t = setTimeout(() => {
      try { viewerRef.current?.resize(); } catch { /* yoksay */ }
      applyFocus(focusRef.current);
    }, 60);
    return () => clearTimeout(t);
  }, [open, state, applyFocus]);

  // ESC ile kapat
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  function switchMode(m: ViewMode) {
    setMode(m);
    modeRef.current = m;
    applyFocus(focusRef.current, m);
  }

  return (
    <div className={`${open ? 'flex' : 'hidden'} fixed inset-0 z-50`} role="dialog" aria-modal="true"
      aria-label={tr ? '3B model görüntüleyici' : '3D model viewer'}>
      <button type="button" className="flex-1 cursor-default bg-black/60" onClick={onClose} aria-label={tr ? 'kapat' : 'close'} />
      <div className="flex h-full w-full max-w-[880px] flex-col border-l border-line bg-[var(--color-panel)] shadow-2xl">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <span className="text-[12px] font-semibold uppercase tracking-wider text-copper">
            ◎ {tr ? 'Modelde göster' : 'Show in model'}
          </span>
          <span className="max-w-[300px] truncate font-data text-[11.5px] text-muted" title={focusLabel}>{focusLabel}</span>
          {/* görünüm modu: izole / bağlamda */}
          <span className="ml-1 flex overflow-hidden rounded border border-line font-data text-[10.5px]">
            {(['isolate', 'context'] as const).map(m => (
              <button key={m} type="button" onClick={() => switchMode(m)}
                title={m === 'isolate'
                  ? (tr ? 'Yalnız bu satırın parçaları' : 'Only this row\'s parts')
                  : (tr ? 'Tüm tesis + parçalar bakır vurgulu — hattın neresinde görün' : 'Whole plant + parts highlighted — see where they sit')}
                className={`px-2 py-1 transition-colors ${mode === m ? 'bg-copper/20 text-copper-bright' : 'text-muted hover:text-ink'}`}>
                {m === 'isolate' ? (tr ? 'izole' : 'isolate') : (tr ? 'bağlamda' : 'in context')}
              </button>
            ))}
          </span>
          {focusInfo && <span className="font-data text-[10.5px] text-mint">{focusInfo}</span>}
          <button type="button" onClick={() => applyFocus(null)} className="btn btn-ghost ml-auto !text-[11px]">
            {tr ? 'tüm model' : 'whole model'}
          </button>
          <button type="button" onClick={onClose} className="btn !text-[11px]">✕ {tr ? 'Kapat' : 'Close'} (Esc)</button>
        </div>
        <div className="relative flex-1">
          <div ref={holderRef} className="absolute inset-0" />
          {state === 'loading' && (
            <div className="absolute inset-0 flex items-center justify-center font-data text-[12px] text-muted">
              {tr ? 'Model Autodesk\'ten akıtılıyor… (ilk açılış; sonrakiler anında)' : 'Streaming model from Autodesk… (first open; next opens are instant)'}
            </div>
          )}
          {state === 'error' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center">
              <span className="font-data text-[12px] text-danger">{error}</span>
              <button type="button" onClick={retry} className="btn !text-[12px]">↻ {tr ? 'Tekrar dene' : 'Retry'}</button>
              <span className="max-w-md font-data text-[10.5px] text-muted">
                {tr
                  ? 'Sürüyorsa: tarayıcı eklentisi (reklam/gizlilik engelleyici) Autodesk isteklerini kesiyor olabilir — bu site için kapatıp yeniden dene.'
                  : 'If it persists: a browser extension (ad/privacy blocker) may be blocking Autodesk requests — disable it for this site and retry.'}
              </span>
            </div>
          )}
        </div>
        <div className="border-t border-line px-4 py-2 font-data text-[10px] text-muted">
          {tr
            ? 'Görüntüleme ücretsizdir. Sol tık döndür · tekerlek zoom · sağ tık kaydır · Esc kapatır.'
            : 'Viewing is free. Left-drag orbit · wheel zoom · right-drag pan · Esc closes.'}
        </div>
      </div>
    </div>
  );
}
