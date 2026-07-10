'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { t, type Lang, type TKey } from '@/lib/i18n';
import type { VocabProfileId } from '@/lib/types';

interface CalOpt { id: string; name: string; vocab: VocabProfileId }

// HTTP durum kodunu taşıyan hata — catch'te kullanıcı-dostu mesaja çevrilir
class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

// Ham/teknik hataları kullanıcı-dostu i18n anahtarına eşle
function errorKey(e: unknown): TKey {
  if (e instanceof HttpError) return e.status === 413 ? 'err_file_too_large' : 'err_server';
  if (e instanceof TypeError) return 'err_network'; // fetch ağ hatası
  return 'err_server';
}

export function UploadZone({ lang, calibrations }: { lang: Lang; calibrations: CalOpt[] }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [projectName, setProjectName] = useState('');
  const [vocab, setVocab] = useState<VocabProfileId>('steel-plant');
  const [calId, setCalId] = useState('');

  async function handleFile(file: File) {
    if (!file.name.toLowerCase().endsWith('.nwd')) {
      setError(t(lang, 'err_only_nwd'));
      return;
    }
    setBusy(true); setError('');
    try {
      const meta = {
        projectName: projectName || file.name.replace(/\.nwd$/i, ''),
        vocab, calibrationId: calId || null, fileName: file.name,
      };
      let res: Response;
      if (file.size > 4_000_000) {
        // büyük dosya: imzalı URL ile depoya, sonra referansla işle
        const s = await fetch('/api/upload-url', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fileName: file.name }),
        });
        if (!s.ok) throw new HttpError(s.status, 'upload-url failed');
        const su = await s.json();
        if (su.mode === 'supabase') {
          const up = await fetch(su.uploadUrl, {
            method: 'PUT',
            headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${su.token}`, 'x-upsert': 'true' },
            body: file,
          });
          if (!up.ok) throw new HttpError(up.status, 'storage upload failed');
          res = await fetch('/api/runs', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...meta, storagePath: su.path, runId: su.runId, fileSize: file.size }),
          });
        } else {
          // yerel mod: doğrudan multipart (limit yok)
          res = await postMultipart(file, meta);
        }
      } else {
        res = await postMultipart(file, meta);
      }
      if (!res.ok) throw new HttpError(res.status, 'parse failed');
      const out = await res.json();
      router.push(`/runs/${out.id}`);
      router.refresh();
    } catch (e) {
      setError(t(lang, errorKey(e)));
      setBusy(false);
    }
  }

  async function postMultipart(file: File, meta: Record<string, unknown>) {
    const fd = new FormData();
    fd.set('file', file);
    fd.set('meta', JSON.stringify(meta));
    return fetch('/api/runs', { method: 'POST', body: fd });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <input
          value={projectName}
          onChange={e => setProjectName(e.target.value)}
          placeholder={t(lang, 'project_name')}
          className="panel px-3.5 py-2.5 text-[13px] outline-none focus:border-copper/60 placeholder:text-muted/60"
        />
        <select value={vocab} onChange={e => setVocab(e.target.value as VocabProfileId)}
          className="panel px-3.5 py-2.5 text-[13px] outline-none focus:border-copper/60">
          <option value="steel-plant">{t(lang, 'vocab_steel')}</option>
          <option value="hygienic">{t(lang, 'vocab_hygienic')}</option>
        </select>
        <select value={calId} onChange={e => setCalId(e.target.value)}
          className="panel px-3.5 py-2.5 text-[13px] outline-none focus:border-copper/60">
          <option value="">{t(lang, 'calibration_none')}</option>
          {calibrations.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      <div
        className={`dropzone panel-corners relative flex min-h-[190px] cursor-pointer flex-col items-center justify-center gap-3 p-8 ${drag ? 'drag' : ''}`}
        onClick={() => !busy && fileRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => {
          e.preventDefault(); setDrag(false);
          const f = e.dataTransfer.files[0];
          if (f && !busy) handleFile(f);
        }}
      >
        {busy ? (
          <>
            <div className="flex items-center gap-2 font-data text-[13px] text-copper-bright">
              <span className="chip-dot pulse bg-copper-bright" />
              {t(lang, 'upload_processing')}
            </div>
            <div className="font-data text-[11px] text-muted">zlib → components → MTO</div>
          </>
        ) : (
          <>
            <svg width="44" height="44" viewBox="0 0 44 44" className="opacity-80">
              <rect x="4" y="10" width="36" height="26" rx="4" fill="none" stroke="var(--color-copper)" strokeWidth="1.3" strokeDasharray="4 3" />
              <path d="M22 28 V16 M22 16 l-5 5 M22 16 l5 5" stroke="var(--color-copper-bright)" strokeWidth="1.8" strokeLinecap="round" fill="none" />
            </svg>
            <div className="text-[14px] font-semibold">{t(lang, 'upload_hint')}</div>
            <div className="font-data text-[11px] tracking-wider text-muted">.NWD · NAVISWORKS / PLANT 3D</div>
            <button className="btn btn-primary mt-1" onClick={e => { e.stopPropagation(); fileRef.current?.click(); }}>
              {t(lang, 'upload_button')}
            </button>
          </>
        )}
        <input ref={fileRef} type="file" accept=".nwd" hidden
          onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }} />
      </div>
      {error && <div className="panel border-danger/40 px-4 py-3 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
