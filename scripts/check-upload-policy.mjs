import assert from 'node:assert/strict';
import { isSafeNwdFileName, storageKeyName } from '../src/lib/upload-policy.ts';

const visibleName = 'Ünite [Rev 2] ölçüm.nwd';
assert.equal(isSafeNwdFileName(visibleName), true);
const keyName = storageKeyName(visibleName);
assert.match(keyName, /^[A-Za-z0-9._-]+\.nwd$/);
assert.equal(keyName.includes('['), false);
assert.equal(keyName.includes('Ü'), false);
assert.equal(storageKeyName('...nwd'), 'model.nwd');
assert.equal(storageKeyName('plain.nwd'), 'plain.nwd');

console.log('upload policy: visible Unicode name maps to deterministic safe Storage key');
