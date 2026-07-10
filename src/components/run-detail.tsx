'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { t, type Lang } from '@/lib/i18n';
import type { Calibration, MtoRow, Run, SteelRow } from '@/lib/types';

type Tab = 'rows' | 'steel' | 'info';

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
    try {
      const rules = { ...(base?.rules ?? defaultRulesFor(run)), codeRenames: renames };
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
      toast.success(
        (tr ? 'Kalibrasyon kaydedildi' : 'Calibration saved') +
        (learned > 0 ? (tr ? ` · ${learned} kod eşlemesi öğrenildi` : ` · learned ${learned} code mapping(s)`) : '')
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
          <button onClick={downloadExcel} disabled={saving === 'saving'} className="btn btn-primary">
            ⤓ {t(lang, 'download_excel')}{dirty ? ' *' : ''}
          </button>
        </div>
      </div>

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

      {/* tablo */}
      <div className="panel panel-corners rise rise-4 overflow-auto" style={{ maxHeight: '58vh' }}>
        {tab === 'steel' ? <SteelTable lang={lang} steel={steel} /> : (
          <table className="mtable">
            <thead>
              <tr>
                <th>{t(lang, 'col_line')}</th><th>{t(lang, 'col_code')}</th><th>{t(lang, 'col_sub')}</th>
                <th className="!text-right">{t(lang, 'col_size1')}</th><th className="!text-right">{t(lang, 'col_size2')}</th>
                <th className="!text-right">{t(lang, 'col_qty')}</th><th>{t(lang, 'col_unit')}</th><th>{t(lang, 'col_remark')}</th>
                <th className="w-8" aria-label={tr ? 'satır işlemleri' : 'row actions'} />
              </tr>
            </thead>
            <tbody className="font-data">
              {visible.map(r => (
                <tr key={r.id}>
                  <td className="text-muted w-20">
                    <input value={r.line} aria-label={`${t(lang, 'col_line')} ${r.code}`}
                      onChange={e => edit(r.id, { line: e.target.value })} />
                  </td>
                  <td><input value={r.code} aria-label={`${t(lang, 'col_code')} ${r.line}`}
                    onChange={e => edit(r.id, { code: e.target.value })} /></td>
                  <td className="text-muted"><input value={r.sub} aria-label={t(lang, 'col_sub')}
                    onChange={e => edit(r.id, { sub: e.target.value })} /></td>
                  <td className="num !text-right w-20">
                    <NumCell value={r.s1} nullable label={`${t(lang, 'col_size1')} ${r.code}`}
                      onCommit={v => edit(r.id, { s1: v })} />
                  </td>
                  <td className="num !text-right w-20">
                    <NumCell value={r.s2 || null} nullable label={`${t(lang, 'col_size2')} ${r.code}`}
                      onCommit={v => edit(r.id, { s2: v ?? 0 })} />
                  </td>
                  <td className="num !text-right w-24">
                    <NumCell value={r.qty} label={`${t(lang, 'col_qty')} ${r.code}`}
                      onCommit={v => edit(r.id, { qty: v ?? 0 })} />
                  </td>
                  <td className="text-muted w-16">
                    <select value={r.unit} aria-label={t(lang, 'col_unit')}
                      onChange={e => edit(r.id, { unit: e.target.value as MtoRow['unit'] })}
                      className="bg-transparent outline-none">
                      <option value="M">M</option><option value="EA">EA</option>
                    </select>
                  </td>
                  <td className="text-muted text-[11px]">{r.remark}{r.edited && <span className="ml-2 text-copper">●</span>}</td>
                  <td className="w-8 text-center">
                    <button onClick={() => removeRow(r.id)} aria-label={tr ? `satırı sil: ${r.code}` : `delete row: ${r.code}`}
                      className="text-muted transition-colors hover:text-danger" title={tr ? 'Satırı sil' : 'Delete row'}>×</button>
                  </td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-8 text-center text-[12.5px] text-muted">
                    {q || lineFilter
                      ? (tr ? 'Filtreye uyan satır yok.' : 'No rows match the filter.')
                      : (tr ? 'Bu sekmede satır yok.' : 'No rows in this tab.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

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
