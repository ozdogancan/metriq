'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { t, type Lang, type TKey } from '@/lib/i18n';
import { DEFAULT_RULES, type Calibration, type CalibrationRules, type VocabProfileId } from '@/lib/types';

export function CalibrationsPanel({ lang, initial }: { lang: Lang; initial: Calibration[] }) {
  const router = useRouter();
  const [cals, setCals] = useState(initial);
  const [openId, setOpenId] = useState<string | null>(initial[0]?.id ?? null);

  async function persist(cal: Calibration) {
    const res = await fetch('/api/calibrations', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cal),
    });
    if (res.ok) {
      const saved = await res.json();
      setCals(prev => prev.some(c => c.id === saved.id) ? prev.map(c => c.id === saved.id ? saved : c) : [saved, ...prev]);
      router.refresh();
    }
  }

  async function remove(id: string) {
    if (!confirm(t(lang, 'confirm_delete'))) return;
    await fetch(`/api/calibrations?id=${id}`, { method: 'DELETE' });
    setCals(prev => prev.filter(c => c.id !== id));
    router.refresh();
  }

  function addNew(vocab: VocabProfileId) {
    const now = new Date().toISOString();
    const cal: Calibration = {
      id: crypto.randomUUID(),
      name: vocab === 'hygienic' ? 'Hijyenik profil' : 'Çelik tesisat profili',
      rules: { ...DEFAULT_RULES[vocab], codeRenames: {} },
      learnedFrom: [], createdAt: now, updatedAt: now,
    };
    setCals(prev => [cal, ...prev]);
    setOpenId(cal.id);
  }

  return (
    <div className="space-y-4">
      <div className="rise flex gap-2">
        <button className="btn btn-primary" onClick={() => addNew('steel-plant')}>+ {t(lang, 'vocab_steel')}</button>
        <button className="btn" onClick={() => addNew('hygienic')}>+ {t(lang, 'vocab_hygienic')}</button>
      </div>
      {cals.length === 0 && (
        <div className="panel panel-corners rise px-6 py-10 text-center text-[13px] text-muted">
          {lang === 'tr' ? 'Henüz kalibrasyon yok. Bir metrajı düzenleyip "Kalibrasyon olarak kaydet" de diyebilirsin.' : 'No calibrations yet. You can also edit a takeoff and "Save as calibration".'}
        </div>
      )}
      {cals.map((cal, i) => (
        <div key={cal.id} className={`panel rise`} style={{ animationDelay: `${i * 60}ms` }}>
          <button className="flex w-full items-center justify-between px-5 py-4 text-left"
            onClick={() => setOpenId(openId === cal.id ? null : cal.id)}>
            <div>
              <div className="text-[14px] font-semibold">{cal.name}</div>
              <div className="mt-0.5 font-data text-[11px] text-muted">
                {cal.rules.vocab === 'hygienic' ? t(lang, 'vocab_hygienic') : t(lang, 'vocab_steel')}
                {cal.learnedFrom.length > 0 && ` · ${cal.learnedFrom.length} ${t(lang, 'learned_from')}`}
                {' · '}{new Date(cal.updatedAt).toLocaleDateString(lang === 'tr' ? 'tr-TR' : 'en-GB')} {t(lang, 'updated')}
              </div>
            </div>
            <span className="font-data text-muted">{openId === cal.id ? '▴' : '▾'}</span>
          </button>
          {openId === cal.id && (
            <div className="border-t border-line px-5 py-4">
              <RulesEditor lang={lang} cal={cal}
                onChange={next => setCals(prev => prev.map(c => c.id === cal.id ? next : c))} />
              <div className="mt-4 flex gap-2">
                <button className="btn btn-primary" onClick={() => persist(cals.find(c => c.id === cal.id)!)}>{t(lang, 'save')}</button>
                <button className="btn btn-ghost hover:!text-danger" onClick={() => remove(cal.id)}>{t(lang, 'delete_run')}</button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function RulesEditor({ lang, cal, onChange }: { lang: Lang; cal: Calibration; onChange: (c: Calibration) => void }) {
  const r = cal.rules;
  function set<K extends keyof CalibrationRules>(k: K, v: CalibrationRules[K]) {
    onChange({ ...cal, rules: { ...r, [k]: v }, updatedAt: new Date().toISOString() });
  }
  const toggles: [keyof CalibrationRules, TKey][] = [
    ['merge45Into90', 'rules_merge45'],
    ['collarOneToOne', 'rules_collar'],
    ['excludeCompanionFlanges', 'rules_companion'],
    ['includeValvesInMain', 'rules_valves_main'],
    ['includeFasteners', 'rules_fasteners'],
  ];
  return (
    <div className="space-y-3">
      <input value={cal.name} onChange={e => onChange({ ...cal, name: e.target.value })}
        className="panel w-full max-w-sm px-3 py-2 text-[13px] outline-none focus:border-copper/50" />
      <div className="grid gap-2 sm:grid-cols-2">
        {toggles.map(([k, label]) => (
          <label key={k} className="flex cursor-pointer items-center gap-3 rounded-lg border border-line px-3.5 py-2.5 text-[12.5px] hover:border-copper/35 transition-colors">
            <input type="checkbox" checked={Boolean(r[k])} onChange={e => set(k, e.target.checked as never)}
              className="h-4 w-4 accent-[#d08a45]" />
            {t(lang, label)}
          </label>
        ))}
        <label className="flex items-center gap-3 rounded-lg border border-line px-3.5 py-2.5 text-[12.5px]">
          {t(lang, 'rules_gross')}
          <input type="number" step="0.01" min="0.8" max="1.6" value={r.grossPipeFactor}
            onChange={e => set('grossPipeFactor', Number(e.target.value) || 1)}
            className="num ml-auto w-20 rounded border border-line bg-transparent px-2 py-1 text-right outline-none focus:border-copper/60" />
        </label>
      </div>
      {Object.keys(r.codeRenames).length > 0 && (
        <div className="font-data text-[11px] text-muted">
          {lang === 'tr' ? 'Öğrenilen kod eşlemeleri: ' : 'Learned code mappings: '}
          {Object.entries(r.codeRenames).map(([a, b]) => `${a}→${b}`).join(' · ')}
        </div>
      )}
    </div>
  );
}
