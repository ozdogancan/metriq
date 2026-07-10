'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { t, type Lang } from '@/lib/i18n';
import type { Calibration, MtoRow, Run, SteelRow } from '@/lib/types';

type Tab = 'rows' | 'steel' | 'info';

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

  async function save() {
    setSaving('saving');
    const res = await fetch(`/api/runs/${run.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rows }),
    });
    setSaving(res.ok ? 'saved' : 'idle');
    if (res.ok) setDirty(false);
  }

  async function saveCalibration() {
    const base = calibrations.find(c => c.id === run.calibrationId);
    const name = calName || `${run.projectName} kalibrasyonu`;
    // düzenlenen kod eşlemelerini öğren
    const renames: Record<string, string> = { ...(base?.rules.codeRenames ?? {}) };
    const res = await fetch('/api/calibrations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: base?.id, name,
        rules: base?.rules ?? undefined,
        learnedFrom: [...new Set([...(base?.learnedFrom ?? []), run.id])],
        ...(base ? {} : { rules: { ...defaultRulesFor(run), codeRenames: renames } }),
      }),
    });
    if (res.ok) { setCalName(''); alert(t(lang, 'calibration_saved')); }
  }

  const totals = run.totals;
  const num = (n: number, d = 1) => n.toLocaleString(lang === 'tr' ? 'tr-TR' : 'en-GB', { maximumFractionDigits: d });

  return (
    <div className="space-y-6">
      {/* başlık */}
      <div className="rise flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href="/" className="font-data text-[11px] text-muted hover:text-copper transition-colors">← METRIQ</Link>
          <h1 className="mt-1 text-[22px] font-bold tracking-tight">{run.projectName}</h1>
          <div className="mt-1 font-data text-[11px] text-muted">
            {run.fileName} · {(run.fileSize / 1e6).toFixed(1)} MB · {new Date(run.createdAt).toLocaleString(lang === 'tr' ? 'tr-TR' : 'en-GB')}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {dirty && <button onClick={save} className="btn btn-primary">{saving === 'saving' ? t(lang, 'saving') : t(lang, 'save')}</button>}
          {saving === 'saved' && <span className="chip"><span className="chip-dot bg-mint" />{t(lang, 'saved')}</span>}
          <a href={`/api/runs/${run.id}/excel`} className="btn btn-primary">⤓ {t(lang, 'download_excel')}</a>
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
              className="panel ml-auto px-3 py-2 text-[12px] outline-none">
              <option value="">{t(lang, 'all_lines')}</option>
              {lines.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder={t(lang, 'search')}
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
              </tr>
            </thead>
            <tbody className="font-data">
              {visible.map(r => (
                <tr key={r.id}>
                  <td className="text-muted">{r.line}</td>
                  <td><input value={r.code} onChange={e => edit(r.id, { code: e.target.value })} /></td>
                  <td className="text-muted"><input value={r.sub} onChange={e => edit(r.id, { sub: e.target.value })} /></td>
                  <td className="num !text-right w-20"><input className="!text-right" value={r.s1 ?? ''} onChange={e => edit(r.id, { s1: e.target.value === '' ? null : Number(e.target.value) })} /></td>
                  <td className="num !text-right w-20"><input className="!text-right" value={r.s2 || ''} onChange={e => edit(r.id, { s2: Number(e.target.value) || 0 })} /></td>
                  <td className="num !text-right w-24"><input className="!text-right" value={r.qty} onChange={e => edit(r.id, { qty: Number(e.target.value) || 0 })} /></td>
                  <td className="text-muted">{r.unit}</td>
                  <td className="text-muted text-[11px]">{r.remark}{r.edited && <span className="ml-2 text-copper">●</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <AiInsight lang={lang} runId={run.id} />

      {/* kalibrasyon kaydet */}
      <div className="rise rise-4 flex flex-wrap items-center gap-3 border-t border-line pt-5">
        <input value={calName} onChange={e => setCalName(e.target.value)}
          placeholder={`${t(lang, 'calibration')} — ${t(lang, 'name').toLowerCase()}`}
          className="panel w-64 px-3.5 py-2.5 text-[13px] outline-none focus:border-copper/50" />
        <button onClick={saveCalibration} className="btn">◈ {t(lang, 'save_calibration')}</button>
        <span className="font-data text-[11px] text-muted">
          {lang === 'tr' ? 'Düzenlemeler + kurallar profil olarak saklanır; sonraki metrajlara uygulanır.' : 'Edits + rules are stored as a profile; applied to future takeoffs.'}
        </span>
      </div>
    </div>
  );
}

function AiInsight({ lang, runId }: { lang: Lang; runId: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'hidden'>('idle');
  const [text, setText] = useState('');
  if (state === 'hidden') return null;
  async function gen() {
    setState('loading');
    const res = await fetch(`/api/runs/${runId}/insight`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lang }),
    });
    if (res.status === 404) { setState('hidden'); return; }
    const data = await res.json();
    if (res.ok) { setText(data.text); setState('done'); } else setState('idle');
  }
  return (
    <div className="rise panel panel-corners px-5 py-4">
      <div className="flex items-center justify-between">
        <div className="text-[12px] font-semibold uppercase tracking-wider text-steel">✦ {t(lang, 'ai_insight')}</div>
        {state !== 'done' && (
          <button onClick={gen} disabled={state === 'loading'} className="btn btn-ghost !text-[12px]">
            {state === 'loading' ? t(lang, 'ai_generating') : '→'}
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
            <td className="num !text-right">{r.lengthMm.toLocaleString()}</td>
            <td className="num !text-right">{r.count}</td>
            <td className="num !text-right">{((r.lengthMm * r.count) / 1000).toFixed(2)}</td>
            <td className="num !text-right">{r.totalKg.toFixed(1)}</td>
          </tr>
        ))}
        <tr className="font-bold">
          <td>TOPLAM</td><td /><td className="num !text-right">{totN}</td>
          <td className="num !text-right text-mint">{totM.toFixed(2)}</td>
          <td className="num !text-right text-mint">{totKg.toFixed(1)}</td>
        </tr>
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
