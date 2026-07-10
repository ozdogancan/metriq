'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  createColumnHelper, flexRender, getCoreRowModel, getSortedRowModel,
  useReactTable, type SortingState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { t, type Lang } from '@/lib/i18n';
import type { AnswerDiff, Calibration, MtoRow, Run, SteelRow } from '@/lib/types';

type Tab = 'rows' | 'steel' | 'info';

// TanStack meta: hücre renderer'ları düzenleme callback'lerine buradan ulaşır
interface MtoTableMeta {
  lang: Lang;
  onEdit: (id: string, patch: Partial<MtoRow>) => void;
  onRemove: (id: string) => void;
}

// Sayısal hücre: teklif-kritik giriş. Taslak string state + blur/Enter'da commit —
// her tuşta Number()'a çevirmek ondalık noktayı yutuyordu (12.5 → 125 hatası).
// TR virgülü de kabul edilir; geçersiz giriş eski değere döner.
function NumCell({ value, nullable, label, onCommit }: {
  value: number | null; nullable?: boolean; label: string; onCommit: (v: number | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value == null ? '' : String(value));
  function commit() {
    if (draft == null) return;
    const raw = draft.trim().replace(',', '.');
    if (raw === '') { onCommit(nullable ? null : 0); setDraft(null); return; }
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n)) onCommit(n);
    setDraft(null); // geçersizse eski değere döner
  }
  return (
    <input
      className="!text-right"
      inputMode="decimal"
      aria-label={label}
      value={shown}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setDraft(null);
      }}
    />
  );
}

export function RunDetail({ lang, run, initialRows, steel, calibrations }: {
  lang: Lang; run: Run; initialRows: MtoRow[]; steel: SteelRow[]; calibrations: Calibration[];
}) {
  const [rows, setRows] = useState(initialRows);
  const [tab, setTab] = useState<Tab>('rows');
  const [lineFilter, setLineFilter] = useState('');
  const [q, setQ] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [calName, setCalName] = useState('');
  const [answer, setAnswer] = useState<AnswerDiff | null>(run.answer ?? null);
  const [answerBusy, setAnswerBusy] = useState(false);
  const answerFileRef = useRef<HTMLInputElement>(null);

  const tr = lang === 'tr';

  // kaydedilmemiş düzenlemeler sekme kapanışında kaybolmasın
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const lines = useMemo(() => [...new Set(rows.map(r => r.line))].sort(), [rows]);
  const main = rows.filter(r => r.scope === 'MAIN');
  const info = rows.filter(r => r.scope === 'INFO');

  const visible = (tab === 'info' ? info : main).filter(r =>
    (!lineFilter || r.line === lineFilter) &&
    (!q || `${r.code} ${r.sub} ${r.remark}`.toLowerCase().includes(q.toLowerCase()))
  );

  function edit(id: string, patch: Partial<MtoRow>) {
    setRows(prev => prev.map(r => r.id === id ? { ...r, ...patch, edited: true } : r));
    setDirty(true); setSaving('idle');
  }

  function addRow() {
    const id = `ru-${crypto.randomUUID().slice(0, 12)}`;
    const row: MtoRow = {
      id, line: lineFilter || '?', code: '', sub: '',
      s1: null, s2: 0, qty: 0, unit: 'EA',
      remark: tr ? 'elle eklendi' : 'added manually',
      scope: tab === 'info' ? 'INFO' : 'MAIN', edited: true,
    };
    setRows(prev => [...prev, row]);
    setDirty(true); setSaving('idle');
  }

  function removeRow(id: string) {
    setRows(prev => prev.filter(r => r.id !== id));
    setDirty(true); setSaving('idle');
  }

  async function save(): Promise<boolean> {
    setSaving('saving');
    try {
      const res = await fetch(`/api/runs/${run.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rows }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      setSaving('saved'); setDirty(false);
      toast.success(tr ? 'Düzenlemeler kaydedildi' : 'Edits saved');
      return true;
    } catch (e) {
      setSaving('idle');
      toast.error((tr ? 'Kaydedilemedi: ' : 'Save failed: ') + (e instanceof Error ? e.message : ''));
      return false;
    }
  }

  // müşteri cevap Excel'i: ground truth karşılaştırması ("bu dosyanın doğru cevabı bu")
  async function uploadAnswer(file: File) {
    setAnswerBusy(true);
    try {
      const fd = new FormData();
      fd.set('file', file);
      const res = await fetch(`/api/runs/${run.id}/answer`, { method: 'POST', body: fd });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setAnswer(d.answer);
      toast.success(tr
        ? `Cevap karşılaştırıldı: %${d.answer.accuracy} eşleşme`
        : `Answer compared: ${d.answer.accuracy}% match`);
    } catch (e) {
      toast.error((tr ? 'Karşılaştırılamadı: ' : 'Comparison failed: ') + (e instanceof Error ? e.message : ''));
    } finally {
      setAnswerBusy(false);
    }
  }

  // kirli durumda Excel indirme eski rakamları verir — önce kaydet, sonra indir
  async function downloadExcel() {
    if (dirty) {
      const ok = await save();
      if (!ok) return;
    }
    window.location.href = `/api/runs/${run.id}/excel`;
  }

  async function saveCalibration() {
    // düzenlemeler kaydedilmeden profil çıkarmak yanıltıcı olur
    if (dirty) {
      const ok = await save();
      if (!ok) return;
    }
    const base = calibrations.find(c => c.id === run.calibrationId);
    const name = calName.trim() || base?.name || (tr ? `${run.projectName} kalibrasyonu` : `${run.projectName} calibration`);
    // kod düzenlemelerinden öğren: orijinal kod → yeni kod eşlemeleri
    const renames: Record<string, string> = { ...(base?.rules.codeRenames ?? {}) };
    const byId = new Map(initialRows.map(r => [r.id, r]));
    for (const r of rows) {
      const orig = byId.get(r.id);
      if (orig && r.edited && orig.code && r.code && orig.code !== r.code) renames[orig.code] = r.code;
    }
    // hat kapsamından öğren: tüm ana satırları silinen hatlar → kapsam-dışı kuralı
    const mainBefore = new Set(initialRows.filter(r => r.scope === 'MAIN').map(r => r.line));
    const mainNow = new Set(rows.filter(r => r.scope === 'MAIN').map(r => r.line));
    const removedLines = [...mainBefore].filter(l => !mainNow.has(l) && l !== '*' && l !== '?');
    const excludeLines = [...new Set([...(base?.rules.excludeLines ?? []), ...removedLines])];
    try {
      const rules = { ...(base?.rules ?? defaultRulesFor(run)), codeRenames: renames, excludeLines };
      const res = await fetch('/api/calibrations', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: base?.id, name, rules,
          learnedFrom: [...new Set([...(base?.learnedFrom ?? []), run.id])],
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      // öğrenme günlüğüne kalibrasyon olayını da düş (fail-soft)
      fetch(`/api/runs/${run.id}/events`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: [{ kind: 'calibration_saved', before: base?.rules ?? null, after: rules }] }),
      }).catch(() => {});
      setCalName('');
      const learned = Object.keys(renames).length - Object.keys(base?.rules.codeRenames ?? {}).length;
      const learnedLines = removedLines.length;
      const parts: string[] = [];
      if (learned > 0) parts.push(tr ? `${learned} kod eşlemesi` : `${learned} code mapping(s)`);
      if (learnedLines > 0) parts.push(tr ? `${learnedLines} kapsam-dışı hat` : `${learnedLines} excluded line(s)`);
      toast.success(
        (tr ? 'Kalibrasyon kaydedildi' : 'Calibration saved') +
        (parts.length ? ` · ${tr ? 'öğrenildi' : 'learned'}: ${parts.join(', ')}` : '')
      );
    } catch (e) {
      toast.error((tr ? 'Kalibrasyon kaydedilemedi: ' : 'Calibration save failed: ') + (e instanceof Error ? e.message : ''));
    }
  }

  const totals = run.totals;
  const num = (n: number, d = 1) => n.toLocaleString(tr ? 'tr-TR' : 'en-GB', { maximumFractionDigits: d });

  return (
    <div className="space-y-6">
      {/* başlık */}
      <div className="rise flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href="/" className="font-data text-[11px] text-muted hover:text-copper transition-colors"
            onClick={e => {
              if (dirty && !window.confirm(tr ? 'Kaydedilmemiş düzenlemeler var. Yine de çıkılsın mı?' : 'You have unsaved edits. Leave anyway?')) e.preventDefault();
            }}>← METRIQ</Link>
          <h1 className="mt-1 text-[22px] font-bold tracking-tight">{run.projectName}</h1>
          <div className="mt-1 font-data text-[11px] text-muted">
            {run.fileName} · {(run.fileSize / 1e6).toFixed(1)} MB · {new Date(run.createdAt).toLocaleString(tr ? 'tr-TR' : 'en-GB')}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {dirty && (
            <button onClick={save} disabled={saving === 'saving'} className="btn btn-primary">
              {saving === 'saving' ? t(lang, 'saving') : t(lang, 'save')}
            </button>
          )}
          {saving === 'saved' && <span className="chip"><span className="chip-dot bg-mint" />{t(lang, 'saved')}</span>}
          <button onClick={() => answerFileRef.current?.click()} disabled={answerBusy} className="btn"
            title={tr ? 'Müşterinin cevap Excel\'ini yükle — sonuçla karşılaştırılır' : 'Upload the client\'s answer Excel — compared against the result'}>
            {answerBusy ? (tr ? 'Karşılaştırılıyor…' : 'Comparing…') : (tr ? '⇪ Cevapla karşılaştır' : '⇪ Compare with answer')}
          </button>
          <input ref={answerFileRef} type="file" accept=".xlsx" hidden
            onChange={e => { const f = e.target.files?.[0]; if (f) uploadAnswer(f); e.target.value = ''; }} />
          <button onClick={downloadExcel} disabled={saving === 'saving'} className="btn btn-primary">
            ⤓ {t(lang, 'download_excel')}{dirty ? ' *' : ''}
          </button>
        </div>
      </div>

      {/* cevap karşılaştırma karnesi */}
      {answer && <AnswerPanel lang={lang} answer={answer} />}

      {/* özet kartları */}
      <div className="rise rise-1 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Card label={t(lang, 'pipe_total')} value={`${num(totals.pipeM)} m`} accent="copper" />
        <Card label={t(lang, 'fittings')} value={num(totals.fittingsEa, 0)} accent="steel" />
        <Card label={t(lang, 'flanges')} value={num(totals.flangesEa, 0)} accent="steel" />
        <Card label={t(lang, 'valves')} value={num(totals.valvesEa, 0)} accent="steel" />
        <Card label={t(lang, 'steel')} value={totals.steelM > 0 ? `${num(totals.steelM)} m · ${num(totals.steelKg, 0)} kg` : '—'} accent="mint" />
      </div>

      {/* bağlantı elemanları şeridi */}
      <div className="rise rise-2 flex flex-wrap items-center gap-2 font-data text-[11px] text-muted">
        <span className="chip">{t(lang, 'gaskets')}: {run.fasteners.gaskets}</span>
        <span className="chip">{t(lang, 'bolt_sets')}: {run.fasteners.boltSets}</span>
        <span className="chip">{t(lang, 'stub_ends')}: {run.fasteners.stubEnds}</span>
        <span className="ml-auto">{t(lang, 'net_note')}</span>
      </div>

      {/* AI denetçi bulguları */}
      {run.ai && (
        <div className="rise rise-2 panel panel-corners px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] font-semibold uppercase tracking-wider text-copper">
              ⛨ {tr ? 'AI Denetçi' : 'AI Auditor'}
            </span>
            <span className="chip font-data">{run.ai.model.replace('claude-', '')}</span>
            <span className="chip font-data">
              {tr ? 'karmaşıklık' : 'complexity'} {run.ai.complexity}/100 · {tierLabel(run.ai.tier, lang)}
            </span>
            {run.ai.findings.length === 0 && (
              <span className="chip"><span className="chip-dot bg-mint" />{tr ? 'bulgu yok' : 'no findings'}</span>
            )}
          </div>
          {run.ai.summary && <p className="mt-2.5 text-[13px] leading-relaxed text-muted">{run.ai.summary}</p>}
          {run.ai.findings.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {run.ai.findings.map((f, i) => (
                <li key={i} className="flex items-start gap-2 text-[12.5px] leading-snug">
                  <span className="chip-dot mt-1.5 shrink-0" style={{
                    background: f.severity === 'critical' ? 'var(--color-danger)' : f.severity === 'warn' ? 'var(--color-copper)' : 'var(--color-steel)',
                  }} />
                  <span className={f.severity === 'critical' ? 'text-danger' : ''}>{f.message}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2.5 font-data text-[10px] text-muted">
            {tr
              ? 'AI yalnız işaretler; rakamlar deterministik motordan gelir. Bulguları kontrol edip satırları düzenleyebilirsin — düzeltmelerin sistemi eğitir.'
              : 'AI only flags; numbers come from the deterministic engine. Review findings and edit rows — your corrections train the system.'}
          </p>
        </div>
      )}

      {/* sekmeler + filtreler */}
      <div className="rise rise-3 flex flex-wrap items-center gap-2">
        {([['rows', t(lang, 'run_rows'), main.length], ['steel', t(lang, 'run_steel'), steel.length], ['info', t(lang, 'run_info'), info.length]] as [Tab, string, number][]).map(([k, label, n]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`btn ${tab === k ? '!border-copper/60 !bg-copper/10 !text-copper-bright' : 'btn-ghost'}`}>
            {label} <span className="font-data text-[10px] opacity-70">{n}</span>
          </button>
        ))}
        {tab !== 'steel' && (
          <>
            <select value={lineFilter} onChange={e => setLineFilter(e.target.value)}
              aria-label={t(lang, 'all_lines')}
              className="panel ml-auto px-3 py-2 text-[12px] outline-none">
              <option value="">{t(lang, 'all_lines')}</option>
              {lines.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder={t(lang, 'search')}
              aria-label={t(lang, 'search')}
              className="panel w-40 px-3 py-2 text-[12px] outline-none focus:border-copper/50" />
          </>
        )}
      </div>

      {/* tablo — MTO sekmesi TanStack Table (sıralama + virtualizasyon) */}
      {tab === 'steel' ? (
        <div className="panel panel-corners rise rise-4 overflow-auto" style={{ maxHeight: '58vh' }}>
          <SteelTable lang={lang} steel={steel} />
        </div>
      ) : (
        <MtoTable
          lang={lang} rows={visible} onEdit={edit} onRemove={removeRow}
          emptyMsg={q || lineFilter
            ? (tr ? 'Filtreye uyan satır yok.' : 'No rows match the filter.')
            : (tr ? 'Bu sekmede satır yok.' : 'No rows in this tab.')}
        />
      )}

      {tab !== 'steel' && (
        <div className="rise rise-4 -mt-3">
          <button onClick={addRow} className="btn btn-ghost !text-[12px]">
            + {tr ? 'Satır ekle' : 'Add row'}
          </button>
        </div>
      )}

      <AiInsight lang={lang} runId={run.id} />

      {/* kalibrasyon kaydet */}
      <div className="rise rise-4 flex flex-wrap items-center gap-3 border-t border-line pt-5">
        <input value={calName} onChange={e => setCalName(e.target.value)}
          placeholder={`${t(lang, 'calibration')} — ${t(lang, 'name').toLowerCase()}`}
          aria-label={t(lang, 'calibration')}
          className="panel w-64 px-3.5 py-2.5 text-[13px] outline-none focus:border-copper/50" />
        <button onClick={saveCalibration} className="btn">◈ {t(lang, 'save_calibration')}</button>
        <span className="font-data text-[11px] text-muted">
          {tr ? 'Kod düzeltmelerin profile işlenir; sonraki metrajlara uygulanır.' : 'Your code corrections are folded into the profile; applied to future takeoffs.'}
        </span>
      </div>
    </div>
  );
}

// ---- MTO tablosu: TanStack Table v8 (headless, sıralama) + react-virtual ----
const colh = createColumnHelper<MtoRow>();
const meta = (table: { options: { meta?: unknown } }) => table.options.meta as MtoTableMeta;

const MTO_COLUMNS = [
  colh.accessor('line', {
    id: 'line',
    header: ctx => t(meta(ctx.table).lang, 'col_line'),
    cell: ctx => {
      const m = meta(ctx.table); const r = ctx.row.original;
      return <input value={r.line} aria-label={`${t(m.lang, 'col_line')} ${r.code}`}
        onChange={e => m.onEdit(r.id, { line: e.target.value })} />;
    },
  }),
  colh.accessor('code', {
    id: 'code',
    header: ctx => t(meta(ctx.table).lang, 'col_code'),
    cell: ctx => {
      const m = meta(ctx.table); const r = ctx.row.original;
      return <input value={r.code} aria-label={`${t(m.lang, 'col_code')} ${r.line}`}
        onChange={e => m.onEdit(r.id, { code: e.target.value })} />;
    },
  }),
  colh.accessor('sub', {
    id: 'sub', enableSorting: false,
    header: ctx => t(meta(ctx.table).lang, 'col_sub'),
    cell: ctx => {
      const m = meta(ctx.table); const r = ctx.row.original;
      return <input value={r.sub} aria-label={t(m.lang, 'col_sub')}
        onChange={e => m.onEdit(r.id, { sub: e.target.value })} />;
    },
  }),
  colh.accessor('s1', {
    id: 's1', sortUndefined: 'last',
    header: ctx => t(meta(ctx.table).lang, 'col_size1'),
    cell: ctx => {
      const m = meta(ctx.table); const r = ctx.row.original;
      return <NumCell value={r.s1} nullable label={`${t(m.lang, 'col_size1')} ${r.code}`}
        onCommit={v => m.onEdit(r.id, { s1: v })} />;
    },
  }),
  colh.accessor('s2', {
    id: 's2', enableSorting: false,
    header: ctx => t(meta(ctx.table).lang, 'col_size2'),
    cell: ctx => {
      const m = meta(ctx.table); const r = ctx.row.original;
      return <NumCell value={r.s2 || null} nullable label={`${t(m.lang, 'col_size2')} ${r.code}`}
        onCommit={v => m.onEdit(r.id, { s2: v ?? 0 })} />;
    },
  }),
  colh.accessor('qty', {
    id: 'qty',
    header: ctx => t(meta(ctx.table).lang, 'col_qty'),
    cell: ctx => {
      const m = meta(ctx.table); const r = ctx.row.original;
      return <NumCell value={r.qty} label={`${t(m.lang, 'col_qty')} ${r.code}`}
        onCommit={v => m.onEdit(r.id, { qty: v ?? 0 })} />;
    },
  }),
  colh.accessor('unit', {
    id: 'unit', enableSorting: false,
    header: ctx => t(meta(ctx.table).lang, 'col_unit'),
    cell: ctx => {
      const m = meta(ctx.table); const r = ctx.row.original;
      return (
        <select value={r.unit} aria-label={t(m.lang, 'col_unit')}
          onChange={e => m.onEdit(r.id, { unit: e.target.value as MtoRow['unit'] })}
          className="bg-transparent outline-none">
          <option value="M">M</option><option value="EA">EA</option>
        </select>
      );
    },
  }),
  colh.accessor('remark', {
    id: 'remark', enableSorting: false,
    header: ctx => t(meta(ctx.table).lang, 'col_remark'),
    cell: ctx => {
      const r = ctx.row.original;
      return <>{r.remark}{r.edited && <span className="ml-2 text-copper">●</span>}</>;
    },
  }),
  colh.display({
    id: 'actions',
    header: () => null,
    cell: ctx => {
      const m = meta(ctx.table); const r = ctx.row.original;
      const tr = m.lang === 'tr';
      return (
        <button onClick={() => m.onRemove(r.id)} aria-label={tr ? `satırı sil: ${r.code}` : `delete row: ${r.code}`}
          className="text-muted transition-colors hover:text-danger" title={tr ? 'Satırı sil' : 'Delete row'}>×</button>
      );
    },
  }),
];

// sütun hizalama/genişlik sınıfları (tasarım eskisiyle birebir)
const TD_CLASS: Record<string, string> = {
  line: 'text-muted w-20', code: '', sub: 'text-muted',
  s1: 'num !text-right w-20', s2: 'num !text-right w-20', qty: 'num !text-right w-24',
  unit: 'text-muted w-16', remark: 'text-muted text-[11px]', actions: 'w-8 text-center',
};
const TH_RIGHT = new Set(['s1', 's2', 'qty']);

function MtoTable({ lang, rows, onEdit, onRemove, emptyMsg }: {
  lang: Lang; rows: MtoRow[]; emptyMsg: string;
  onEdit: (id: string, patch: Partial<MtoRow>) => void;
  onRemove: (id: string) => void;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const table = useReactTable({
    data: rows,
    columns: MTO_COLUMNS,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: r => r.id,
    meta: { lang, onEdit, onRemove } satisfies MtoTableMeta,
  });
  const tableRows = table.getRowModel().rows;

  // 80+ satırda virtualizasyon — dev metrajlarda da akıcı kaydırma
  const virtual = rows.length > 80;
  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 37,
    overscan: 12,
    enabled: virtual,
  });
  const vItems = virtualizer.getVirtualItems();
  const padTop = virtual && vItems.length ? vItems[0].start : 0;
  const padBottom = virtual && vItems.length ? virtualizer.getTotalSize() - vItems[vItems.length - 1].end : 0;
  const renderRows = virtual ? vItems.map(v => tableRows[v.index]) : tableRows;

  return (
    <div ref={scrollRef} className="panel panel-corners rise rise-4 overflow-auto" style={{ maxHeight: '58vh' }}>
      <table className="mtable">
        <thead>
          {table.getHeaderGroups().map(hg => (
            <tr key={hg.id}>
              {hg.headers.map(h => {
                const sortable = h.column.getCanSort();
                const dir = h.column.getIsSorted();
                return (
                  <th key={h.id}
                    className={`${TH_RIGHT.has(h.column.id) ? '!text-right' : ''} ${sortable ? 'cursor-pointer select-none' : ''}`}
                    onClick={sortable ? h.column.getToggleSortingHandler() : undefined}
                    aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}>
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {dir === 'asc' ? ' ▲' : dir === 'desc' ? ' ▼' : ''}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody className="font-data">
          {padTop > 0 && <tr><td colSpan={MTO_COLUMNS.length} style={{ height: padTop, padding: 0, border: 0 }} /></tr>}
          {renderRows.map(row => (
            <tr key={row.id}>
              {row.getVisibleCells().map(cell => (
                <td key={cell.id} className={TD_CLASS[cell.column.id] ?? ''}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
          {padBottom > 0 && <tr><td colSpan={MTO_COLUMNS.length} style={{ height: padBottom, padding: 0, border: 0 }} /></tr>}
          {rows.length === 0 && (
            <tr>
              <td colSpan={MTO_COLUMNS.length} className="py-8 text-center text-[12.5px] text-muted">{emptyMsg}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---- cevap karşılaştırma karnesi: müşteri Excel'i = ground truth ----
const ANSWER_STATUS: Record<string, { tr: string; en: string; color: string }> = {
  missing: { tr: 'bizde eksik', en: 'missing in ours', color: 'var(--color-danger)' },
  qty_diff: { tr: 'miktar farkı', en: 'qty differs', color: 'var(--color-copper)' },
  extra: { tr: 'bizde fazla', en: 'extra in ours', color: 'var(--color-steel)' },
  match: { tr: 'eşleşti', en: 'matched', color: 'var(--color-mint)' },
};

function AnswerPanel({ lang, answer }: { lang: Lang; answer: AnswerDiff }) {
  const tr = lang === 'tr';
  const [showAll, setShowAll] = useState(false);
  const problems = answer.rows.filter(r => r.status !== 'match');
  const shown = showAll ? problems : problems.slice(0, 12);
  const accColor = answer.accuracy >= 95 ? 'var(--color-mint)' : answer.accuracy >= 80 ? 'var(--color-copper-bright)' : 'var(--color-danger)';
  return (
    <div className="rise rise-1 panel panel-corners px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[12px] font-semibold uppercase tracking-wider text-copper">
          ⇪ {tr ? 'Cevap karşılaştırması' : 'Answer comparison'}
        </span>
        <span className="num text-[22px] font-bold" style={{ color: accColor }}>%{answer.accuracy}</span>
        <span className="chip"><span className="chip-dot" style={{ background: 'var(--color-mint)' }} />{answer.counts.matched} {tr ? 'eşleşti' : 'matched'}</span>
        {answer.counts.qtyDiff > 0 && <span className="chip"><span className="chip-dot" style={{ background: 'var(--color-copper)' }} />{answer.counts.qtyDiff} {tr ? 'miktar farkı' : 'qty diff'}</span>}
        {answer.counts.missing > 0 && <span className="chip"><span className="chip-dot" style={{ background: 'var(--color-danger)' }} />{answer.counts.missing} {tr ? 'bizde eksik' : 'missing'}</span>}
        {answer.counts.extra > 0 && <span className="chip"><span className="chip-dot" style={{ background: 'var(--color-steel)' }} />{answer.counts.extra} {tr ? 'bizde fazla' : 'extra'}</span>}
        <span className="ml-auto font-data text-[10px] text-muted">{answer.fileName}</span>
      </div>
      {problems.length > 0 && (
        <div className="mt-3 overflow-auto">
          <table className="mtable">
            <thead>
              <tr>
                <th>{tr ? 'durum' : 'status'}</th><th>{tr ? 'kod' : 'code'}</th>
                <th className="!text-right">{tr ? 'çap' : 'size'}</th>
                <th className="!text-right">{tr ? 'biz' : 'ours'}</th>
                <th className="!text-right">{tr ? 'cevap' : 'answer'}</th>
              </tr>
            </thead>
            <tbody className="font-data">
              {shown.map((r, i) => {
                const s = ANSWER_STATUS[r.status];
                return (
                  <tr key={i}>
                    <td><span className="chip text-[10.5px]"><span className="chip-dot" style={{ background: s.color }} />{tr ? s.tr : s.en}</span></td>
                    <td>{r.code}</td>
                    <td className="num !text-right">{r.s1 ?? '?'}{r.s2 ? `x${r.s2}` : ''}″ {r.unit}</td>
                    <td className="num !text-right">{r.ours}</td>
                    <td className="num !text-right">{r.answer}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {problems.length > 12 && (
            <button onClick={() => setShowAll(v => !v)} className="btn btn-ghost mt-2 !text-[11px]">
              {showAll ? (tr ? 'daralt' : 'collapse') : `${problems.length - 12} ${tr ? 'satır daha göster' : 'more rows'}`}
            </button>
          )}
        </div>
      )}
      <p className="mt-2.5 font-data text-[10px] text-muted">
        {tr
          ? 'Karşılaştırma yalnız ölçer — rakamlarına dokunmaz. Farklı satırları ekranda düzeltip "Kalibrasyon olarak kaydet" dersen sistem bu müşteriyi öğrenir.'
          : 'Comparison only measures — it never changes your numbers. Fix differing rows on screen and "Save as calibration" to teach the system this client.'}
      </p>
    </div>
  );
}

function tierLabel(tier: string, lang: Lang): string {
  if (lang === 'tr') return tier;
  return tier === 'basit' ? 'simple' : tier === 'orta' ? 'medium' : tier === 'karmaşık' ? 'complex' : tier;
}

function AiInsight({ lang, runId }: { lang: Lang; runId: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'hidden'>('idle');
  const [text, setText] = useState('');
  if (state === 'hidden') return null;
  async function gen() {
    setState('loading');
    try {
      const res = await fetch(`/api/runs/${runId}/insight`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lang }),
      });
      if (res.status === 404) { setState('hidden'); return; }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setText(data.text); setState('done');
    } catch (e) {
      setState('idle');
      toast.error((lang === 'tr' ? 'AI özeti üretilemedi: ' : 'AI summary failed: ') + (e instanceof Error ? e.message : ''));
    }
  }
  return (
    <div className="rise panel panel-corners px-5 py-4">
      <div className="flex items-center justify-between">
        <div className="text-[12px] font-semibold uppercase tracking-wider text-steel">✦ {t(lang, 'ai_insight')}</div>
        {state !== 'done' && (
          <button onClick={gen} disabled={state === 'loading'} className="btn btn-ghost !text-[12px]">
            {state === 'loading' ? t(lang, 'ai_generating') : (lang === 'tr' ? 'Üret →' : 'Generate →')}
          </button>
        )}
      </div>
      {state === 'done' && <p className="mt-2 text-[13px] leading-relaxed text-ink/90">{text}</p>}
    </div>
  );
}

function Card({ label, value, accent }: { label: string; value: string; accent: 'copper' | 'steel' | 'mint' }) {
  const col = accent === 'copper' ? 'var(--color-copper-bright)' : accent === 'mint' ? 'var(--color-mint)' : 'var(--color-steel)';
  return (
    <div className="panel panel-corners px-4 py-3.5">
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className="num mt-1 text-[19px] font-bold" style={{ color: col }}>{value}</div>
    </div>
  );
}

function SteelTable({ lang, steel }: { lang: Lang; steel: SteelRow[] }) {
  const loc = lang === 'tr' ? 'tr-TR' : 'en-GB';
  const fmt = (n: number, d: number) => n.toLocaleString(loc, { minimumFractionDigits: d, maximumFractionDigits: d });
  const totM = steel.reduce((s, r) => s + r.lengthMm * r.count, 0) / 1000;
  const totKg = steel.reduce((s, r) => s + r.totalKg, 0);
  const totN = steel.reduce((s, r) => s + r.count, 0);
  return (
    <table className="mtable">
      <thead>
        <tr>
          <th>{t(lang, 'col_profile')}</th><th className="!text-right">{t(lang, 'col_length')}</th>
          <th className="!text-right">{t(lang, 'col_count')}</th><th className="!text-right">{t(lang, 'col_total_m')}</th>
          <th className="!text-right">{t(lang, 'col_total_kg')}</th>
        </tr>
      </thead>
      <tbody className="font-data">
        {steel.map(r => (
          <tr key={r.id}>
            <td>{r.profile}</td>
            <td className="num !text-right">{r.lengthMm.toLocaleString(loc)}</td>
            <td className="num !text-right">{r.count}</td>
            <td className="num !text-right">{fmt((r.lengthMm * r.count) / 1000, 2)}</td>
            <td className="num !text-right">{fmt(r.totalKg, 1)}</td>
          </tr>
        ))}
        {steel.length === 0 && (
          <tr>
            <td colSpan={5} className="py-8 text-center text-[12.5px] text-muted">
              {lang === 'tr' ? 'Bu modelde çelik profili bulunamadı.' : 'No steel profiles found in this model.'}
            </td>
          </tr>
        )}
        {steel.length > 0 && (
          <tr className="font-bold">
            <td>{lang === 'tr' ? 'TOPLAM' : 'TOTAL'}</td><td /><td className="num !text-right">{totN}</td>
            <td className="num !text-right text-mint">{fmt(totM, 2)}</td>
            <td className="num !text-right text-mint">{fmt(totKg, 1)}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function defaultRulesFor(run: Run) {
  return {
    vocab: run.vocab,
    merge45Into90: true,
    collarOneToOne: run.vocab === 'hygienic',
    excludeCompanionFlanges: run.vocab !== 'hygienic',
    includeValvesInMain: run.vocab === 'hygienic',
    includeFasteners: false,
    grossPipeFactor: 1.0,
    codeRenames: {},
  };
}
