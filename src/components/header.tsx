'use client';
import Link from 'next/link';
import Image from 'next/image';
import { useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { t, type Lang } from '@/lib/i18n';
import { NotificationsBell } from '@/components/notifications-bell';

function persistUiCookie(name: 'lang' | 'theme', value: string) {
  document.cookie = `${name}=${value};path=/;max-age=31536000;samesite=strict`;
}

export function Header({ lang, theme: initialTheme }: { lang: Lang; theme: 'dark' | 'light' }) {
  const router = useRouter();
  const pathname = usePathname();
  const [theme, setTheme] = useState(initialTheme);

  function setLang(l: Lang) {
    persistUiCookie('lang', l);
    router.refresh();
  }
  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    persistUiCookie('theme', next);
    document.documentElement.dataset.theme = next;
  }
  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  }

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-3 py-3 sm:px-5">
        {/* mobilde yalnız logo — metin sm ve üstünde görünür (yatay taşma olmasın) */}
        <Link href="/" className="group flex items-center gap-2 sm:gap-3">
          <Image src="/logo.png" alt="Metriq" width={34} height={34} priority
            className="shrink-0 rounded-[9px] border border-line" />
          <div className="hidden sm:block">
            <div className="text-[17px] font-bold tracking-tight leading-none">
              metri<span className="text-copper">q</span>
            </div>
            <div className="text-[10px] text-muted font-data tracking-wider mt-0.5">{t(lang, 'tagline')}</div>
          </div>
        </Link>
        <nav className="flex items-center gap-0.5 sm:gap-1.5">
          <Link href="/" className={`btn btn-ghost whitespace-nowrap !px-2 !text-[12px] sm:!px-4 sm:!text-[13px] ${pathname === '/' ? '!text-ink !border-line' : ''}`}>
            {lang === 'tr' ? 'Panel' : 'Dashboard'}
          </Link>
          <Link href="/calibrations" className={`btn btn-ghost whitespace-nowrap !px-2 !text-[12px] sm:!px-4 sm:!text-[13px] ${pathname.startsWith('/calibrations') ? '!text-ink !border-line' : ''}`}>
            {t(lang, 'calibrations')}
          </Link>
          {/* bildirimler */}
          <NotificationsBell lang={lang} />
          {/* tema */}
          <button onClick={toggleTheme}
            title={theme === 'dark' ? t(lang, 'theme_light') : t(lang, 'theme_dark')}
            className="btn btn-ghost !px-2 sm:!px-2.5"
            aria-label={theme === 'dark' ? t(lang, 'theme_light') : t(lang, 'theme_dark')}>
            {theme === 'dark' ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="4.5" />
                <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
              </svg>
            )}
          </button>
          {/* dil */}
          <div className="flex overflow-hidden rounded-lg border border-line font-data text-[11px]">
            {(['tr', 'en'] as Lang[]).map(l => (
              <button key={l} onClick={() => setLang(l)}
                className={`px-2 py-1.5 uppercase tracking-wide transition-colors sm:px-2.5 ${lang === l ? 'bg-copper/20 text-copper-bright' : 'text-muted hover:text-ink'}`}>
                {l}
              </button>
            ))}
          </div>
          {/* çıkış */}
          <button onClick={logout} title={lang === 'tr' ? 'Çıkış' : 'Sign out'}
            className="btn btn-ghost !px-2 sm:!px-2.5" aria-label={lang === 'tr' ? 'Çıkış' : 'Sign out'}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <path d="M16 17l5-5-5-5M21 12H9" />
            </svg>
          </button>
        </nav>
      </div>
    </header>
  );
}
