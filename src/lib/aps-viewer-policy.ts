// Pure policy for the APS Viewer proxy. Keeping this separate from the route
// makes the security boundary easy to exercise without a live APS account.

const SOURCE_URN = /^[A-Za-z0-9_-]{16,2048}$/;
const REGION = /^(?:eu|aus)$/;
const MAX_RESOURCE_CHARS = 8192;

export type AuthorizedViewerPath = {
  upstreamPath: string;
  kind: 'source' | 'derivative';
};

function safeSegment(value: string): boolean {
  if (!value || value.length > MAX_RESOURCE_CHARS || /[\u0000-\u001f\u007f]/.test(value)) return false;
  return !value.split('/').some(part => part === '.' || part === '..');
}

/**
 * Authorize and canonicalize one Viewer request against the source URN owned
 * by the current tenant. APS derivative asset URNs embed the source URN:
 *   urn:adsk.viewing:fs.file:<source urn>/output/...
 * This prevents a user from borrowing an owned run id while asking the shared
 * APS application for another customer's derivative.
 */
export function authorizeViewerPath(slug: readonly string[], ownedUrn: string): AuthorizedViewerPath | null {
  if (!SOURCE_URN.test(ownedUrn) || slug.length < 4 || slug.length > 7) return null;
  if (slug[0] !== 'derivativeservice' || slug[1] !== 'v2') return null;
  if (!slug.every(safeSegment)) return null;

  let operationIndex = 2;
  const prefix = ['derivativeservice', 'v2'];
  if (slug[2] === 'regions') {
    if (slug.length < 6 || !REGION.test(slug[3])) return null;
    prefix.push('regions', slug[3]);
    operationIndex = 4;
  }

  const operation = slug[operationIndex];
  const targets = slug.slice(operationIndex + 1);
  // Viewer encodes the complete URN as one path parameter. Reject unencoded
  // slashes so there is only one canonical interpretation of the request.
  if (targets.length !== 1) return null;
  const target = targets[0];

  let kind: AuthorizedViewerPath['kind'];
  let upstreamTarget = target;
  if (operation === 'manifest' || operation === 'thumbnails' || operation === 'endpoints') {
    // Viewer manifest'i "urn:<base64>" ÖNEKİYLE ister (Document.load('urn:…')).
    // Önek sahiplik karşılaştırmasından önce soyulur; yoksa her manifest isteği
    // 403 alır ve Viewer stok "No access" diyaloğunu gösterir (gerçek vaka).
    // Upstream'e ise ÇIPLAK base64 iletilir — cdn.derivative önekli manifest'e
    // 400 "requested manifest urn is invalid" döner (canlıda doğrulandı).
    const bare = target.startsWith('urn:') ? target.slice(4) : target;
    if (bare !== ownedUrn) return null;
    upstreamTarget = bare;
    kind = 'source';
  } else if (operation === 'derivatives') {
    // Derivative varlık URN'i ('urn:adsk.viewing:fs.file:…') upstream'in
    // beklediği tam formattır — olduğu gibi iletilir.
    if (!target.startsWith(`urn:adsk.viewing:fs.file:${ownedUrn}/`)) return null;
    kind = 'derivative';
  } else {
    return null;
  }

  const canonical = [...prefix, operation, encodeURIComponent(upstreamTarget)].join('/');
  return { upstreamPath: canonical, kind };
}
