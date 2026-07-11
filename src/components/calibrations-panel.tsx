'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { t, type Lang, type TKey } from '@/lib/i18n';
import type { Calibration, CalibrationRules } from '@/lib/types';

export function CalibrationsPanel({ lang, initial }: { lang: Lang; initial: Calibration[] }) {
  const router = useRouter();
  const [cals, setCals] = useState(initial);
  const [openId, setOpenId] = useState<string | null>(initial[0]?.id ?? null);
  const tr = lang === 'tr';

  // Sessiz başarısızlık YASAK: kullanıcı kuralı kaydetti sanıp yanlış kurallarla
  // sonraki metraja girmemeli — hata her zaman görünür.
  async function persist(cal: Calibration) {
    try {
      const res = await fetch('/api/calibrations', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...cal, expectedVersion: cal.version ?? 0 }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast.error((tr ? 'Kalibrasyon kaydedilemedi: ' : 'Calibration save failed: ') + (d.error || `HTTP ${res.status}`));
        return;
      }
      const saved = await res.json();
      setCals(prev => prev.some(c => c.id === saved.id) ? prev.map(c => c.id === saved.id ? saved : c) : [saved, ...prev]);
      toast.success(tr ? 'Kalibrasyon kaydedildi' : 'Calibration saved');
      router.refresh();
    } catch {
      toast.error(tr ? 'Ağ hatası — kalibrasyon kaydedilemedi.' : 'Network error — calibration not saved.');
    }
  }

  async function remove(cal: Calibration) {
    if (!confirm(t(lang, 'confirm_delete'))) return;
    try {
      const res = await fetch(`/api/calibrations?id=${cal.id}&version=${cal.version ?? 1}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error(tr ? 'Silinemedi — profil duruyor.' : 'Delete failed — profile kept.');
        return;
      }
      setCals(prev => prev.filter(c => c.id !== cal.id));
      toast.success(tr ? 'Profil silindi' : 'Profile deleted');
      router.refresh();
    } catch {
      toast.error(tr ? 'Ağ hatası — silinemedi.' : 'Network error — not deleted.');
    }
  }

  return (
    <div className="space-y-4">
      {/* Kalibrasyon = müşteri hafızası; profiller jargondan değil gerçek metrajlardan doğar */}
      <div className="rise panel panel-corners px-5 py-4">
        <div className="text-[12px] font-semibold uppercase tracking-wider text-copper">
          {tr ? '◈ Kalibrasyon = müşteri hafızası' : '◈ Calibration = client memory'}
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          {tr
            ? 'Her müşteri metrajı biraz farklı sayar (kimi vanayı listeye almaz, kimi bazı hatları kapsam dışı tutar). Buradaki profiller o alışkanlıkların hafızasıdır — elle oluşturulmaz, gerçek metrajlardan doğar:'
            : 'Every client counts slightly differently (some skip valves, some keep certain lines out of scope). Profiles here are the memory of those habits — they aren\'t created by hand, they are born from real take-offs:'}
        </p>
        <ol className="mt-2.5 space-y-1 text-[12.5px] leading-relaxed text-muted">
          <li><span className="font-data text-copper-bright">1.</span> {tr ? 'Dosyayı yükle — tesisat tipi otomatik algılanır, sonuç saniyeler içinde gelir.' : 'Upload the file — system type is auto-detected, results arrive in seconds.'}</li>
          <li><span className="font-data text-copper-bright">2.</span> {tr ? 'Doğrula — istersen müşterinin cevap Excel\'ini "⇪ Cevapla karşılaştır" ile yükle, farkları gör; gerekirse satırları ekranda düzelt.' : 'Verify — optionally upload the client\'s answer Excel via "⇪ Compare with answer" to see differences; fix rows on screen if needed.'}</li>
          <li><span className="font-data text-copper-bright">3.</span> {tr ? '"Kalibrasyon olarak kaydet" — düzeltmelerin (kod adları + kapsam-dışı hatlar) bu sayfadaki profile işlenir ve o müşterinin sonraki dosyasında otomatik uygulanır.' : '"Save as calibration" — your corrections (code names + excluded lines) are folded into a profile here and applied automatically to that client\'s next file.'}</li>
        </ol>
      </div>
      {cals.length === 0 && (
        <div className="panel panel-corners rise px-6 py-10 text-center text-[13px] text-muted">
          {lang === 'tr'
            ? 'Henüz öğrenilmiş profil yok. İlk metrajını yükle, gerekirse düzelt ve "Kalibrasyon olarak kaydet" de — profil burada belirecek.'
            : 'No learned profiles yet. Upload your first take-off, correct if needed, and "Save as calibration" — the profile will appear here.'}
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
                {` · v${cal.version ?? 1}`}
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
                <button className="btn btn-ghost hover:!text-danger" onClick={() => remove(cal)}>{t(lang, 'delete_run')}</button>
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
              className="h-4 w-4 accent-[var(--color-copper)]" />
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
      {(r.excludeLines?.length ?? 0) > 0 && (
        <div className="space-y-1.5">
          <div className="font-data text-[11px] text-muted">
            {lang === 'tr' ? 'Öğrenilen kapsam-dışı hatlar (satırları bilgi sekmesine iner):' : 'Learned excluded lines (rows demoted to info tab):'}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {r.excludeLines!.map(l => (
              <span key={l} className="chip font-data text-[11px]">
                {l}
                <button
                  onClick={() => set('excludeLines', r.excludeLines!.filter(x => x !== l))}
                  aria-label={lang === 'tr' ? `hattı kapsama geri al: ${l}` : `re-include line: ${l}`}
                  className="ml-1.5 text-muted transition-colors hover:text-danger">×</button>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
