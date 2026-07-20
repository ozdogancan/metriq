'use client';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { projectedAccuracy, type CalibrationDecisionInput } from '@/lib/calibration-core';
import {
  createColumnHelper, flexRender, getCoreRowModel, getSortedRowModel,
  useReactTable, type SortingState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { t, type Lang } from '@/lib/i18n';
import type { AnswerDiff, AnswerDiffRow, AnswerRowStatus, Calibration, MtoRow, Run, SteelRow } from '@/lib/types';
import { ModelViewerPanel } from '@/components/model-viewer';
import { MAX_ANSWER_XLSX_BYTES } from '@/lib/upload-policy';

type Tab = 'rows' | 'steel';

// TanStack meta: hücre renderer'ları düzenleme callback'lerine buradan ulaşır
interface MtoTableMeta {
  lang: Lang;
  onEdit: (id: string, patch: Partial<MtoRow>) => void;
  onRemove: (id: string) => void;
  onView?: (row: MtoRow) => void; // "modelde göster" — yalnız bulut (APS) metrajlarında
}

// Sayısal hücre: teklif-kritik giriş. Taslak string state + blur/Enter'da commit —
// her tuşta Number()'a çevirmek ondalık noktayı yutuyordu (12.5 → 125 hatası).
// TR virgülü de kabul edilir; geçersiz giriş eski değere döner.
function NumCell({ value, nullable, positive, label, onCommit }: {
  value: number | null; nullable?: boolean; positive?: boolean; label: string; onCommit: (v: number | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value == null ? '' : String(value));
  function commit() {
    if (draft == null) return;
    const raw = draft.trim().replace(',', '.');
    if (raw === '') { onCommit(nullable ? null : 0); setDraft(null); return; }
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n) && (positive ? n > 0 : n >= 0)) onCommit(n);
    setDraft(null); // geçersizse eski değere döner
  }
  return (
    <input
      className="!text-right"
      inputMode="decimal"
      min={positive ? Number.EPSILON : 0}
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
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [tab, setTab] = useState<Tab>('rows');
  const [lineFilter, setLineFilter] = useState('');
  const [q, setQ] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [calName, setCalName] = useState('');
  const [answer, setAnswer] = useState<AnswerDiff | null>(run.answer ?? null);
  const [answerBusy, setAnswerBusy] = useState(false);
  const [freshAnswerId, setFreshAnswerId] = useState<string | null>(null); // bu oturumda yüklenen karşılaştırma → panele kaydır
  const answerFileRef = useRef<HTMLInputElement>(null);
  // "modelde göster" — yalnız bulut (APS) metrajlarında; null = panel kapalı
  const [viewerFocus, setViewerFocus] = useState<{ rowIds: string[]; label: string } | null>(null);
  const canView = Boolean(run.aps?.urn);
  const openViewer = (row: MtoRow) => setViewerFocus({
    rowIds: [row.id],
    label: `${row.code} ${row.s1 ?? '?'}${row.s2 ? `x${row.s2}` : ''}″ · ${row.line} · ${row.qty}${row.unit}`,
  });

  const tr = lang === 'tr';

  // geri bildirim uygulandıktan sonra: satırları/karneyi sunucudan tazele
  async function refetchRun() {
    try {
      const r = await fetch(`/api/runs/${run.id}`, { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      if (Array.isArray(d.rows)) setRows(d.rows);
      setAnswer(d.run?.answer ?? null);
      setDirty(false);
      router.refresh();
    } catch { /* sıradaki etkileşimde toparlanır */ }
  }

  // kaydedilmemiş düzenlemeler sekme kapanışında kaybolmasın
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const lines = useMemo(() => [...new Set(rows.map(r => r.line))].sort(), [rows]);
  const main = rows.filter(r => r.scope === 'MAIN');
  // INFO satırları (destek/refakat-flanşı/kapsam-dışı hat) artık ayrı sekmede
  // GÖSTERİLMEZ ama veride kalır: teklif toplamı ve VANA sayımı doğru kalsın diye.

  const visible = main.filter(r =>
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
      scope: 'MAIN', edited: true,
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
    if (file.size <= 0 || file.size > MAX_ANSWER_XLSX_BYTES) {
      toast.error(tr ? 'Cevap dosyası en fazla 4 MB olabilir.' : 'The answer file can be at most 4 MB.');
      return;
    }
    setAnswerBusy(true);
    try {
      const fd = new FormData();
      fd.set('file', file);
      const res = await fetch(`/api/runs/${run.id}/answer`, { method: 'POST', body: fd });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setAnswer(d.answer);
      setFreshAnswerId(d.answer?.id ?? null); // panel taze karşılaştırmaya kayar
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
          id: base?.id, expectedVersion: base?.version ?? 0, name, rules,
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
          <input ref={answerFileRef} type="file" accept=".xlsx,.xlsm" hidden
            onChange={e => { const f = e.target.files?.[0]; if (f) uploadAnswer(f); e.target.value = ''; }} />
          <button onClick={downloadExcel} disabled={saving === 'saving'} className="btn btn-primary">
            ⤓ {t(lang, 'download_excel')}{dirty ? ' *' : ''}
          </button>
        </div>
      </div>

      {/* cevap karşılaştırma karnesi + karar tezgâhı */}
      {answer && (
        <AnswerPanel lang={lang} run={run} answer={answer} calibrations={calibrations} dirty={dirty}
          freshId={freshAnswerId}
          onApplied={next => { setAnswer(next); router.refresh(); }} />
      )}

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
          {run.ai.summary && (
            <p className="mt-2.5 text-[13px] leading-relaxed text-muted">
              {tr ? run.ai.summary : (run.ai.summaryEn ?? run.ai.summary)}
            </p>
          )}
          {run.ai.findings.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {run.ai.findings.map((f, i) => (
                <li key={i} className="flex items-start gap-2 text-[12.5px] leading-snug">
                  <span className="chip-dot mt-1.5 shrink-0" style={{
                    background: f.severity === 'critical' ? 'var(--color-danger)' : f.severity === 'warn' ? 'var(--color-copper)' : 'var(--color-steel)',
                  }} />
                  <span className={f.severity === 'critical' ? 'text-danger' : ''}>
                    {tr ? f.message : (f.messageEn ?? f.message)}
                  </span>
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
        {([['rows', t(lang, 'run_rows'), main.length], ['steel', t(lang, 'run_steel'), steel.length]] as [Tab, string, number][]).map(([k, label, n]) => (
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
          onView={canView ? openViewer : undefined}
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

      {/* manuel-düzeltme profili — cevap-tezgâhından AYRI, daha dar bir öğrenme yolu */}
      <div className="rise rise-4 flex flex-wrap items-center gap-3 border-t border-line pt-5">
        <input value={calName} onChange={e => setCalName(e.target.value)}
          placeholder={`${t(lang, 'calibration')} — ${t(lang, 'name').toLowerCase()}`}
          aria-label={t(lang, 'calibration')}
          className="panel w-64 px-3.5 py-2.5 text-[13px] outline-none focus:border-copper/50" />
        <button onClick={saveCalibration} className="btn">◈ {t(lang, 'save_calibration')}</button>
        <span className="font-data text-[11px] text-muted">
          {answer && !answer.appliedAt
            ? (tr
              ? 'Cevap karşılaştırması açıkken kalibrasyonu YUKARIDAKİ panelden yap — bu buton yalnız tablodaki manuel kod/hat düzeltmelerinden öğrenir.'
              : 'While an answer comparison is open, calibrate from the panel ABOVE — this button only learns from manual code/line edits in the table.')
            : (tr
              ? 'Tablodaki manuel kod/hat düzeltmelerinden öğrenir; cevap Excel\'inden öğrenmek için yukarıdan cevap yükle.'
              : 'Learns from manual code/line edits in the table; to learn from an answer Excel, upload one above.')}
        </span>
      </div>

      {/* sonuç geri bildirimi → öğrenme döngüsü */}
      <FeedbackPanel lang={lang} runId={run.id} onApplied={refetchRun} />

      {/* 3B model paneli */}
      {viewerFocus && canView && (
        <ModelViewerPanel lang={lang} runId={run.id}
          focusRowIds={viewerFocus.rowIds} focusLabel={viewerFocus.label}
          onClose={() => setViewerFocus(null)} />
      )}
    </div>
  );
}

// ---- geri bildirim paneli: serbest metin → AI kural çevirisi → kapsam seçimi → yeniden uygula ----
function FeedbackPanel({ lang, runId, onApplied }: {
  lang: Lang; runId: string; onApplied: () => void;
}) {
  const tr = lang === 'tr';
  const [text, setText] = useState('');
  const [step, setStep] = useState<'write' | 'scope'>('write');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    applied: boolean; summary: string; unmappable?: string; profile?: string | null;
    changes?: { renamed: number; excludedLines: number; corrections: number; changedRows: number };
  } | null>(null);

  async function submit(scope: 'file' | 'global') {
    setBusy(true);
    setResult(null);
    try {
      const r = await fetch(`/api/runs/${runId}/feedback`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: text.trim(), scope }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setResult({
        applied: Boolean(d.applied),
        summary: tr ? d.summaryTr : (d.summaryEn ?? d.summaryTr),
        unmappable: d.unmappable || undefined,
        profile: d.profile ?? null,
        changes: d.changes,
      });
      if (d.applied) {
        toast.success(tr
          ? `Geri bildirim uygulandı — ${d.changes.changedRows} satır güncellendi`
          : `Feedback applied — ${d.changes.changedRows} rows updated`);
        setText('');
        setStep('write');
        onApplied();
      }
    } catch (e) {
      toast.error((tr ? 'Geri bildirim uygulanamadı: ' : 'Feedback failed: ') + (e instanceof Error ? e.message : ''));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rise rise-4 panel panel-corners px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[12px] font-semibold uppercase tracking-wider text-copper">
          💬 {tr ? 'Sonuç hakkında geri bildirim' : 'Feedback on this result'}
        </span>
        <span className="font-data text-[10.5px] text-muted">
          {tr
            ? 'Serbestçe yaz — sistem kurala çevirir, uygular ve istersen sonraki dosyalar için öğrenir.'
            : 'Write freely — the system turns it into rules, applies them, and can learn for future files.'}
        </span>
      </div>

      <textarea value={text} onChange={e => { setText(e.target.value); if (step === 'scope') setStep('write'); }}
        rows={3} maxLength={2000}
        placeholder={tr
          ? 'Örn: "GR-166-3DM-014 hattı mevcut tesisat, kapsam dışı olsun" · "BSP FITTING yerine THREADED FITTING yazılsın" · "6″ CAP kalemi bilgi bölümüne insin"'
          : 'E.g. "Line GR-166-3DM-014 is existing plant, take it out of scope" · "Rename BSP FITTING to THREADED FITTING"'}
        className="panel mt-3 w-full resize-y px-3.5 py-2.5 font-data text-[12.5px] outline-none focus:border-copper/60" />

      {step === 'write' && (
        <div className="mt-2 flex items-center gap-3">
          <button onClick={() => setStep('scope')} disabled={busy || text.trim().length < 5} className="btn !text-[12px]">
            {tr ? 'Yorumla ve uygula →' : 'Interpret & apply →'}
          </button>
          <span className="font-data text-[10px] text-muted">
            {tr ? 'Rakamlar uydurulmaz: yalnız kod/kapsam kuralları türetilir.' : 'No invented numbers: only code/scope rules are derived.'}
          </span>
        </div>
      )}

      {/* kapsam sorusu: bu dosyaya özel mi, kalıcı öğrenme mi? */}
      {step === 'scope' && (
        <div className="mt-3">
          <p className="font-data text-[11.5px] text-muted">
            {tr ? 'Bu geri bildirim nerede geçerli olsun?' : 'Where should this feedback apply?'}
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <button onClick={() => submit('file')} disabled={busy}
              className="btn !h-auto !items-start !px-4 !py-3 text-left">
              <span className="block">
                <span className="block text-[13px] font-semibold">📄 {tr ? 'Yalnız bu dosya' : 'Only this file'}</span>
                <span className="mt-1 block font-data text-[10.5px] text-muted">
                  {tr ? 'Kurallar bu metraja uygulanır; profil değişmez.' : 'Rules apply to this take-off; the profile is untouched.'}
                </span>
              </span>
            </button>
            <button onClick={() => submit('global')} disabled={busy}
              className="btn btn-primary !h-auto !items-start !px-4 !py-3 text-left">
              <span className="block">
                <span className="block text-[13px] font-semibold">🌐 {tr ? 'Tüm dosyalarda öğren' : 'Learn for all files'}</span>
                <span className="mt-1 block font-data text-[10.5px] opacity-85">
                  {tr ? 'Bu metraja uygulanır + profile işlenir; sonraki dosyalar otomatik faydalanır.' : 'Applies here + folds into the profile; future files benefit automatically.'}
                </span>
              </span>
            </button>
          </div>
          {busy && (
            <p className="mt-2 font-data text-[11px] text-copper-bright">
              {tr ? 'Geri bildirim yorumlanıyor ve uygulanıyor…' : 'Interpreting and applying feedback…'}
            </p>
          )}
        </div>
      )}

      {result && (
        <div className="mt-3 rounded border px-3.5 py-2.5 font-data text-[11.5px]"
          style={result.applied ? {
            borderColor: 'color-mix(in oklab, var(--color-mint) 35%, transparent)',
            background: 'color-mix(in oklab, var(--color-mint) 8%, transparent)',
          } : {
            borderColor: 'color-mix(in oklab, var(--color-copper) 40%, transparent)',
            background: 'color-mix(in oklab, var(--color-copper) 7%, transparent)',
          }}>
          {result.applied ? (
            <>
              ✓ {result.summary}
              {result.changes && (
                <span className="text-muted">
                  {' — '}{result.changes.changedRows} {tr ? 'satır güncellendi' : 'rows updated'}
                  {result.changes.excludedLines > 0 && ` · ${result.changes.excludedLines} ${tr ? 'hat kapsam dışı' : 'lines excluded'}`}
                  {result.changes.renamed > 0 && ` · ${result.changes.renamed} ${tr ? 'kod çevrildi' : 'codes renamed'}`}
                </span>
              )}
              {result.profile && (
                <span className="text-mint"> · {tr ? 'profil öğrendi' : 'profile learned'}: {result.profile}</span>
              )}
              {result.unmappable && (
                <div className="mt-1 text-muted">⚠ {tr ? 'Kurala çevrilemeyen kısım' : 'Not mappable'}: {result.unmappable}</div>
              )}
            </>
          ) : (
            <>
              ⚠ {tr ? 'Bu geri bildirimden uygulanabilir kural çıkaramadım.' : 'I could not derive an applicable rule from this feedback.'}
              {result.unmappable && <div className="mt-1 text-muted">{result.unmappable}</div>}
            </>
          )}
        </div>
      )}
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
      return <NumCell value={r.s1} nullable positive label={`${t(m.lang, 'col_size1')} ${r.code}`}
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
        <span className="flex items-center gap-2">
          {m.onView && (
            <button onClick={() => m.onView!(r)} aria-label={tr ? `modelde göster: ${r.code}` : `show in model: ${r.code}`}
              className="text-muted transition-colors hover:text-copper-bright"
              title={tr ? 'Modelde göster — bu satırın nesnelerine zoom' : 'Show in model — zoom to this row\'s objects'}>◎</button>
          )}
          <button onClick={() => m.onRemove(r.id)} aria-label={tr ? `satırı sil: ${r.code}` : `delete row: ${r.code}`}
            className="text-muted transition-colors hover:text-danger" title={tr ? 'Satırı sil' : 'Delete row'}>×</button>
        </span>
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

function MtoTable({ lang, rows, onEdit, onRemove, onView, emptyMsg }: {
  lang: Lang; rows: MtoRow[]; emptyMsg: string;
  onEdit: (id: string, patch: Partial<MtoRow>) => void;
  onRemove: (id: string) => void;
  onView?: (row: MtoRow) => void;
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
    meta: { lang, onEdit, onRemove, onView } satisfies MtoTableMeta,
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

// ---- cevap karşılaştırma karnesi + karar tezgâhı: müşteri Excel'i = ground truth ----
const ANSWER_STATUS: Record<string, { tr: string; en: string; color: string; tipTr: string; tipEn: string }> = {
  missing: {
    tr: 'Excel\'de var · bizde yok', en: 'in Excel only', color: 'var(--color-danger)',
    tipTr: 'Cevap Excel\'inde var, bizim metrajda yok — Cevap seçersen satır eklenir',
    tipEn: 'In the answer Excel but not in our take-off — choosing Answer adds the row',
  },
  qty_diff: {
    tr: 'miktar farkı', en: 'qty differs', color: 'var(--color-copper)',
    tipTr: 'Kod ve çap aynı, miktarlar farklı', tipEn: 'Same code and size, quantities differ',
  },
  field_diff: {
    tr: 'çap/kod farkı', en: 'size/code differs', color: 'var(--color-copper)',
    tipTr: 'Miktar aynı, kod veya çap farklı', tipEn: 'Same quantity, code or size differs',
  },
  extra: {
    tr: 'bizde var · Excel\'de yok', en: 'in ours only', color: 'var(--color-steel)',
    tipTr: 'Bizde var, cevap Excel\'inde yok — Cevap seçersen satır çıkarılır',
    tipEn: 'In our take-off but not in the answer — choosing Answer removes the row',
  },
  match: {
    tr: 'eşleşti', en: 'matched', color: 'var(--color-mint)',
    tipTr: 'İki taraf aynı — karar gerekmez', tipEn: 'Both sides agree — no decision needed',
  },
};

type CustomDraft = { code: string; s1: string; s2: string; qty: string; unit: 'M' | 'EA' };

function draftFrom(r: AnswerDiffRow): CustomDraft {
  const v = r.answerSide?.value ?? r.oursSide?.value;
  return {
    code: v?.code ?? r.code, s1: v?.s1 == null ? '' : String(v.s1),
    s2: String(v?.s2 ?? 0), qty: String(v?.qty ?? (r.answer || r.ours)), unit: v?.unit ?? r.unit,
  };
}

function AnswerPanel({ lang, run, answer, calibrations, dirty, freshId, onApplied }: {
  lang: Lang; run: Run; answer: AnswerDiff; calibrations: Calibration[];
  dirty: boolean; freshId: string | null; onApplied: (next: AnswerDiff) => void;
}) {
  const tr = lang === 'tr';
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilterState] = useState<'diffs' | AnswerRowStatus>('diffs');
  const [busy, setBusy] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const scrolledForRef = useRef<string | null>(null);
  // bu oturumda yüklenen taze karşılaştırma → panel görünür olsun (kullanıcı "göremiyorum" demişti)
  useEffect(() => {
    if (freshId && answer.id === freshId && scrolledForRef.current !== freshId) {
      scrolledForRef.current = freshId;
      panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [freshId, answer.id]);
  const setFilter = (f: 'diffs' | AnswerRowStatus) => { setFilterState(f); setShowAll(false); };
  const [decisions, setDecisions] = useState<Map<string, 'ours' | 'answer' | 'custom'>>(new Map());
  const [customs, setCustoms] = useState<Map<string, CustomDraft>>(new Map());
  const targetProfile = calibrations.find(c => c.id === run.calibrationId);
  const [profileName, setProfileName] = useState(
    targetProfile?.name ?? (tr ? `${run.projectName} kalibrasyonu` : `${run.projectName} calibration`));

  const problems = answer.rows.filter(r => r.status !== 'match');
  // tablo havuzu: uyum çubuğundaki duruma tıklayınca o durum filtrelenir.
  // Fark SIFIRSA (%100) varsayılan görünüm eşleşenlerdir — kullanıcı "iki tarafın
  // değerini satır satır görmem lazım" dedi; boş tablo göstermek yanlıştı.
  const effectiveFilter = filter === 'diffs' && problems.length === 0 ? 'match' : filter;
  const pool = effectiveFilter === 'diffs' ? problems : answer.rows.filter(r => r.status === effectiveFilter);
  const shownRows = showAll ? pool : pool.slice(0, 12);
  const applied = Boolean(answer.appliedAt);
  const decidable = !applied && problems.length > 0 && problems.every(r => r.id);

  const choiceOf = (id: string) => decisions.get(id) ?? 'ours';
  function setChoice(id: string, c: 'ours' | 'answer' | 'custom', row?: AnswerDiffRow) {
    setDecisions(prev => new Map(prev).set(id, c));
    if (c === 'custom' && row && !customs.has(id)) {
      setCustoms(prev => new Map(prev).set(id, draftFrom(row)));
    }
  }
  function setAll(c: 'ours' | 'answer') {
    // toplu karar satır-bazlı seçimleri ezer — kullanıcının emeği sessizce kaybolmasın
    if (decisions.size > 0 && !window.confirm(tr
      ? `Satır bazlı ${decisions.size} seçimin var — hepsinin üzerine yazılsın mı?`
      : `You have ${decisions.size} per-row selections — overwrite them all?`)) return;
    setDecisions(new Map(problems.filter(r => r.id).map(r => [r.id!, c])));
  }

  // canlı öngörü: bu kararlarla karne yüzde kaça çıkar
  const decisionInputs: CalibrationDecisionInput[] = problems.filter(r => r.id).map(r => {
    const choice = choiceOf(r.id!);
    if (choice !== 'custom') return { itemId: r.id!, choice };
    const d = customs.get(r.id!) ?? draftFrom(r);
    const s1 = d.s1.trim() === '' ? null : Number.parseFloat(d.s1.replace(',', '.'));
    return {
      itemId: r.id!, choice,
      custom: {
        code: d.code.trim().toUpperCase(), s1: Number.isFinite(s1 as number) ? s1 : null,
        s2: Number.parseFloat(d.s2.replace(',', '.')) || 0,
        qty: Number.parseFloat(d.qty.replace(',', '.')) || 0, unit: d.unit,
      },
    };
  });
  const projected = decidable ? projectedAccuracy(answer, decisionInputs) : answer.accuracy;
  const changedCount = decisionInputs.filter(d => d.choice !== 'ours').length;

  async function applyWith(inputs: CalibrationDecisionInput[]) {
    const bad = inputs.find(d => d.choice === 'custom' && (!d.custom || d.custom.qty <= 0 || !d.custom.code));
    if (bad) { toast.error(tr ? 'Özel değerlerde kod ve pozitif miktar zorunlu.' : 'Custom values need a code and positive qty.'); return; }
    if (!profileName.trim()) { toast.error(tr ? 'Profil adı boş olamaz.' : 'Profile name required.'); return; }
    setBusy(true);
    try {
      const res = await fetch(`/api/runs/${run.id}/answer/apply`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          comparisonId: answer.id,
          idempotencyKey: crypto.randomUUID(),
          ...(targetProfile ? { profileId: targetProfile.id, expectedProfileVersion: targetProfile.version ?? 1 } : { expectedProfileVersion: 0 }),
          profileName: profileName.trim(),
          decisions: inputs,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      toast.success(tr
        ? `Kalibre edildi: %${answer.accuracy} → %${d.answer.accuracy} · ${d.learned.activatedRules} kural öğrenildi`
        : `Calibrated: ${answer.accuracy}% → ${d.answer.accuracy}% · learned ${d.learned.activatedRules} rule(s)`);
      onApplied(d.answer as AnswerDiff);
    } catch (e) {
      toast.error((tr ? 'Kalibre edilemedi: ' : 'Calibration failed: ') + (e instanceof Error ? e.message : ''));
    } finally {
      setBusy(false);
    }
  }
  const applyDecisions = () => applyWith(decisionInputs);

  // Tek tık: Excel'in TAMAMINI kabul et ve hemen kalibre et (kullanıcının ana akışı)
  function acceptAllAndCalibrate() {
    if (busy || dirty) return;
    const inputs: CalibrationDecisionInput[] = problems.filter(r => r.id).map(r => ({ itemId: r.id!, choice: 'answer' as const }));
    if (!inputs.length) return;
    const proj = projectedAccuracy(answer, inputs);
    const fd = answer.counts.fieldDiff ?? 0;
    const ok = window.confirm(tr
      ? `Excel cevabının TAMAMI kabul edilecek:\n\n· ${answer.counts.missing} eksik kalem eklenecek\n· ${answer.counts.extra} fazla kalem çıkarılacak\n· ${answer.counts.qtyDiff + fd} kalem Excel değerine güncellenecek\n\nKarne %${answer.accuracy} → %${proj}. Profil bu kararlardan kural öğrenir ve sonraki dosyaya otomatik uygulanır. Devam?`
      : `The ENTIRE Excel answer will be accepted:\n\n· ${answer.counts.missing} missing items added\n· ${answer.counts.extra} extra items removed\n· ${answer.counts.qtyDiff + fd} items updated to Excel values\n\nScorecard ${answer.accuracy}% → ${proj}%. The profile learns rules from this and auto-applies to the next file. Continue?`);
    if (!ok) return;
    setDecisions(new Map(inputs.map(i => [i.itemId, 'answer' as const])));
    void applyWith(inputs);
  }

  const accColor = answer.accuracy >= 90 ? 'var(--color-mint)' : answer.accuracy >= 75 ? 'var(--color-copper-bright)' : 'var(--color-danger)';
  const fieldDiffCount = answer.counts.fieldDiff ?? 0;
  const answerItemCount = answer.counts.matched + answer.counts.qtyDiff + fieldDiffCount + answer.counts.missing;
  // uyum çubuğu bölümleri: [durum, adet, renk, etiket]
  const barSegments: Array<{ key: 'diffs' | AnswerRowStatus; n: number; color: string; label: string }> = [
    { key: 'match', n: answer.counts.matched, color: 'var(--color-mint)', label: tr ? 'eşleşti' : 'matched' },
    { key: 'qty_diff', n: answer.counts.qtyDiff, color: 'var(--color-copper)', label: tr ? 'miktar farkı' : 'qty differs' },
    { key: 'field_diff', n: fieldDiffCount, color: 'var(--color-copper-bright)', label: tr ? 'çap/kod farkı' : 'size/code' },
    { key: 'missing', n: answer.counts.missing, color: 'var(--color-danger)', label: tr ? 'bizde eksik' : 'missing' },
    { key: 'extra', n: answer.counts.extra, color: 'var(--color-steel)', label: tr ? 'bizde fazla' : 'extra' },
  ];
  const barTotal = barSegments.reduce((s, x) => s + x.n, 0) || 1;
  return (
    <div ref={panelRef} className="rise rise-1 panel panel-corners scroll-mt-4 px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[12px] font-semibold uppercase tracking-wider text-copper">
          {decidable ? '1 · ' : ''}⇪ {tr ? 'Excel cevabı × bizim metraj' : 'Excel answer × our take-off'}
        </span>
        <span className="num text-[22px] font-bold" style={{ color: accColor }}>%{answer.accuracy}</span>
        {decidable && changedCount > 0 && projected !== answer.accuracy && (
          <span className="num text-[13px] text-mint">→ %{projected}</span>
        )}
        <span className="font-data text-[10px] text-muted">{tr ? 'hedef' : 'target'} %{answer.targetAccuracy ?? 90}</span>
        {applied && <span className="chip"><span className="chip-dot" style={{ background: 'var(--color-mint)' }} />{tr ? 'kalibre edildi' : 'calibrated'}{answer.calibrationVersion ? ` · v${answer.calibrationVersion}` : ''}</span>}
        <span className="ml-auto font-data text-[10px] text-muted">
          {answer.fileName} · “{answer.sheet}” · {answerItemCount} {tr ? 'kalem okundu' : 'items read'}
        </span>
      </div>

      {/* uyum çubuğu: iki listenin nasıl örtüştüğü tek bakışta */}
      <div className="mt-3">
        <div className="flex h-2.5 w-full overflow-hidden rounded border border-line" role="img"
          aria-label={barSegments.filter(s => s.n > 0).map(s => `${s.n} ${s.label}`).join(', ')}>
          {barSegments.filter(s => s.n > 0).map(s => (
            <div key={s.key} style={{ width: `${(s.n / barTotal) * 100}%`, background: s.color, opacity: 0.85 }} />
          ))}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 font-data text-[10.5px]">
          {barSegments.filter(s => s.n > 0).map(s => (
            <button key={s.key} onClick={() => setFilter(s.key)}
              className={`flex items-center gap-1.5 transition-colors ${effectiveFilter === s.key ? 'text-ink' : 'text-muted hover:text-ink'}`}
              title={tr ? 'Tabloda yalnız bu durumu göster' : 'Filter the table to this status'}>
              <span className="inline-block h-2 w-2 rounded-sm" style={{ background: s.color }} />
              {s.n} {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* karar: iki yol — tek tıkla komple kabul+kalibre YA DA satır satır */}
      {decidable && (
        <div className="mt-4">
          <span className="text-[12px] font-semibold uppercase tracking-wider text-copper">
            2 · {tr ? 'Karar ver' : 'Decide'}
          </span>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <button onClick={acceptAllAndCalibrate} disabled={busy || dirty}
              className="btn btn-primary !h-auto !items-start !px-4 !py-3 text-left">
              <span className="block">
                <span className="block text-[13px] font-semibold">
                  ✓ {tr ? 'Excel cevabını komple kabul et + kalibre et' : 'Accept the entire Excel + calibrate'}
                </span>
                <span className="mt-1 block font-data text-[10.5px] opacity-85">
                  {tr
                    ? `Tek tıkla: ${problems.length} farkın tamamı Excel değerine çekilir, profil öğrenir → %${projectedAccuracy(answer, problems.filter(r => r.id).map(r => ({ itemId: r.id!, choice: 'answer' as const })))}`
                    : `One click: all ${problems.length} differences take the Excel values, the profile learns → ${projectedAccuracy(answer, problems.filter(r => r.id).map(r => ({ itemId: r.id!, choice: 'answer' as const })))}%`}
                </span>
              </span>
            </button>
            <div className="panel flex flex-col justify-center px-4 py-3">
              <span className="text-[13px] font-semibold">
                ⚙ {tr ? 'ya da satır satır incele' : 'or review row by row'}
              </span>
              <span className="mt-1 font-data text-[10.5px] text-muted">
                {tr
                  ? 'Aşağıdaki tabloda her fark için seç: Biz = bizim değer kalır · Cevap = Excel değeri yazılır · Özel = kendin yaz. Sonra "Kalibre et ve öğren".'
                  : 'In the table below choose per difference: Ours = keep · Answer = take Excel value · Custom = type your own. Then "Calibrate & learn".'}
              </span>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button onClick={() => setAll('answer')} className="btn btn-ghost !text-[11px]"
              title={tr ? 'Tüm fark satırlarını "Cevap" olarak işaretler — kaydetmeden önce gözden geçirebilirsin' : 'Marks every diff row as "Answer" — review before saving'}>
              {tr ? 'Tümünü Cevap işaretle (kaydetmeden)' : 'Mark all as Answer (without saving)'}
            </button>
            <button onClick={() => setAll('ours')} className="btn btn-ghost !text-[11px]"
              title={tr ? 'Tüm satırlarda bizim değer kalır (satır seçimlerinin üzerine yazar)' : 'Keeps our value on every row (overwrites per-row selections)'}>
              {tr ? 'Bizimkileri koru' : 'Keep ours'}
            </button>
          </div>
        </div>
      )}

      {/* fark yok (%100): kabul edilecek bir şey kalmadığını AÇIKÇA söyle —
          yoksa kullanıcı "komple kabul et butonu nerede" diye arıyor */}
      {!applied && problems.length === 0 && (
        <div className="mt-3 rounded border px-3.5 py-2.5 font-data text-[11.5px]"
          style={{
            borderColor: 'color-mix(in oklab, var(--color-mint) 35%, transparent)',
            background: 'color-mix(in oklab, var(--color-mint) 8%, transparent)',
          }}>
          ✓ {tr
            ? <>Fark yok — metraj Excel cevabıyla <b>birebir eşleşiyor</b> ({answer.counts.matched} kalem). Kabul edilecek/düzeltilecek bir şey kalmadı; aşağıdaki tabloda her kalemin iki taraftaki değeri satır satır görünür.</>
            : <>No differences — the take-off <b>matches the Excel answer exactly</b> ({answer.counts.matched} items). Nothing to accept or fix; the table below shows both sides&apos; values row by row.</>}
        </div>
      )}

      {/* kalibre edildikten sonra: ne olduğunu net söyle */}
      {applied && (
        <div className="mt-3 rounded border px-3.5 py-2.5 font-data text-[11.5px]"
          style={{
            borderColor: 'color-mix(in oklab, var(--color-mint) 35%, transparent)',
            background: 'color-mix(in oklab, var(--color-mint) 8%, transparent)',
          }}>
          ✓ {tr
            ? <>Kalibre edildi{answer.calibrationVersion ? ` — profil v${answer.calibrationVersion}` : ''} · karne %{answer.accuracy}. Kabul ettiğin değerler satırlara işlendi; öğrenilen kurallar bu müşterinin <b>sonraki dosyasına otomatik</b> uygulanacak. Aşağıdaki tablo son durumu gösterir.</>
            : <>Calibrated{answer.calibrationVersion ? ` — profile v${answer.calibrationVersion}` : ''} · scorecard {answer.accuracy}%. Accepted values were applied to the rows; learned rules will <b>auto-apply to this client&apos;s next file</b>. The table below shows the final state.</>}
        </div>
      )}

      {answer.rows.length > 0 && (
        <div className="mt-3 overflow-auto">
          <table className="mtable">
            <thead>
              <tr>
                <th>{tr ? 'durum' : 'status'}</th><th>{tr ? 'kod' : 'code'}</th>
                <th className="!text-right">{tr ? 'çap' : 'size'}</th>
                <th className="!text-right" title={tr ? 'Metriq motorunun modelden hesapladığı miktar' : 'Quantity computed by the Metriq engine from the model'}>
                  {tr ? 'bizim miktar' : 'our qty'}
                </th>
                <th className="!text-right" title={`${tr ? 'Müşteri cevap dosyası' : 'Client answer file'}: ${answer.fileName}`}>
                  {tr ? 'Excel cevabı' : 'answer (Excel)'}
                </th>
                {decidable && <th>{tr ? 'karar' : 'decision'}</th>}
              </tr>
            </thead>
            <tbody className="font-data">
              {shownRows.map((r, i) => {
                const s = ANSWER_STATUS[r.status] ?? ANSWER_STATUS.qty_diff;
                const c = r.id ? choiceOf(r.id) : 'ours';
                const d = r.id ? (customs.get(r.id) ?? draftFrom(r)) : draftFrom(r);
                // kod/çap farkında İKİ tarafı da göster: biz → cevap (yön hep aynı)
                const oursV = r.oursSide?.value, ansV = r.answerSide?.value;
                const codeCell = r.status === 'field_diff' && oursV && ansV && oursV.code !== ansV.code
                  ? `${oursV.code} → ${ansV.code}`
                  : r.code;
                const sizeOf = (v: { s1: number | null; s2: number }) => `${v.s1 ?? '?'}${v.s2 ? `x${v.s2}` : ''}″`;
                const sizesDiffer = oursV && ansV && (oursV.s1 !== ansV.s1 || oursV.s2 !== ansV.s2);
                const sizeCell = r.status === 'field_diff' && oursV && ansV && sizesDiffer
                  ? `${sizeOf(oursV)} → ${sizeOf(ansV)} ${r.unit}`
                  : `${r.s1 ?? '?'}${r.s2 ? `x${r.s2}` : ''}″ ${r.unit}`;
                return (
                  <Fragment key={r.id ?? i}>
                    <tr>
                      <td><span className="chip text-[10.5px]" title={tr ? s.tipTr : s.tipEn}><span className="chip-dot" style={{ background: s.color }} />{tr ? s.tr : s.en}</span></td>
                      <td>{codeCell}</td>
                      <td className="num !text-right">{sizeCell}</td>
                      <td className="num !text-right">{r.ours}</td>
                      <td className="num !text-right">{r.answer}</td>
                      {decidable && r.id && r.status !== 'match' && (
                        <td>
                          <div className="flex gap-1">
                            {(['ours', 'answer', 'custom'] as const).map(k => (
                              <button key={k} onClick={() => setChoice(r.id!, k, r)}
                                title={k === 'ours'
                                  ? (tr ? 'Bizim değer kalır' : 'Keep our value')
                                  : k === 'answer'
                                    ? (tr ? 'Excel\'deki değer yazılır' : 'Take the Excel value')
                                    : (tr ? 'Kendi değerini gir' : 'Enter your own value')}
                                className={`rounded border px-2 py-0.5 text-[10.5px] transition-colors ${c === k
                                  ? 'border-copper/70 bg-copper/15 text-copper-bright'
                                  : 'border-line text-muted hover:border-copper/40'}`}>
                                {k === 'ours' ? (tr ? 'Biz' : 'Ours') : k === 'answer' ? (tr ? 'Cevap' : 'Answer') : (tr ? 'Özel' : 'Custom')}
                              </button>
                            ))}
                          </div>
                        </td>
                      )}
                      {decidable && r.status === 'match' && <td className="text-muted">—</td>}
                    </tr>
                    {decidable && r.id && c === 'custom' && (
                      <tr>
                        <td colSpan={6} className="!py-2">
                          {/* .mtable input kuralı (width:100% + şeffaf kenarlık) utility'leri ezer →
                              editör alanları ! (important) ile stillenir + etiketli kompakt düzen */}
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pl-2 font-data text-[11px]">
                            <span className="font-semibold text-copper">{tr ? 'özel değer:' : 'custom value:'}</span>
                            <label className="flex items-center gap-1.5 text-muted">
                              {tr ? 'kod' : 'code'}
                              <input value={d.code} onChange={e => setCustoms(p => new Map(p).set(r.id!, { ...d, code: e.target.value }))}
                                className="!w-36 !rounded !border !border-line !bg-transparent !px-2 !py-1 text-ink outline-none focus:!border-copper/60" placeholder={tr ? 'kod' : 'code'} />
                            </label>
                            <label className="flex items-center gap-1.5 text-muted">
                              s1″
                              <input value={d.s1} onChange={e => setCustoms(p => new Map(p).set(r.id!, { ...d, s1: e.target.value }))}
                                className="!w-16 !rounded !border !border-line !bg-transparent !px-2 !py-1 !text-right text-ink outline-none focus:!border-copper/60" placeholder="—" inputMode="decimal" />
                            </label>
                            <label className="flex items-center gap-1.5 text-muted">
                              s2″
                              <input value={d.s2} onChange={e => setCustoms(p => new Map(p).set(r.id!, { ...d, s2: e.target.value }))}
                                className="!w-16 !rounded !border !border-line !bg-transparent !px-2 !py-1 !text-right text-ink outline-none focus:!border-copper/60" placeholder="0" inputMode="decimal" />
                            </label>
                            <label className="flex items-center gap-1.5 text-muted">
                              {tr ? 'miktar' : 'qty'}
                              <input value={d.qty} onChange={e => setCustoms(p => new Map(p).set(r.id!, { ...d, qty: e.target.value }))}
                                className="!w-24 !rounded !border !border-line !bg-transparent !px-2 !py-1 !text-right text-ink outline-none focus:!border-copper/60" placeholder="0" inputMode="decimal" />
                            </label>
                            <select value={d.unit} onChange={e => setCustoms(p => new Map(p).set(r.id!, { ...d, unit: e.target.value as 'M' | 'EA' }))}
                              className="!w-auto !rounded !border !border-line !bg-transparent !px-2 !py-1 text-ink outline-none">
                              <option value="M">M</option><option value="EA">EA</option>
                            </select>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {pool.length > 12 && (
              <button onClick={() => setShowAll(v => !v)} className="btn btn-ghost !text-[11px]">
                {showAll ? (tr ? 'daralt' : 'collapse') : `${pool.length - 12} ${tr ? 'satır daha göster' : 'more rows'}`}
              </button>
            )}
            {filter !== 'diffs' && problems.length > 0 && (
              <button onClick={() => setFilter('diffs')} className="btn btn-ghost !text-[11px]">
                ← {tr ? 'tüm farklara dön' : 'back to all differences'}
              </button>
            )}
            {pool.length === 0 && (
              <span className="font-data text-[10.5px] text-muted">
                {tr ? 'Bu durumda satır yok.' : 'No rows with this status.'}
              </span>
            )}
          </div>
        </div>
      )}

      {/* kalibre et ve öğren */}
      {decidable && (
        <div className="mt-4 border-t border-line pt-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] font-semibold uppercase tracking-wider text-copper">
              3 · {tr ? 'Kaydet ve öğret' : 'Save & teach'}
            </span>
            <span className="font-data text-[10.5px] text-muted">{tr ? 'öğrenilecek profil:' : 'learn into profile:'}</span>
            <input value={profileName} onChange={e => setProfileName(e.target.value)}
              className="panel w-56 px-3 py-2 text-[12.5px] outline-none focus:border-copper/60"
              placeholder={tr ? 'Profil adı' : 'Profile name'} />
            <button onClick={applyDecisions} disabled={busy || dirty} className="btn btn-primary"
              title={tr ? 'Kararlar uygulanınca karne tahmini bu yüzdeye çıkar' : 'Projected scorecard after your decisions are applied'}>
              {busy ? (tr ? 'Uygulanıyor…' : 'Applying…') : `◈ ${tr ? 'Kalibre et ve öğren' : 'Calibrate & learn'} → %${projected}`}
            </button>
            {changedCount > 0 && (
              <span className="font-data text-[10.5px] text-copper-bright">
                {changedCount} {tr ? 'satırda değişiklik seçtin' : 'rows will change'}
              </span>
            )}
            {targetProfile && (
              <span className="font-data text-[10.5px] text-muted">
                {tr ? 'profil' : 'profile'}: {targetProfile.name} v{targetProfile.version ?? 1}
              </span>
            )}
            {dirty && (
              <span className="font-data text-[10.5px] text-danger">
                {tr ? 'Kaydedilmemiş düzenlemen var — önce kaydet, sonra cevabı yeniden karşılaştır.' : 'You have unsaved edits — save first, then re-compare the answer.'}
              </span>
            )}
          </div>
          <p className="mt-1.5 font-data text-[10.5px] text-muted">
            {tr
              ? 'Kaydedince satırlar kararlarına göre güncellenir, profil bu kararlardan kural öğrenir ve bu müşterinin SONRAKİ dosyasına otomatik uygulanır. Rakamlar yalnız senin kararınla değişir.'
              : 'On save, rows update per your decisions, the profile learns rules from them, and they auto-apply to this client\'s NEXT file. Numbers change only by your decision.'}
          </p>
        </div>
      )}
      {!decidable && !applied && problems.length > 0 && (
        <p className="mt-2.5 font-data text-[10px] text-muted">
          {tr ? 'Bu karşılaştırma eski formatta — karar verebilmek için cevabı yeniden yükle.' : 'This comparison is in the old format — re-upload the answer to make decisions.'}
        </p>
      )}
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
