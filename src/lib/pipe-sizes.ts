/**
 * Standard ASME B36.10 nominal pipe sizes used by Metriq.
 *
 * Keep NPS, DN and outside diameter in one table so parsing and exports cannot
 * drift apart. Values outside this table (for example NPS 14.5) are not
 * standard nominal sizes and must not be inferred with arithmetic fallbacks.
 */
export const ASME_PIPE_SIZES = [
  { nps: 0.5, dn: 15, odMm: 21.3 },
  { nps: 0.75, dn: 20, odMm: 26.7 },
  { nps: 1, dn: 25, odMm: 33.4 },
  { nps: 1.25, dn: 32, odMm: 42.2 },
  { nps: 1.5, dn: 40, odMm: 48.3 },
  { nps: 2, dn: 50, odMm: 60.3 },
  { nps: 2.5, dn: 65, odMm: 73.0 },
  { nps: 3, dn: 80, odMm: 88.9 },
  { nps: 3.5, dn: 90, odMm: 101.6 },
  { nps: 4, dn: 100, odMm: 114.3 },
  { nps: 5, dn: 125, odMm: 141.3 },
  { nps: 6, dn: 150, odMm: 168.3 },
  { nps: 8, dn: 200, odMm: 219.1 },
  { nps: 10, dn: 250, odMm: 273.0 },
  { nps: 12, dn: 300, odMm: 323.9 },
  { nps: 14, dn: 350, odMm: 355.6 },
  { nps: 16, dn: 400, odMm: 406.4 },
  { nps: 18, dn: 450, odMm: 457.2 },
  { nps: 20, dn: 500, odMm: 508.0 },
  { nps: 22, dn: 550, odMm: 558.8 },
  { nps: 24, dn: 600, odMm: 609.6 },
  { nps: 26, dn: 650, odMm: 660.4 },
  { nps: 28, dn: 700, odMm: 711.2 },
  { nps: 30, dn: 750, odMm: 762.0 },
  { nps: 32, dn: 800, odMm: 812.8 },
  { nps: 34, dn: 850, odMm: 863.6 },
  { nps: 36, dn: 900, odMm: 914.4 },
  { nps: 38, dn: 950, odMm: 965.2 },
  { nps: 40, dn: 1000, odMm: 1016.0 },
  { nps: 42, dn: 1050, odMm: 1066.8 },
  { nps: 44, dn: 1100, odMm: 1117.6 },
  { nps: 46, dn: 1150, odMm: 1168.4 },
  { nps: 48, dn: 1200, odMm: 1219.2 },
] as const;

const BY_NPS = new Map<number, (typeof ASME_PIPE_SIZES)[number]>(
  ASME_PIPE_SIZES.map(size => [size.nps, size]),
);
const BY_DN = new Map<number, (typeof ASME_PIPE_SIZES)[number]>(
  ASME_PIPE_SIZES.map(size => [size.dn, size]),
);

export function npsToDn(nps: number | null | undefined): number | null {
  if (nps == null || !Number.isFinite(nps)) return null;
  return BY_NPS.get(nps)?.dn ?? null;
}

export function dnToNps(dn: number | null | undefined): number | null {
  if (dn == null || !Number.isFinite(dn)) return null;
  return BY_DN.get(dn)?.nps ?? null;
}

/**
 * Resolve a measured/modelled OD to the nearest standard ASME NPS.
 * The 2.6 mm tolerance preserves the calibrated parser behaviour while the
 * DN consistency check in the parser prevents an OD-only false positive.
 */
export function asmeOdToNps(odMm: number, toleranceMm = 2.6): number | null {
  if (!Number.isFinite(odMm) || !Number.isFinite(toleranceMm) || toleranceMm < 0) return null;

  let closest: (typeof ASME_PIPE_SIZES)[number] | undefined;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const size of ASME_PIPE_SIZES) {
    const distance = Math.abs(size.odMm - odMm);
    if (distance < closestDistance) {
      closest = size;
      closestDistance = distance;
    }
  }

  return closest && closestDistance <= toleranceMm ? closest.nps : null;
}
