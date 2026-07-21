import assert from 'node:assert/strict';
import {
  deriveCalibrationRules,
  isCorrectionRuleActive,
} from '../src/lib/calibration-core.ts';

const base = () => ({
  vocab: 'steel-plant',
  merge45Into90: true,
  collarOneToOne: false,
  excludeCompanionFlanges: true,
  includeValvesInMain: false,
  includeFasteners: false,
  grossPipeFactor: 1,
  codeRenames: {},
  excludeLines: [],
  itemCorrections: [],
});

function quantityDiff({ id = 'cmp-1', line } = {}) {
  return {
    id,
    fileName: 'answer.xlsx',
    sheet: 'MTO',
    accuracy: 0,
    counts: { matched: 0, qtyDiff: 1, fieldDiff: 0, missing: 0, extra: 0 },
    createdAt: new Date(0).toISOString(),
    rows: [{
      id: 'diff-1', status: 'qty_diff', kind: 'quantity', code: 'ELBOW',
      s1: 2, s2: 0, unit: 'EA', ours: 2, answer: 4,
      oursSide: {
        value: { code: 'ELBOW', s1: 2, s2: 0, qty: 2, unit: 'EA' },
        rowIds: ['row-1'], ...(line ? { lines: [line] } : {}), subs: [''],
      },
      answerSide: {
        value: { code: 'ELBOW', s1: 2, s2: 0, qty: 4, unit: 'EA' },
        rowIds: [],
      },
    }],
  };
}

const decisions = [{ itemId: 'diff-1', choice: 'answer' }];
let seq = 0;
const idFactory = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

// A broad transform may never become production-active from one model or from
// repeated submissions of that same model.
const first = deriveCalibrationRules(base(), quantityDiff(), decisions, idFactory, 'run-a');
assert.equal(first.candidateRules, 1);
assert.equal(first.activatedRules, 0);
assert.equal(first.rules.itemCorrections[0].set.qtyFactor, 2);
assert.equal(first.rules.itemCorrections[0].status, 'candidate');
assert.equal(isCorrectionRuleActive(first.rules.itemCorrections[0]), false);

const duplicate = deriveCalibrationRules(first.rules, quantityDiff(), decisions, idFactory, 'run-a');
assert.equal(duplicate.rules.itemCorrections[0].evidenceCount, 1, 'same run is not independent evidence');
assert.equal(duplicate.rules.itemCorrections[0].status, 'candidate');

const second = deriveCalibrationRules(duplicate.rules, quantityDiff(), decisions, idFactory, 'run-b');
assert.deepEqual(second.rules.itemCorrections[0].evidenceRunIds.sort(), ['run-a', 'run-b']);
assert.equal(second.rules.itemCorrections[0].status, 'active');
assert.equal(second.activatedRules, 1);

// A line-qualified correction has a narrow blast radius and can activate from
// the explicit decision immediately.
const contextual = deriveCalibrationRules(base(), quantityDiff({ line: 'L-100' }), decisions, idFactory, 'run-c');
assert.equal(contextual.rules.itemCorrections[0].status, 'active');
assert.equal(contextual.rules.itemCorrections[0].minEvidence, 1);

// Legacy profiles had no lifecycle flag. They must keep working after migration.
assert.equal(isCorrectionRuleActive({
  id: idFactory(),
  match: { code: 'CAP', s1: 2, s2: 0, unit: 'EA' },
  set: { code: 'END CAP' },
  source: 'custom',
  evidenceCount: 1,
}), true);

console.log('calibration learning: distinct-run evidence gate and legacy compatibility verified');
