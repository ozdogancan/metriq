import type { Metadata } from 'next';
import { Archivo, JetBrains_Mono } from 'next/font/google';
import { cookies } from 'next/headers';
import './globals.css';
import { Header } from '@/components/header';
import type { Lang } from '@/lib/i18n';

const archivo = Archivo({ subsets: ['latin', 'latin-ext'], variable: '--font-archivo' });
const jetbrains = JetBrains_Mono({ subsets: ['latin', 'latin-ext'], variable: '--font-jetbrains' });

export const metadata: Metadata = {
  title: 'Metriq — CAD metraj platformu',
  description: "Modelden metraja, saniyeler içinde. NWD yükle, doğrulanmış MTO Excel'ini indir.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const store = await cookies();
  const lang = (store.get('lang')?.value === 'en' ? 'en' : 'tr') as Lang;
  return (
    <html lang={lang} className={`${archivo.variable} ${jetbrains.variable}`}>
      <body className="antialiased">
        <Header lang={lang} />
        <main className="mx-auto max-w-6xl px-5 pb-24 pt-8">{children}</main>
        <footer className="mx-auto max-w-6xl px-5 pb-10">
          <div className="flex items-center justify-between border-t border-line pt-5 text-[11px] text-muted font-data">
            <span>METRIQ · MTO ENGINE v1</span>
            <span>ASME B36.10 + DIN 11850-2</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
