import { cookies } from 'next/headers';
import { Header } from '@/components/header';
import type { Lang } from '@/lib/i18n';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const store = await cookies();
  const lang = (store.get('lang')?.value === 'en' ? 'en' : 'tr') as Lang;
  const theme = store.get('theme')?.value === 'light' ? 'light' : 'dark';
  return (
    <>
      <Header lang={lang} theme={theme} />
      <main className="mx-auto max-w-6xl px-5 pb-24 pt-8">{children}</main>
      <footer className="mx-auto max-w-6xl px-5 pb-10">
        <div className="flex items-center justify-between border-t border-line pt-5 text-[11px] text-muted font-data">
          <span>METRIQ · MTO ENGINE v1</span>
          <span>ASME B36.10 + DIN 11850-2</span>
        </div>
      </footer>
    </>
  );
}
