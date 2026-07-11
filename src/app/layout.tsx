import type { Metadata } from 'next';
import { Archivo, JetBrains_Mono } from 'next/font/google';
import { cookies } from 'next/headers';
import { Toaster } from 'sonner';
import { langFromCookie } from '@/lib/i18n';
import './globals.css';

const archivo = Archivo({ subsets: ['latin', 'latin-ext'], variable: '--font-archivo' });
const jetbrains = JetBrains_Mono({ subsets: ['latin', 'latin-ext'], variable: '--font-jetbrains' });

export const metadata: Metadata = {
  metadataBase: new URL('https://metriq-seven.vercel.app'),
  title: 'Metriq — CAD metraj platformu',
  description: "Modelden metraja, saniyeler içinde. NWD yükle, doğrulanmış MTO Excel'ini indir.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const store = await cookies();
  const lang = langFromCookie(store.get('lang')?.value);
  const theme = store.get('theme')?.value === 'light' ? 'light' : 'dark';
  return (
    <html lang={lang} data-theme={theme} className={`${archivo.variable} ${jetbrains.variable}`}>
      <body className="antialiased">
        {children}
        <Toaster theme={theme} position="bottom-right" toastOptions={{
          style: { background: 'var(--color-panel)', color: 'var(--color-ink)', border: '1px solid var(--color-line)', fontSize: '13px' },
        }} />
      </body>
    </html>
  );
}
