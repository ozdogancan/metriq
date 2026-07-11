'use client';
// ── İşleme Tiyatrosu ─────────────────────────────────────────────────────
// NWD dosyası işlenirken pipeline'ın ne yaptığını GERÇEK ara-verilerle
// anlatan görsel deneyim. Merkezdeki izometrik boru hattı illüstrasyonu
// her tamamlanan aşamada kendini bir bölüm daha çizer (taslak → bakır).
// Yalnızca var(--color-*) tema değişkenleri kullanılır; dark+light uyumlu.

import { useEffect, useRef, useState, type JSX } from 'react';

export type StageKey =
  | 'upload' | 'scan' | 'extract' | 'size' | 'lines'
  | 'rules' | 'steel' | 'audit' | 'finalize';

export interface StageEvent {
  key: StageKey;
  status: 'pending' | 'active' | 'done';
  startedAt?: string;
  metrics?: Record<string, string | number>; // ör. {"komponent": 2381, "boru_m": 191.9, "hat": 4}
}

type Lang = 'tr' | 'en';

// ── Aşama etiketleri ──
const STAGE_LABELS: Record<StageKey, { tr: string; en: string }> = {
  upload:   { tr: 'Dosya alındı',                     en: 'File received' },
  scan:     { tr: 'Veri akışları taranıyor (zlib)',   en: 'Scanning data streams' },
  extract:  { tr: 'Komponentler çıkarılıyor',         en: 'Extracting components' },
  size:     { tr: 'Boyutlar çözülüyor (OD→NPS)',      en: 'Resolving sizes' },
  lines:    { tr: 'Hatlar eşleniyor',                 en: 'Mapping lines' },
  rules:    { tr: 'Metraj kuralları uygulanıyor',     en: 'Applying take-off rules' },
  steel:    { tr: 'Çelik profiller',                  en: 'Steel members' },
  audit:    { tr: 'AI denetçi çapraz kontrolleri',    en: 'AI auditor cross-checks' },
  finalize: { tr: 'Excel hazırlanıyor',               en: 'Preparing Excel' },
};

const UI = {
  done:    { tr: 'Tamamlandı', en: 'Complete' },
  failed:  { tr: 'İşlem hatası', en: 'Processing failed' },
  waiting: { tr: 'Sırada', en: 'Queued' },
};

// ── İzometrik çizim segmentleri ──────────────────────────────────────────
// Projeksiyon: iso(X,Y,Z) = (330 + (X−Y)·26, 260 + (X+Y)·15 − Z·30)
// Tüm koordinatlar elle hesaplanıp sabitlendi — deterministik, el yapımı vektör.
interface Seg {
  d: string;
  w?: number;               // çizgi kalınlığı
  fill?: 'panel' | 'copper'; // panel: arkasını maskeler (vana gövdesi), copper: dolu ok/nokta
  o?: number;               // tamamlanınca opaklık (zemin gibi baskın parçalar için)
}

const SEGMENTS: Record<StageKey, Seg[]> = {
  // Zemin düzlemi + eksen çizgileri (upload = sahne kurulur)
  upload: [
    { d: 'M213 132 L551 328 L447 388 L109 192 Z', w: 1, o: 0.3 },
    { d: 'M304 245 L356 275', w: 1, o: 0.35 },
    { d: 'M356 245 L304 275', w: 1, o: 0.35 },
  ],
  // Ana boru hattı (tek-çizgi izometrik gösterim) + uç düğümleri
  scan: [
    { d: 'M200 125 L460 275', w: 2.1 },
    { d: 'M197.5 125 a2.5 2.5 0 1 0 5 0 a2.5 2.5 0 1 0 -5 0', fill: 'copper', w: 1.2 },
    { d: 'M457.5 275 a2.5 2.5 0 1 0 5 0 a2.5 2.5 0 1 0 -5 0', fill: 'copper', w: 1.2 },
  ],
  // Branşman: tee → dirsek → düşey iniş
  extract: [
    { d: 'M287 175 L404 108 Q417 100 417 113 L417 148', w: 2.1 },
    { d: 'M284 175 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0', fill: 'copper', w: 1.2 },
  ],
  // Flanş çiftleri (boruya dik ikili tikler) — 4 konum
  size: [
    { d: 'M242.5 159.8 L251.5 144.2', w: 1.7 },
    { d: 'M246.8 162.3 L255.8 146.7', w: 1.7 },
    { d: 'M337.4 214.8 L346.4 199.2', w: 1.7 },
    { d: 'M333.1 212.3 L342.1 196.7', w: 1.7 },
    { d: 'M375.6 236.8 L384.6 221.2', w: 1.7 },
    { d: 'M379.9 239.3 L388.9 223.7', w: 1.7 },
    { d: 'M408 148 L426 148', w: 1.7 },
    { d: 'M409.5 153 L424.5 153', w: 1.7 },
  ],
  // Hat numarası bayrakları + akış okları
  lines: [
    { d: 'M226 140 L214 120 L208 112', w: 1 },
    { d: 'M138 104 h70 v16 h-70 Z', w: 1 },
    { d: 'M370 127 L358 100 L350 100', w: 1 },
    { d: 'M288 92 h62 v16 h-62 Z', w: 1 },
    { d: 'M307.8 187 L298 186 L302 179 Z', fill: 'copper', w: 1 },
    { d: 'M359.8 133 L354 141 L350 134 Z', fill: 'copper', w: 1 },
  ],
  // Sürgülü vana: papyon gövde + mil + volan
  rules: [
    { d: 'M342 219 L352 201 L380 217 L370 235 Z', fill: 'panel', w: 1.8 },
    { d: 'M361 218 L361 190', w: 1.8 },
    { d: 'M349 188 a12 4.5 0 1 0 24 0 a12 4.5 0 1 0 -24 0', w: 1.5 },
  ],
  // Çelik taşıyıcı çerçeve: 2 kolon + taban plakaları + kiriş + çapraz
  steel: [
    { d: 'M287 179 L287 235', w: 2.3 },
    { d: 'M391 239 L391 295', w: 2.3 },
    { d: 'M279 231 L295 240', w: 1.8 },
    { d: 'M383 291 L399 300', w: 1.8 },
    { d: 'M287 209 L391 269', w: 2 },
    { d: 'M287 235 L391 269', w: 1.3 },
  ],
  // Ölçü okları: boru boyu (A→tee) + branşman düşey inişi
  audit: [
    { d: 'M197 130 L182 156', w: 1 },
    { d: 'M284 180 L269 206', w: 1 },
    { d: 'M185 151 L272 201', w: 1 },
    { d: 'M185 151 L191.3 158.1 L194.3 152.9 Z', fill: 'copper', w: 1 },
    { d: 'M272 201 L262.7 199.1 L265.7 193.9 Z', fill: 'copper', w: 1 },
    { d: 'M425 113 L451 113', w: 1 },
    { d: 'M428 148 L451 148', w: 1 },
    { d: 'M445 113 L445 148', w: 1 },
    { d: 'M445 113 L442 122 L448 122 Z', fill: 'copper', w: 1 },
    { d: 'M445 148 L442 139 L448 139 Z', fill: 'copper', w: 1 },
  ],
  // Pafta çerçevesi + hiza tikleri (çizim "yayına hazır")
  finalize: [
    { d: 'M10 10 H630 V410 H10 Z', w: 1.2, o: 0.55 },
    { d: 'M320 10 V3 M320 410 V417 M10 210 H3 M630 210 H637', w: 1, o: 0.55 },
  ],
};

// SVG çizim z-sırası (zemin altta, vana borunun üstünde, pafta en üstte)
const DRAW_ORDER: StageKey[] = [
  'upload', 'steel', 'scan', 'extract', 'size', 'lines', 'rules', 'audit', 'finalize',
];

// Hat bayraklarının içindeki statik etiketler (aşama açılınca belirir)
const SEG_TEXTS: Partial<Record<StageKey, { x: number; y: number; t: string }[]>> = {
  lines: [
    { x: 173, y: 115, t: 'L-101' },
    { x: 319, y: 103, t: 'L-102' },
  ],
};

// Metrik callout'larının SVG konteyneri üzerindeki yüzde konumları
const CALLOUT_POS: Record<StageKey, { left: string; top: string }> = {
  upload:   { left: '3%',  top: '50%' },
  scan:     { left: '40%', top: '10%' },
  extract:  { left: '68%', top: '14%' },
  size:     { left: '62%', top: '47%' },
  lines:    { left: '4%',  top: '30%' },
  rules:    { left: '53%', top: '66%' },
  steel:    { left: '36%', top: '79%' },
  audit:    { left: '72%', top: '40%' },
  finalize: { left: '67%', top: '86%' },
};

const localeOf = (lang: Lang) => (lang === 'tr' ? 'tr-TR' : 'en-GB');

// ── Sunucudan Türkçe gelen metrik etiketleri — EN modda haritayla çevrilir ──
// (sunucu payload'ı değişmez; bilinmeyen etiket olduğu gibi geçer)
const METRIC_LABELS_EN: Record<string, string> = {
  'veri akışı': 'data streams',
  'kayıt': 'records',
  'komponent': 'components',
  'boyutlu': 'sized',
  'hat': 'lines',
  'satır': 'rows',
  'boru m': 'pipe m',
  'profil': 'profiles',
  'kg': 'kg',
  'seviye': 'level',
  'kritik': 'critical',
  'uyarı': 'warnings',
  'durum': 'status',
  'sn': 's',
  'MB': 'MB',
};
// AI tier gibi Türkçe string DEĞERLER için EN karşılıklar
const METRIC_VALUES_EN: Record<string, string> = {
  'basit': 'simple',
  'orta': 'moderate',
  'karmaşık': 'complex',
  'atlandı': 'skipped',
};
const metricLabel = (lang: Lang, k: string) => (lang === 'en' ? METRIC_LABELS_EN[k] ?? k : k);
const metricValue = (lang: Lang, v: string | number) =>
  lang === 'en' && typeof v === 'string' ? METRIC_VALUES_EN[v] ?? v : v;

// ── Count-up: rAF ile eski→yeni değere 600ms yumuşak sayım ──
function CountUp({ value, locale }: { value: number; locale: string }) {
  const decimals = Math.abs(value % 1) > 1e-9 ? 1 : 0;
  const [shown, setShown] = useState(0);
  const shownRef = useRef(0);

  useEffect(() => {
    const from = shownRef.current;
    const to = value;
    if (from === to) return;
    // Hareket azaltma tercihi VEYA gizli sekme (rAF durur): doğrudan hedefe atla
    if (typeof window !== 'undefined' &&
        (window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.visibilityState === 'hidden')) {
      const timer = window.setTimeout(() => {
        shownRef.current = to;
        setShown(to);
      }, 0);
      return () => clearTimeout(timer);
    }
    let raf = 0;
    const t0 = performance.now();
    const DUR = 600;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / DUR);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      const v = from + (to - from) * eased;
      shownRef.current = v;
      setShown(v);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return <>{shown.toLocaleString(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}</>;
}

// Tek metrik satırı: sayıysa count-up'lı "değer anahtar", string ise "anahtar: değer"
// (etiket/değer EN modda label-map'ten çevrilir)
function MetricLine({ k, v, locale, lang }: { k: string; v: string | number; locale: string; lang: Lang }) {
  const label = metricLabel(lang, k);
  const val = metricValue(lang, v);
  if (typeof val === 'number') {
    return (
      <span className="whitespace-nowrap">
        <span className="text-copper-bright"><CountUp value={val} locale={locale} /></span>
        <span className="text-muted"> {label}</span>
      </span>
    );
  }
  return (
    <span className="whitespace-nowrap">
      <span className="text-muted">{label}: </span>
      <span className="text-ink">{val}</span>
    </span>
  );
}

// ── Bir aşamanın çizim katmanı: taslak (hayalet) → çizim → akış ışıması ──
function StageArt({ segs, status, failed }: { segs: Seg[]; status: StageEvent['status']; failed: boolean }) {
  const on = status !== 'pending';
  const active = status === 'active';
  return (
    <g>
      {/* Taslak: her zaman görünen soluk "yapım çizgisi" */}
      {segs.map((s, i) => (
        <path key={`g${i}`} d={s.d} fill="none" stroke="var(--color-steel)" strokeOpacity={0.17}
          strokeWidth={s.w ?? 1.6} strokeDasharray="3 5" strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {/* Asıl çizgi: aktifken kendini çizer (dashoffset 1→0), bitince kalıcı bakır */}
      {on && segs.map((s, i) => (
        <path key={`m${i}`} d={s.d} pathLength={1}
          className={active ? 'pt-draw' : undefined}
          style={{
            strokeDasharray: 1,
            strokeDashoffset: active ? 1 : 0,
            animationDelay: active ? `${i * 0.13}s` : undefined,
          }}
          fill={s.fill === 'panel' ? 'var(--color-panel)'
            : s.fill === 'copper' ? (active ? 'var(--color-copper-bright)' : 'var(--color-copper)')
            : 'none'}
          stroke={active ? 'var(--color-copper-bright)' : 'var(--color-copper)'}
          strokeWidth={s.w ?? 1.6} strokeLinecap="round" strokeLinejoin="round"
          opacity={s.o ?? 1} />
      ))}
      {/* Tarama ışıması: aktif aşamada hat boyunca akan çelik-mavisi enerji */}
      {active && !failed && segs.filter(s => !s.fill).map((s, i) => (
        <path key={`f${i}`} d={s.d} pathLength={1} className="pt-flow"
          fill="none" stroke="var(--color-steel)" strokeOpacity={0.45}
          strokeWidth={(s.w ?? 1.6) + 2.4} strokeDasharray="0.05 0.17" strokeLinecap="round" />
      ))}
    </g>
  );
}

export function ProcessingTheater(props: {
  lang: 'tr' | 'en';
  fileName: string;
  fileSizeMb: number;
  stages: StageEvent[];
  error?: string;
}): JSX.Element {
  const { lang, fileName, fileSizeMb, stages, error } = props;
  const locale = localeOf(lang);
  const failed = Boolean(error);

  const statusMap = new Map<StageKey, StageEvent['status']>(stages.map(s => [s.key, s.status]));
  const st = (k: StageKey) => statusMap.get(k) ?? 'pending';

  const total = stages.length || 9;
  const doneCount = stages.filter(s => s.status === 'done').length;
  const activeStage = stages.find(s => s.status === 'active');
  const allDone = stages.length > 0 && stages.every(s => s.status === 'done');

  // Süre-AĞIRLIKLI ilerleme: deterministik ayrıştırma saniyenin altında biter
  // (7 aşama bir anda tamamlanır) — eşit ağırlıkta gösterince çubuk %83'e zıplayıp
  // AI denetimini beklerken donmuş görünüyordu. Ağırlıklar gerçek süreleri yansıtır;
  // AI aşaması çubuğun büyük kısmını kaplar ve beklerken canlı sürünür.
  const WEIGHT: Record<StageKey, number> = {
    upload: 1, scan: 2, extract: 1, size: 1, lines: 1, rules: 1, steel: 1, audit: 7, finalize: 1,
  };
  const wOf = (k: StageKey) => WEIGHT[k] ?? 1;
  const totalWeight = stages.reduce((s, x) => s + wOf(x.key), 0) || 16;

  // AI denetimi beklerken çubuğu canlı tutmak için hafif tik (400 ms)
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (allDone || failed || activeStage?.key !== 'audit') return;
    const iv = setInterval(() => { if (!document.hidden) forceTick(n => n + 1); }, 400);
    return () => clearInterval(iv);
  }, [allDone, failed, activeStage?.key]);

  let progressWeight = stages.filter(s => s.status === 'done').reduce((s, x) => s + wOf(x.key), 0);
  if (activeStage) {
    const w = wOf(activeStage.key);
    if (activeStage.key === 'audit' && activeStage.startedAt) {
      // geçen süreye göre asimptotik sürünme: aşama ağırlığının %92'sine yaklaşır,
      // ama bitene dek doldurmaz (donmuş değil, ilerliyor hissi)
      const elapsed = Math.max(0, (Date.now() - Date.parse(activeStage.startedAt)) / 1000);
      progressWeight += w * 0.92 * (1 - Math.exp(-elapsed / 3.2));
    } else {
      progressWeight += w * 0.5;
    }
  }
  const pct = allDone ? 100 : Math.min(99, Math.round((progressWeight / totalWeight) * 100));

  // Durum satırı: hata > tamamlandı > aktif aşama > sırada
  const statusText = failed ? UI.failed[lang]
    : allDone ? UI.done[lang]
    : activeStage ? STAGE_LABELS[activeStage.key][lang]
    : UI.waiting[lang];

  // SVG üstünde gösterilecek callout'lar: metriği olan son 4 açık aşama
  const callouts = stages
    .filter(s => s.status !== 'pending' && s.metrics && Object.keys(s.metrics).length > 0)
    .slice(-4);

  const shortName = fileName.length > 22 ? fileName.slice(0, 19) + '…' : fileName;

  return (
    <section className="panel panel-corners overflow-hidden" role="group" aria-label="Processing status">
      {/* Komponent-yerel animasyonlar (globals.css'e dokunmadan) */}
      <style>{`
        @keyframes ptDraw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
        @keyframes ptFlow { from { stroke-dashoffset: 0.22; } to { stroke-dashoffset: 0; } }
        @keyframes ptCalloutIn {
          from { opacity: 0; transform: translateY(7px) scale(0.96); }
          to { opacity: 1; transform: none; }
        }
        @keyframes ptFadeIn { from { opacity: 0; } to { opacity: 1; } }
        .pt-draw { animation: ptDraw 1.5s cubic-bezier(0.4, 0, 0.2, 1) forwards; }
        .pt-flow { animation: ptFlow 1.15s linear infinite; }
        .pt-callout { animation: ptCalloutIn 0.45s cubic-bezier(0.2, 0.7, 0.2, 1) both; }
        .pt-fadein { animation: ptFadeIn 0.5s ease 0.9s both; }
        @media (prefers-reduced-motion: reduce) {
          .pt-draw, .pt-callout, .pt-fadein { animation: none !important; }
          .pt-draw { stroke-dashoffset: 0 !important; }
          .pt-callout, .pt-fadein { opacity: 1 !important; transform: none !important; }
          .pt-flow { display: none; }
          .pt-fill { transition: none !important; }
        }
        /* Dar ekranda callout'lar üst üste biner — gizle; aynı metrikler
           soldaki aşama listesinde çip olarak zaten görünüyor */
        @media (max-width: 639px) {
          .pt-callout { display: none; }
        }
      `}</style>

      {/* ── Başlık: dosya çipi + durum + yüzde ── */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="chip">
            <span className="chip-dot" style={{ background: failed ? 'var(--color-danger)' : 'var(--color-copper)' }} />
            <span className="max-w-[220px] truncate">{fileName}</span>
            <span className="text-muted">· {fileSizeMb.toLocaleString(locale, { maximumFractionDigits: 1 })} MB</span>
          </span>
        </div>
        <div className="flex items-baseline gap-3">
          <span aria-live="polite"
            className={`text-[12px] font-medium ${failed ? 'text-danger' : allDone ? 'text-mint' : 'text-muted'}`}>
            {statusText}
          </span>
          <span className="font-data text-[20px] leading-none text-copper-bright">
            <CountUp value={pct} locale={locale} />%
          </span>
        </div>
      </header>

      {/* ── Gövde: sol aşama listesi + sağ izometrik sahne ── */}
      <div className="grid gap-6 p-5 md:grid-cols-[248px_minmax(0,1fr)]">
        {/* Aşama listesi (mobilde çizimin altına düşer) */}
        <ol className="order-2 md:order-1">
          {stages.map(s => {
            const label = STAGE_LABELS[s.key][lang];
            const isActive = s.status === 'active';
            const isDone = s.status === 'done';
            const entries = s.metrics ? Object.entries(s.metrics) : [];
            return (
              <li key={s.key}
                className="flex items-start gap-3 border-b border-line/60 py-2.5 pl-2 last:border-b-0"
                style={isActive ? { background: 'var(--row-hover)', borderRadius: 6 } : undefined}>
                {/* Durum işareti */}
                <span className="mt-[3px] flex h-[14px] w-[14px] shrink-0 items-center justify-center">
                  {isDone ? (
                    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                      <path d="M2.5 7.5 L5.5 10.5 L11.5 3.5" fill="none" stroke="var(--color-copper)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : isActive ? (
                    <span className={`chip-dot ${failed ? '' : 'pulse'} h-[8px] w-[8px]`}
                      style={{ background: failed ? 'var(--color-danger)' : 'var(--color-copper-bright)' }} />
                  ) : (
                    <span className="h-[9px] w-[9px] rounded-[2px] border border-line" />
                  )}
                </span>
                <div className="min-w-0">
                  <div className={`text-[12.5px] leading-tight ${
                    isActive ? 'font-semibold text-ink' : isDone ? 'font-medium text-ink' : 'text-muted'
                  }`}>
                    {label}
                  </div>
                  {entries.length > 0 && (isActive || isDone) && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {entries.map(([k, v]) => (
                        <span key={k} className="chip !py-[2px] !text-[10px]">
                          <MetricLine k={k} v={v} locale={locale} lang={lang} />
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        {/* İzometrik sahne */}
        <div className="relative order-1 md:order-2">
          <svg viewBox="0 0 640 420" className="h-auto w-full" aria-hidden="true">
            {/* Statik dekor: antet (title block) + hiza artıları */}
            <g stroke="var(--color-line)" strokeWidth="1" fill="none">
              <rect x="14" y="14" width="136" height="52" rx="2" />
              <path d="M14 31 H150 M14 48 H150" />
              <path d="M594 40 H606 M600 34 V46" strokeOpacity="0.6" />
              <path d="M54 374 H66 M60 368 V380" strokeOpacity="0.6" />
            </g>
            <g className="font-data" fontSize="8" fill="var(--color-muted)">
              <text x="20" y="26" fill="var(--color-copper)" letterSpacing="2">METRIQ</text>
              <text x="20" y="43">NWD TAKE-OFF</text>
              <text x="20" y="60">{shortName.toUpperCase()}</text>
              <text x="128" y="26" textAnchor="end" fill="var(--color-copper)">NTS</text>
            </g>

            {/* Aşama katmanları (z-sırası: zemin → çelik → borular → ... → pafta) */}
            {DRAW_ORDER.map(k => (
              <StageArt key={k} segs={SEGMENTS[k]} status={st(k)} failed={failed} />
            ))}

            {/* Hat bayrağı etiketleri: aşama açılınca belirir */}
            {(Object.keys(SEG_TEXTS) as StageKey[]).map(k =>
              st(k) === 'pending' ? null : SEG_TEXTS[k]!.map(txt => (
                <text key={`${k}-${txt.t}`} x={txt.x} y={txt.y} textAnchor="middle"
                  className={`font-data ${st(k) === 'active' ? 'pt-fadein' : ''}`}
                  fontSize="9" letterSpacing="1" fill="var(--color-copper)">
                  {txt.t}
                </text>
              ))
            )}
          </svg>

          {/* Teknik ölçü callout'ları: gerçek metriklerle CAD etiketi gibi yerine oturur */}
          {callouts.map(s => {
            const pos = CALLOUT_POS[s.key];
            const isActive = s.status === 'active';
            return (
              <div key={s.key}
                className="pt-callout pointer-events-none absolute z-10 select-none rounded-md border px-2.5 py-1.5 font-data text-[11px] leading-[1.5]"
                style={{
                  left: pos.left,
                  top: pos.top,
                  background: 'var(--color-panel2)',
                  borderColor: isActive ? 'var(--copper-soft)' : 'var(--color-line)',
                  opacity: isActive ? 1 : 0.78,
                  boxShadow: isActive ? '0 2px 14px var(--copper-glow)' : 'none',
                }}>
                <div className="flex items-start gap-2">
                  <span className="mt-[4px] inline-block h-[6px] w-[6px] shrink-0 rotate-45 border"
                    style={{ borderColor: 'var(--color-copper)' }} />
                  <div className="flex flex-col">
                    {Object.entries(s.metrics!).map(([k, v]) => (
                      <MetricLine key={k} k={k} v={v} locale={locale} lang={lang} />
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Hata paneli ── */}
      {error && (
        <div className="mx-5 mb-4 flex items-start gap-3 rounded-lg border border-danger/40 px-4 py-3"
          style={{ background: 'rgba(208, 119, 111, 0.06)' }}>
          <svg width="16" height="16" viewBox="0 0 16 16" className="mt-[1px] shrink-0" aria-hidden="true">
            <rect x="1" y="1" width="14" height="14" rx="3" fill="none" stroke="var(--color-danger)" strokeWidth="1.3" />
            <path d="M5.5 5.5 L10.5 10.5 M10.5 5.5 L5.5 10.5" stroke="var(--color-danger)" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <div className="min-w-0">
            <div className="text-[12.5px] font-semibold text-danger">{UI.failed[lang]}</div>
            <div className="mt-0.5 break-words font-data text-[11px] text-danger/90">{error}</div>
          </div>
        </div>
      )}

      {/* ── İlerleme "ölçü çizgisi" (dimline estetiği) ── */}
      <footer className="px-5 pb-5">
        <div className="relative h-[30px]">
          {/* Uç tikleri */}
          <span className="absolute bottom-[6px] left-0 h-[13px] w-px" style={{ background: 'var(--color-copper)' }} />
          <span className="absolute bottom-[6px] right-0 h-[13px] w-px" style={{ background: 'var(--color-copper)' }} />
          {/* Taban çizgisi + aşama bölme tikleri */}
          <span className="absolute bottom-[12px] left-0 right-0 h-px" style={{ background: 'var(--color-line)' }} />
          {Array.from({ length: Math.max(total - 1, 0) }, (_, i) => (
            <span key={i} className="absolute bottom-[10px] h-[5px] w-px"
              style={{ left: `${((i + 1) / total) * 100}%`, background: 'var(--color-line)' }} />
          ))}
          {/* Bakır dolgu + uç noktası */}
          <span className="pt-fill absolute bottom-[12px] left-0 h-px"
            style={{
              width: `${pct}%`,
              background: failed ? 'var(--color-danger)' : 'var(--color-copper)',
              transition: 'width 0.7s cubic-bezier(0.4, 0, 0.2, 1)',
            }} />
          <span className="pt-fill absolute bottom-[10px] h-[5px] w-[5px] -translate-x-1/2 rotate-45"
            style={{
              left: `${pct}%`,
              background: failed ? 'var(--color-danger)' : 'var(--color-copper-bright)',
              transition: 'left 0.7s cubic-bezier(0.4, 0, 0.2, 1)',
            }} />
          {/* Etiket */}
          <span className="absolute -top-px left-1/2 -translate-x-1/2 font-data text-[10.5px] tracking-wider text-muted">
            {doneCount}/{total} · <span className="text-copper-bright"><CountUp value={pct} locale={locale} />%</span>
          </span>
        </div>
      </footer>
    </section>
  );
}
