'use client';
// Metriq — "modelde göster": Autodesk APS Viewer paneli.
// Model zaten Model Derivative'de çevrili (SVF); görüntüleme token yakmaz.
// Satır ikonuna basılınca panel açılır, o satırın nesneleri izole edilip
// kamera üstüne süzülür (isolate + fitToView). Viewer script'i YALNIZ ilk
// açılışta Autodesk CDN'inden yüklenir (~2-3MB, sayfaya baştan binmez).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Lang } from '@/lib/i18n';

const VIEWER_JS = 'https://developer.api.autodesk.com/modelderivative/v2/viewers/7.*/viewer3D.min.js';
const VIEWER_CSS = 'https://developer.api.autodesk.com/modelderivative/v2/viewers/7.*/style.min.css';

// Autodesk global'i (tipleri paketlemeye değmez — dar kullanım)
/* eslint-disable @typescript-eslint/no-explicit-any */
declare global { interface Window { Autodesk?: any } }

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

export function ModelViewerPanel({ lang, runId, focusRowIds, focusLabel, onClose }: {
  lang: Lang;
  runId: string;
  focusRowIds: string[] | null; // izole edilecek satır(lar) (null/boş = tüm model)
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
  const [attempt, setAttempt] = useState(0); // "Tekrar dene": viewer tam sıfırlanır (zehirli doc-cache temizlenir)

  const applyFocus = useCallback((rowIds: string[] | null) => {
    const viewer = viewerRef.current;
    const map = mapRef.current;
    if (!viewer || !map) return;
    const ids = (rowIds ?? []).flatMap(rid => map[rid] ?? []);
    if (!ids.length) {
      viewer.isolate([]); viewer.fitToView();
      setFocusInfo(rowIds?.length
        ? (tr ? 'Bu satır için nesne eşlemesi yok (tüm model gösteriliyor).' : 'No object mapping for this row (showing whole model).')
        : '');
      return;
    }
    viewer.isolate(ids);
    viewer.fitToView(ids);
    setFocusInfo(`${ids.length} ${tr ? 'nesne izole edildi' : 'objects isolated'}`);
  }, [tr]);

  // kurulum: script + token + urn + model — bir kez
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
          // (cdn.derivative manifest → 503). Bearer header'a zorla — curl ile kanıtlı 200.
          useCookie: false,
          useCredentials: false,
          getAccessToken: (done: (token: string, expires: number) => void) => {
            fetch('/api/aps/viewer-token').then(r => r.json())
              .then(d => done(d.access_token, d.expires_in))
              .catch(() => done('', 0));
          },
        }, resolve));
        if (disposed || !holderRef.current) return;
        // TÜM derivative istekleri same-origin proxy'den geçer — kullanıcı
        // tarayıcısındaki eklenti/çerez engelleri Autodesk CDN'ini kesemesin
        av.endpoint.setEndpointAndApi(`${window.location.origin}/api/aps/proxy`, 'derivativeV2');
        const viewer = new av.GuiViewer3D(holderRef.current, { theme: 'dark-theme' });
        viewer.start();
        viewerRef.current = viewer;
        av.Document.load(`urn:${om.urn}`, (doc: any) => {
          if (disposed) return;
          const viewable = doc.getRoot().getDefaultGeometry();
          viewer.loadDocumentNode(doc, viewable).then(() => {
            if (disposed) return;
            viewer.addEventListener(av.GEOMETRY_LOADED_EVENT, () => applyFocus(focusRowIds), { once: true });
            // küçük modellerde geometry çoktan yüklü olabilir
            setTimeout(() => applyFocus(focusRowIds), 800);
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
    // Viewer, başarısız Document'ı oturum içinde önbellekler — sıradan yeniden
    // deneme sessizce aynı hatayı döndürür. shutdown() modül durumunu sıfırlar.
    try { window.Autodesk?.Viewing?.shutdown?.(); } catch { /* yoksay */ }
    viewerAssetsPromise = null;
    setState('loading'); setError('');
    setAttempt(a => a + 1);
  }

  // odak satırı değişince (panel açıkken başka satır ikonuna basılırsa)
  useEffect(() => { if (state === 'ready') applyFocus(focusRowIds); }, [focusRowIds, state, applyFocus]);

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true"
      aria-label={tr ? '3B model görüntüleyici' : '3D model viewer'}>
      <button className="flex-1 bg-black/60" onClick={onClose} aria-label={tr ? 'kapat' : 'close'} />
      <div className="flex h-full w-full max-w-[880px] flex-col border-l border-line bg-[var(--color-panel)] shadow-2xl">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <span className="text-[12px] font-semibold uppercase tracking-wider text-copper">
            ◎ {tr ? 'Modelde göster' : 'Show in model'}
          </span>
          <span className="font-data text-[11.5px] text-muted">{focusLabel}</span>
          {focusInfo && <span className="font-data text-[10.5px] text-mint">{focusInfo}</span>}
          <button onClick={() => applyFocus(null)} className="btn btn-ghost ml-auto !text-[11px]">
            {tr ? 'tüm model' : 'whole model'}
          </button>
          <button onClick={onClose} className="btn !text-[11px]">✕ {tr ? 'Kapat' : 'Close'}</button>
        </div>
        <div className="relative flex-1">
          <div ref={holderRef} className="absolute inset-0" />
          {state === 'loading' && (
            <div className="absolute inset-0 flex items-center justify-center font-data text-[12px] text-muted">
              {tr ? 'Model Autodesk\'ten akıtılıyor…' : 'Streaming model from Autodesk…'}
            </div>
          )}
          {state === 'error' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center">
              <span className="font-data text-[12px] text-danger">{error}</span>
              <button onClick={retry} className="btn !text-[12px]">↻ {tr ? 'Tekrar dene' : 'Retry'}</button>
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
            ? 'Görüntüleme ücretsizdir (model zaten çevrili). Sol tık döndür · tekerlek zoom · sağ tık kaydır.'
            : 'Viewing is free (model already translated). Left-drag orbit · wheel zoom · right-drag pan.'}
        </div>
      </div>
    </div>
  );
}
