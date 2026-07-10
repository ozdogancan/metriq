'use client';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Lang } from '@/lib/i18n';

export function LoginForm({ lang }: { lang: Lang }) {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(false);
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }).catch(() => null);
    if (res?.ok) {
      const next = params.get('next');
      router.replace(next && next.startsWith('/') ? next : '/');
      router.refresh();
    } else {
      setErr(true); setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="mb-1.5 block text-[11px] font-data uppercase tracking-wider text-muted">
          {lang === 'tr' ? 'E-posta' : 'Email'}
        </label>
        <input type="email" required autoFocus value={email} onChange={e => setEmail(e.target.value)}
          autoComplete="username"
          className="w-full rounded-lg border border-line bg-panel2 px-3.5 py-2.5 text-[14px] outline-none transition-colors focus:border-copper/60" />
      </div>
      <div>
        <label className="mb-1.5 block text-[11px] font-data uppercase tracking-wider text-muted">
          {lang === 'tr' ? 'Şifre' : 'Password'}
        </label>
        <input type="password" required value={password} onChange={e => setPassword(e.target.value)}
          autoComplete="current-password"
          className="w-full rounded-lg border border-line bg-panel2 px-3.5 py-2.5 text-[14px] outline-none transition-colors focus:border-copper/60" />
      </div>
      {err && (
        <div className="rounded-lg border border-danger/40 bg-danger/10 px-3.5 py-2.5 text-[12.5px] text-danger">
          {lang === 'tr' ? 'E-posta veya şifre hatalı.' : 'Invalid email or password.'}
        </div>
      )}
      <button type="submit" disabled={busy}
        className="w-full rounded-lg bg-copper px-4 py-2.5 text-[14px] font-semibold text-[#0b0e13] transition-all hover:bg-copper-bright disabled:opacity-60">
        {busy ? (lang === 'tr' ? 'Giriş yapılıyor…' : 'Signing in…') : (lang === 'tr' ? 'Giriş yap' : 'Sign in')}
      </button>
    </form>
  );
}
