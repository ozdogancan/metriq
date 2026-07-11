import { Suspense } from 'react';
import { cookies } from 'next/headers';
import Image from 'next/image';
import { langFromCookie } from '@/lib/i18n';
import { LoginForm } from './login-form';

export const metadata = { title: 'Giriş — Metriq' };

export default async function LoginPage() {
  const store = await cookies();
  const lang = langFromCookie(store.get('lang')?.value);
  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_minmax(420px,44%)]">
      {/* sol: hero görsel (mobilde gizli) */}
      <div className="relative hidden overflow-hidden lg:block">
        <Image src="/login-hero.jpg" alt="" fill priority sizes="60vw"
          className="object-cover object-center" />
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-transparent to-bg" />
        <div className="absolute bottom-8 left-8 right-16">
          <div className="text-[11px] font-data tracking-[0.2em] text-copper-bright/90 uppercase">
            {lang === 'tr' ? 'Modelden metraja, saniyeler içinde' : 'From model to take-off, in seconds'}
          </div>
        </div>
      </div>
      {/* sağ: form paneli */}
      <div className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-9 flex items-center gap-4">
            <Image src="/logo.png" alt="Metriq" width={54} height={54} priority
              className="rounded-2xl border border-line shadow-lg shadow-black/20" />
            <div>
              <div className="text-2xl font-bold tracking-tight leading-none">
                metri<span className="text-copper">q</span>
              </div>
              <div className="mt-1 text-[11px] font-data tracking-wider text-muted uppercase">
                MTO ENGINE
              </div>
            </div>
          </div>
          <h1 className="dimline mb-2 text-lg font-semibold">
            {lang === 'tr' ? 'Oturum aç' : 'Sign in'}
          </h1>
          <p className="mb-7 mt-3 text-[13px] leading-relaxed text-muted">
            {lang === 'tr'
              ? 'Model yükle, doğrulanmış metrajını indir. Hesabınla devam et.'
              : 'Upload a model, download a verified take-off. Continue with your account.'}
          </p>
          <Suspense fallback={null}>
            <LoginForm lang={lang} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
