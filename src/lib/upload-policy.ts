// Shared upload guardrails. Keep these values aligned with the Supabase bucket.
// Canlı Supabase projesinin proje-geneli Storage tavanı 50 MB. UI/API daha
// yüksek bir değer vaat ederse imzalı yükleme bucket katmanında geç ve belirsiz
// biçimde kırılır; bu nedenle tek politika sabiti gerçek platform tavanıdır.
export const MAX_NWD_BYTES = 50 * 1024 * 1024;
// Answer workbooks currently use multipart through a Vercel Function. Keep
// enough headroom below Vercel's 4.5 MB request-body ceiling for boundaries.
export const MAX_ANSWER_XLSX_BYTES = 4 * 1024 * 1024;
export const MAX_PROJECT_NAME_CHARS = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function isSafeNwdFileName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 4
    && value.length <= 180
    && value.trim() === value
    && !/[\\/\0]/.test(value)
    && value.toLowerCase().endsWith('.nwd');
}

// Supabase Storage anahtarları köşeli parantez / Türkçe karakter / bazı özel
// karakterlerde "Invalid key" verir. Görünen dosya adı (run.fileName) aynen
// korunur; DEPOLAMA anahtarı bu deterministik ASCII ada çevrilir.
export function storageKeyName(fileName: string): string {
  const trMap: Record<string, string> = {
    ı: 'i', İ: 'I', ş: 's', Ş: 'S', ğ: 'g', Ğ: 'G',
    ç: 'c', Ç: 'C', ö: 'o', Ö: 'O', ü: 'u', Ü: 'U',
  };
  const base = fileName.replace(/\.nwd$/i, '')
    .replace(/[ıİşŞğĞçÇöÖüÜ]/g, ch => trMap[ch] ?? ch)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '')
    .slice(0, 120);
  return (base || 'model') + '.nwd';
}

export function isAllowedNwdSize(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
    && value <= MAX_NWD_BYTES;
}

// NWD containers used by the parser contain one or more zlib streams. This is
// a cheap preflight, not a replacement for the parser's structural checks.
export function hasNwdDataMarker(bytes: Uint8Array): boolean {
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0x78 && (bytes[i + 1] === 0x9c || bytes[i + 1] === 0xda || bytes[i + 1] === 0x01)) {
      return true;
    }
  }
  return false;
}
