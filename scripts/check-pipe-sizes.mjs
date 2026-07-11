import assert from 'node:assert/strict';
import { ASME_PIPE_SIZES, asmeOdToNps, dnToNps, npsToDn } from '../src/lib/pipe-sizes.ts';

assert.equal(ASME_PIPE_SIZES[0].nps, 0.5);
assert.equal(ASME_PIPE_SIZES.at(-1).nps, 48);
assert.equal(ASME_PIPE_SIZES.length, 33);

for (const { nps, dn, odMm } of ASME_PIPE_SIZES) {
  assert.equal(npsToDn(nps), dn, `NPS ${nps} should map to DN ${dn}`);
  assert.equal(dnToNps(dn), nps, `DN ${dn} should map to NPS ${nps}`);
  assert.equal(asmeOdToNps(odMm), nps, `OD ${odMm} should map to NPS ${nps}`);
}

assert.equal(asmeOdToNps(355.6), 14);
assert.equal(asmeOdToNps(1219.2), 48);
assert.equal(asmeOdToNps(355), 14, 'rounded model ODs remain within parser tolerance');
assert.equal(npsToDn(14.5), null, 'non-standard NPS must not produce a DN');
assert.equal(npsToDn(15), null, 'arithmetic NPS fallbacks are forbidden');
assert.equal(dnToNps(375), null, 'non-standard DN must not produce an NPS');
assert.equal(asmeOdToNps(360), null, 'OD outside tolerance must stay unresolved');
assert.equal(asmeOdToNps(Number.NaN), null);

console.log(`pipe sizes: ${ASME_PIPE_SIZES.length} standard NPS/DN/OD mappings verified`);
