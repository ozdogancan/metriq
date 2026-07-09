'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { t, type Lang } from '@/lib/i18n';

export function Header({ lang }: { lang: Lang }) {
  const router = useRouter();
  const pathname = usePathname();

  function setLang(l: Lang) {
    document.cookie = `lang=${l};path=/;max-age=31536000`;
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3.5">
        <Link href="/" className="group flex items-center gap-3">
          {/* logo: ölçü oku + Q */}
          <svg width="30" height="30" viewBox="0 0 30 30" className="shrink-0">
            <rect x="1" y="1" width="28" height="28" rx="7" fill="none" stroke="#d08a45" strokeWidth="1.4" />
            <path d="M7 21 L21 7" stroke="#eaa45c" strokeWidth="1.6" strokeLinecap="round" />
            <path d="M7 21 l4.4 -1.2 M7 21 l1.2 -4.4" stroke="#eaa45c" strokeWidth="1.6" strokeLinecap="round" />
            <path d="M21 7 l-4.4 1.2 M21 7 l-1.2 4.4" stroke="#eaa45c" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <div>
            <div className="text-[17px] font-bold tracking-tight leading-none">
              metri<span className="text-copper">q</span>
            </div>
            <div className="text-[10px] text-muted font-data tracking-wider mt-0.5">{t(lang, 'tagline')}</div>
          </div>
        </Link>
        <nav className="flex items-center gap-1.5">
          <Link href="/" className={`btn btn-ghost ${pathname === '/' ? '!text-ink !border-line' : ''}`}>
            {lang === 'tr' ? 'Panel' : 'Dashboard'}
          </Link>
          <Link href="/calibrations" className={`btn btn-ghost ${pathname.startsWith('/calibrations') ? '!text-ink !border-line' : ''}`}>
            {t(lang, 'calibrations')}
          </Link>
          <div className="ml-2 flex overflow-hidden rounded-lg border border-line font-data text-[11px]">
            {(['tr', 'en'] as Lang[]).map(l => (
              <button key={l} onClick={() => setLang(l)}
                className={`px-2.5 py-1.5 uppercase tracking-wide transition-colors ${lang === l ? 'bg-copper/20 text-copper-bright' : 'text-muted hover:text-ink'}`}>
                {l}
              </button>
            ))}
          </div>
        </nav>
      </div>
    </header>
  );
}
