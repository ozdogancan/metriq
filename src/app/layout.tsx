import type { Metadata } from 'next';
import { Archivo, JetBrains_Mono } from 'next/font/google';
import { cookies } from 'next/headers';
import './globals.css';

const archivo = Archivo({ subsets: ['latin', 'latin-ext'], variable: '--font-archivo' });
const jetbrains = JetBrains_Mono({ subsets: ['latin', 'latin-ext'], variable: '--font-jetbrains' });

export const metadata: Metadata = {
  title: 'Metriq — CAD metraj platformu',
  description: "Modelden metraja, saniyeler içinde. NWD yükle, doğrulanmış MTO Excel'ini indir.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const store = await cookies();
  const lang = store.get('lang')?.value === 'en' ? 'en' : 'tr';
  const theme = store.get('theme')?.value === 'light' ? 'light' : 'dark';
  return (
    <html lang={lang} data-theme={theme} className={`${archivo.variable} ${jetbrains.variable}`}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
