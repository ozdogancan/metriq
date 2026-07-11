// Shared upload guardrails. Keep these values aligned with the Supabase bucket.
export const MAX_NWD_BYTES = 50 * 1024 * 1024;
export const MAX_ANSWER_XLSX_BYTES = 15 * 1024 * 1024;
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
