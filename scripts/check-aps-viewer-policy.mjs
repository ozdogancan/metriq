import assert from 'node:assert/strict';
import { authorizeViewerPath } from '../src/lib/aps-viewer-policy.ts';

const urn = 'dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6bWV0cmlxL2RlbW8ubndk';
const otherUrn = 'dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6bWV0cmlxL290aGVyLm53ZA';

assert.equal(authorizeViewerPath(['derivativeservice', 'v2', 'manifest', urn], urn)?.kind, 'source');
assert.equal(authorizeViewerPath(['derivativeservice', 'v2', 'endpoints', urn], urn)?.kind, 'source');
assert.equal(
  authorizeViewerPath(['derivativeservice', 'v2', 'regions', 'eu', 'thumbnails', urn], urn)?.kind,
  'source',
);

const ownAsset = `urn:adsk.viewing:fs.file:${urn}/output/Resource/model.svf`;
assert.equal(
  authorizeViewerPath(['derivativeservice', 'v2', 'derivatives', ownAsset], urn)?.kind,
  'derivative',
);

assert.equal(authorizeViewerPath(['derivativeservice', 'v2', 'manifest', otherUrn], urn), null);
assert.equal(
  authorizeViewerPath([
    'derivativeservice',
    'v2',
    'derivatives',
    `urn:adsk.viewing:fs.file:${otherUrn}/output/model.svf`,
  ], urn),
  null,
);
assert.equal(authorizeViewerPath(['derivativeservice', 'v2', 'derivatives', '../secret'], urn), null);
assert.equal(authorizeViewerPath(['https:', '', 'evil.example'], urn), null);

console.log('APS viewer proxy: tenant/run URN boundary verified');

// REGRESYON (gercek vaka): Viewer manifest'i "urn:<base64>" ONEKIYLE ister —
// onek soyulmadan sahiplik karsilastirmasi 403 uretir ve Autodesk "No access"
// diyalogu cikar. Onekli istek KABUL, baskasinin URN'i onekli de olsa RED.
{
  const OWNED = 'dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6dGVzdC90ZXN0LW93bmVk';
  const ok = authorizeViewerPath(['derivativeservice', 'v2', 'manifest', `urn:${OWNED}`], OWNED);
  assert.ok(ok && ok.kind === 'source', 'urn: onekli manifest kabul edilmeli');
  const bare = authorizeViewerPath(['derivativeservice', 'v2', 'manifest', OWNED], OWNED);
  assert.ok(bare && bare.kind === 'source', 'oneksiz manifest de kabul edilmeli');
  const foreign = authorizeViewerPath(['derivativeservice', 'v2', 'manifest', 'urn:BASKASININURNIBASKASININURNI'], OWNED);
  assert.equal(foreign, null, 'baskasinin URN\'i onekli de olsa reddedilmeli');
  const thumb = authorizeViewerPath(['derivativeservice', 'v2', 'thumbnails', `urn:${OWNED}`], OWNED);
  assert.ok(thumb, 'urn: onekli thumbnail kabul edilmeli');
}
console.log('viewer policy: urn:-prefixed manifest regression covered');

// Upstream normalizasyonu: onekli manifest KABUL edilir ama upstream'e CIPLAK
// base64 gider (cdn.derivative onekliye 400 verir — canli dogrulama).
{
  const OWNED = 'dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6dGVzdC90ZXN0LW93bmVk';
  const viaPrefix = authorizeViewerPath(['derivativeservice', 'v2', 'manifest', `urn:${OWNED}`], OWNED);
  assert.ok(viaPrefix && !viaPrefix.upstreamPath.includes('urn%3A') && viaPrefix.upstreamPath.endsWith(encodeURIComponent(OWNED)),
    'onekli manifest upstream\'e CIPLAK base64 olarak gitmeli');
  const deriv = authorizeViewerPath(['derivativeservice', 'v2', 'derivatives', `urn:adsk.viewing:fs.file:${OWNED}/output/geom.svf`], OWNED);
  assert.ok(deriv && deriv.upstreamPath.includes(encodeURIComponent('urn:adsk.viewing:fs.file:')),
    'derivative URN formu upstream\'e OLDUGU GIBI gitmeli');
}
console.log('viewer policy: upstream bare-urn normalization covered');
