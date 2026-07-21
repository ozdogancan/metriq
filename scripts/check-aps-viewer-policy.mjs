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
