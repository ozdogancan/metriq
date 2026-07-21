'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { t, type Lang, type TKey } from '@/lib/i18n';
import { isAllowedNwdSize } from '@/lib/upload-policy';
import type { Calibration } from '@/lib/types';

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

export function UploadZone({ lang, calibrations }: { lang: Lang; calibrations: Calibration[] }) {
  const router = useRouter();
  const tr = lang === 'tr';
  const fileRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [projectName, setProjectName] = useState('');
  const [calibrationId, setCalibrationId] = useState('');
  // büyük dosyada "donmuş" hissini bitiren gerçek yükleme yüzdesi (XHR progress)
  const [progress, setProgress] = useState<number | null>(null);

  // fetch upload-progress vermez — imzalı PUT'u XHR ile yapıp yüzdeyi akıt
  function putWithProgress(url: string, file: File, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      xhr.setRequestHeader('authorization', `Bearer ${token}`);
      xhr.setRequestHeader('x-upsert', 'true');
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new HttpError(xhr.status, 'storage upload failed'));
      xhr.onerror = () => reject(new TypeError('network'));
      xhr.send(file);
    });
  }

  async function handleFile(file: File) {
    if (!file.name.toLowerCase().endsWith('.nwd')) {
      setError(t(lang, 'err_only_nwd'));
      return;
    }
    if (!isAllowedNwdSize(file.size)) {
      setError(t(lang, 'err_file_too_large'));
      return;
    }
    setBusy(true); setError('');
    try {
      const meta = {
        projectName: projectName || file.name.replace(/\.nwd$/i, ''),
        vocab: 'auto', calibrationId: calibrationId || null, fileName: file.name,
      };
      let res: Response;
      if (file.size > 4_000_000) {
        // büyük dosya: imzalı URL ile depoya, sonra referansla işle
        const s = await fetch('/api/upload-url', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fileName: file.name, fileSize: file.size }),
        });
        if (!s.ok) throw new HttpError(s.status, 'upload-url failed');
        const su = await s.json();
        if (su.mode === 'supabase') {
          setProgress(0);
          await putWithProgress(su.uploadUrl, file, su.token);
          setProgress(100);
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
      setProgress(null);
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
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label htmlFor="uz-name" className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-muted">
            {tr ? 'Proje adı' : 'Project name'}
            <span className="ml-1.5 font-normal normal-case tracking-normal opacity-70">
              {tr ? '(opsiyonel)' : '(optional)'}
            </span>
          </label>
          <input
            id="uz-name"
            value={projectName}
            onChange={e => setProjectName(e.target.value)}
            placeholder={tr ? 'ör. Şantiye A — Buhar Hattı' : 'e.g. Site A — Steam Line'}
            className="panel w-full px-3.5 py-2.5 text-[13px] outline-none focus:border-copper/60 placeholder:text-muted/60"
          />
        </div>
        <div>
          <label htmlFor="uz-profile" className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-muted">
            {tr ? 'Müşteri profili' : 'Client profile'}
            <span className="ml-1.5 font-normal normal-case tracking-normal opacity-70">
              {tr ? '(isteğe bağlı)' : '(optional)'}
            </span>
          </label>
          <select id="uz-profile" value={calibrationId} onChange={e => setCalibrationId(e.target.value)}
            className="panel w-full px-3.5 py-2.5 text-[13px] outline-none focus:border-copper/60">
            <option value="">{tr ? 'Otomatik algıla — önerilen' : 'Auto-detect — recommended'}</option>
            {calibrations.map(cal => (
              <option key={cal.id} value={cal.id}>
                {cal.name} · v{cal.version ?? 1} · {cal.learnedFrom.length} {tr ? 'model' : 'model(s)'}
              </option>
            ))}
          </select>
          <p className="mt-1 font-data text-[10px] text-muted">
            {calibrationId
              ? (tr ? 'Bu dosyada seçtiğin müşterinin onaylı kuralları kullanılır.' : 'Approved rules for the selected client are used for this file.')
              : (tr ? 'Model ailesi algılanır; yalnız güvenli ve uygun profil otomatik seçilir.' : 'The model family is detected; only a safe matching profile is selected automatically.')}
          </p>
        </div>
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
              {progress !== null && progress < 100
                ? (tr ? `Yükleniyor… %${progress}` : `Uploading… ${progress}%`)
                : t(lang, 'upload_processing')}
            </div>
            {/* büyük dosyada gerçek ilerleme çubuğu — "donmuş" hissi biter */}
            {progress !== null && progress < 100 ? (
              <div className="h-1.5 w-64 overflow-hidden rounded border border-line">
                <div className="h-full bg-[var(--color-copper)] transition-[width] duration-200"
                  style={{ width: `${progress}%` }} />
              </div>
            ) : (
              <div className="font-data text-[11px] text-muted">zlib → components → MTO</div>
            )}
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
