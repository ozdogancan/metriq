import fs from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { url: 'data:text/javascript,export{}', shortCircuit: true };
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier)
        && !/\.\w+$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const [propsPath, answerPath] = process.argv.slice(2);
if (!propsPath || !answerPath) {
  throw new Error('Usage: node --experimental-strip-types scripts/analyze-aps-overlap.mjs <props.json> <answer.xlsx>');
}

const [{ extractFromApsProps }, { parseAnswerXlsx, compareAnswer }, { DEFAULT_RULES }] = await Promise.all([
  import('../src/lib/parser/aps-extract.ts'),
  import('../src/lib/answer-compare.ts'),
  import('../src/lib/types.ts'),
]);

const props = JSON.parse(fs.readFileSync(propsPath, 'utf8'));
const answer = await parseAnswerXlsx(fs.readFileSync(answerPath));
const extracted = extractFromApsProps(props, DEFAULT_RULES['steel-plant']);
const comparison = compareAnswer(extracted.rows, answer.rows, 'corpus-answer', answer.sheet);

const normalizedSize = value => value == null ? '?' : String(Math.round(value * 1000) / 1000);
const key = row => [row.code.trim().toUpperCase().replace(/\s+/g, ' '),
  normalizedSize(row.s1), normalizedSize(row.s2), row.unit].join('|');
const aggregate = (rows, mainOnly) => {
  const values = new Map();
  for (const row of rows) {
    if (mainOnly && row.scope !== 'MAIN') continue;
    const k = key(row);
    const existing = values.get(k);
    if (existing) existing.qty += row.qty;
    else values.set(k, { ...row });
  }
  return values;
};
const percent = (numerator, denominator) => denominator > 0
  ? Math.round(numerator / denominator * 1000) / 10 : 0;

const ours = aggregate(extracted.rows, true);
const reference = aggregate(answer.rows, false);
const exactKeys = [...reference.keys()].filter(value => ours.has(value));
const exactSignatures = comparison.counts.matched + comparison.counts.qtyDiff;
const predictedSignatures = exactSignatures + comparison.counts.fieldDiff + comparison.counts.extra;
const referenceSignatures = exactSignatures + comparison.counts.fieldDiff + comparison.counts.missing;
const signaturePrecision = percent(exactSignatures, predictedSignatures);
const signatureRecall = percent(exactSignatures, referenceSignatures);
const signatureF1 = signaturePrecision + signatureRecall > 0
  ? Math.round(2 * signaturePrecision * signatureRecall / (signaturePrecision + signatureRecall) * 10) / 10 : 0;

const quantitySupport = {};
for (const unit of ['M', 'EA', 'ALL']) {
  const inUnit = row => unit === 'ALL' || row.unit === unit;
  const answerTotal = [...reference.values()].filter(inUnit).reduce((sum, row) => sum + row.qty, 0);
  const exactSupported = exactKeys.map(value => reference.get(value)).filter(inUnit)
    .reduce((sum, row) => sum + row.qty, 0);
  const fieldSupported = comparison.rows
    .filter(row => row.status === 'field_diff' && (unit === 'ALL' || row.unit === unit))
    .reduce((sum, row) => sum + row.answer, 0);
  const extraOurs = [...ours.entries()].filter(([value, row]) => !reference.has(value) && inUnit(row))
    .reduce((sum, [, row]) => sum + row.qty, 0);
  quantitySupport[unit] = {
    answerTotal: Math.round(answerTotal * 1000) / 1000,
    exactSupported: Math.round(exactSupported * 1000) / 1000,
    exactSupportPercent: percent(exactSupported, answerTotal),
    includingUniqueFieldCorrectionPercent: percent(exactSupported + fieldSupported, answerTotal),
    uncoveredAnswerQuantity: Math.round((answerTotal - exactSupported - fieldSupported) * 1000) / 1000,
    extraOurs: Math.round(extraOurs * 1000) / 1000,
  };
}

console.log(JSON.stringify({
  extraction: {
    family: extracted.family,
    quality: extracted.quality,
    confidence: extracted.confidence,
    coverage: extracted.coverage,
    rows: extracted.rows.length,
    candidateGroups: extracted.candidates.length,
  },
  measured: comparison.metrics,
  signatureSupportCeiling: {
    exactSignatures,
    predictedSignatures,
    referenceSignatures,
    precision: signaturePrecision,
    recall: signatureRecall,
    f1: signatureF1,
  },
  quantitySupportCeiling: quantitySupport,
}, null, 2));
