import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { METRIQ_CORPUS_MANIFEST_VERSION, metriqCorpusManifest } from './metriq-corpus-manifest.mjs';

// Next resolves extensionless TypeScript imports; raw Node does not. Register a
// narrowly scoped read-only resolver before loading production modules.
register(new URL('./typescript-loader-hooks.mjs', import.meta.url));
const [answerModule, apsModule, nwdModule, typesModule, vocabModule] = await Promise.all([
  import('../src/lib/answer-compare.ts'),
  import('../src/lib/parser/aps-extract.ts'),
  import('../src/lib/parser/nwd.ts'),
  import('../src/lib/types.ts'),
  import('../src/lib/vocab.ts'),
]);
const { parseAnswerXlsx, compareAnswer } = answerModule;
const { extractFromApsProps } = apsModule;
const { parseNwd } = nwdModule;
const { DEFAULT_RULES } = typesModule;
const { applyRules, detectVocab } = vocabModule;

const gateMode = process.argv.includes('--gate');
const corpusRoot = process.env.METRIQ_CORPUS_ROOT;
const propsRoot = process.env.METRIQ_CORPUS_PROPS_ROOT;
const outputRoot = process.env.METRIQ_CORPUS_OUTPUT_DIR
  || path.join(os.tmpdir(), 'metriq-corpus-results');
const selectedIds = new Set((process.env.METRIQ_CORPUS_CASES || '')
  .split(',').map(value => value.trim().toLowerCase()).filter(Boolean));

function threshold(name, fallback) {
  const raw = process.env[name];
  const value = raw == null || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${name} must be a number between 0 and 100.`);
  }
  return value;
}

const thresholds = {
  f1: threshold('METRIQ_CORPUS_MIN_F1', 90),
  quantityWeightedOverlap: threshold('METRIQ_CORPUS_MIN_QUANTITY_OVERLAP', 90),
};

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

function hash(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function discoverFiles(root, accept) {
  if (!root) return [];
  const found = [];
  const pending = [path.resolve(root)];
  let visitedEntries = 0;
  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      visitedEntries++;
      if (visitedEntries > 10_000) {
        throw new Error('Corpus discovery exceeded the 10,000-entry safety limit.');
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && accept(entry.name)) found.push(absolute);
    }
  }
  return found.sort((a, b) => path.relative(root, a).localeCompare(path.relative(root, b)));
}

async function discoverFixturePairs(root) {
  const files = await discoverFiles(root, name => /\.nwd$/i.test(name) || /\.xls(?:x|m)?$/i.test(name));
  const byDirectory = new Map();
  for (const file of files) {
    if (path.basename(file).startsWith('~$')) continue;
    const directory = path.dirname(file);
    const group = byDirectory.get(directory) || { nwd: [], answers: [] };
    if (/\.nwd$/i.test(file)) group.nwd.push(file);
    else group.answers.push(file);
    byDirectory.set(directory, group);
  }
  const answerRank = file => ({ '.xls': 0, '.xlsm': 1, '.xlsx': 2 }[path.extname(file).toLowerCase()] ?? 9);
  const pairs = [];
  for (const group of byDirectory.values()) {
    if (group.nwd.length !== 1 || group.answers.length === 0) continue;
    group.answers.sort((a, b) => answerRank(a) - answerRank(b) || a.localeCompare(b));
    pairs.push({ nwd: group.nwd[0], answer: group.answers[0] });
  }
  return pairs.sort((a, b) => path.relative(root, a.nwd).localeCompare(path.relative(root, b.nwd)));
}

const discoveredFixtures = await discoverFixturePairs(corpusRoot);
const discoveredProps = await discoverFiles(propsRoot, name => /(?:^|[-_.])props\.json$/i.test(name));

function relativeCasePaths(fixture) {
  const nwd = fixture.external?.nwdEnv ? process.env[fixture.external.nwdEnv] : null;
  const answer = fixture.external?.answerEnv ? process.env[fixture.external.answerEnv] : null;
  const props = fixture.external?.propsEnv ? process.env[fixture.external.propsEnv] : null;
  if (nwd || answer || props) {
    return { nwd: nwd || '', answer: answer || '', props: props || null };
  }
  const discovered = fixture.discoveryIndex == null ? null : discoveredFixtures[fixture.discoveryIndex];
  if (!discovered) return null;
  return {
    ...discovered,
    props: fixture.propsDiscoveryIndex == null ? null : (discoveredProps[fixture.propsDiscoveryIndex] || null),
  };
}

function gateFor(fixture, result) {
  if (result.status === 'skipped_optional') return { pass: true, reasons: ['optional fixture not supplied'] };
  if (fixture.expectation === 'unsupported') {
    return result.status === 'unsupported'
      ? { pass: true, reasons: ['unsupported control failed closed as expected'] }
      : { pass: false, reasons: [`expected unsupported, observed ${result.status}; review fixture classification`] };
  }
  if (result.status !== 'measured') return { pass: false, reasons: [`scored fixture was ${result.status}`] };
  const reasons = [];
  if (result.metrics.f1 < thresholds.f1) reasons.push(`F1 ${result.metrics.f1} < ${thresholds.f1}`);
  if (result.metrics.quantityWeightedOverlap.percent < thresholds.quantityWeightedOverlap) {
    reasons.push(`quantity overlap ${result.metrics.quantityWeightedOverlap.percent} < ${thresholds.quantityWeightedOverlap}`);
  }
  return { pass: reasons.length === 0, reasons };
}

async function replay(fixture) {
  const paths = relativeCasePaths(fixture);
  if (!paths) {
    const result = fixture.optional
      ? { id: fixture.id, label: fixture.label, expectation: fixture.expectation, status: 'skipped_optional' }
      : {
        id: fixture.id, label: fixture.label, expectation: fixture.expectation,
        status: 'missing_fixture',
        error: 'Fixture paths were not supplied and no generic corpus-root pair was discovered for this slot.',
      };
    return { ...result, gate: gateFor(fixture, result) };
  }
  if (!await exists(paths.nwd) || !await exists(paths.answer)) {
    const result = {
      id: fixture.id, label: fixture.label, expectation: fixture.expectation,
      status: 'missing_fixture', error: 'NWD or answer workbook is absent under the configured corpus root.',
    };
    return { ...result, gate: gateFor(fixture, result) };
  }

  try {
    const [nwdBuffer, answerBuffer] = await Promise.all([readFile(paths.nwd), readFile(paths.answer)]);
    const answer = await parseAnswerXlsx(answerBuffer);
    let parsed = null;
    let localError = null;
    try { parsed = parseNwd(nwdBuffer); } catch (error) { localError = error instanceof Error ? error.message : String(error); }
    const sizedRatio = parsed?.components.length
      ? parsed.components.filter(component => component.s1 != null).length / parsed.components.length : 0;

    let route;
    let rows;
    let extractionStatus = 'measured';
    let vocab = 'steel-plant';
    let model;
    if (parsed?.components.length && sizedRatio >= 0.3) {
      route = 'local';
      vocab = detectVocab(parsed).vocab;
      const applied = applyRules(parsed, DEFAULT_RULES[vocab]);
      rows = applied.rows;
      model = {
        components: parsed.components.length,
        sizedRatio: Math.round(sizedRatio * 1000) / 1000,
        family: null,
        structured: parsed.components.length,
      };
    } else {
      route = 'aps-snapshot';
      if (!paths.props || !await exists(paths.props)) {
        const result = {
          id: fixture.id, label: fixture.label, expectation: fixture.expectation,
          status: 'missing_artifact', route,
          error: 'APS route is required but its property snapshot is absent. Set the slot PROPS variable or METRIQ_CORPUS_PROPS_ROOT.',
          localError,
          answer: { sheet: answer.sheet, rows: answer.rows.length },
        };
        return { ...result, gate: gateFor(fixture, result) };
      }
      const collection = JSON.parse(await readFile(paths.props, 'utf8'));
      const extracted = extractFromApsProps(collection, DEFAULT_RULES['steel-plant']);
      model = {
        components: parsed?.components.length ?? 0,
        sizedRatio: Math.round(sizedRatio * 1000) / 1000,
        family: extracted.family,
        quality: extracted.quality ?? (extracted.family === 'none' ? 'none' : 'structured'),
        confidence: extracted.confidence ?? null,
        coverage: extracted.coverage ?? null,
        structured: extracted.structuredCount,
        totalObjects: extracted.totalCount,
      };
      const quality = extracted.quality ?? (extracted.family === 'none' ? 'none' : 'structured');
      if (extracted.family === 'none' || extracted.rows.length === 0
        || (fixture.expectation === 'unsupported' && quality !== 'structured')) {
        const result = {
          id: fixture.id, label: fixture.label, expectation: fixture.expectation,
          status: 'unsupported', route, vocab, model, localError,
          answer: { sheet: answer.sheet, rows: answer.rows.length },
          reason: fixture.unsupportedReason || 'No structured MTO properties were extracted.',
          fixtureHashes: { nwdSha256: hash(nwdBuffer), answerSha256: hash(answerBuffer) },
        };
        return { ...result, gate: gateFor(fixture, result) };
      }
      rows = extracted.rows;
      if (quality !== 'structured') extractionStatus = 'partial';
    }

    const comparison = compareAnswer(rows, answer.rows, 'corpus-answer', answer.sheet);
    const result = {
      id: fixture.id,
      label: fixture.label,
      expectation: fixture.expectation,
      status: extractionStatus,
      route,
      vocab,
      model,
      localError,
      answer: { sheet: answer.sheet, rows: answer.rows.length },
      accuracy: comparison.accuracy,
      counts: comparison.counts,
      metrics: comparison.metrics,
      fixtureHashes: { nwdSha256: hash(nwdBuffer), answerSha256: hash(answerBuffer) },
    };
    return { ...result, gate: gateFor(fixture, result) };
  } catch (error) {
    const result = {
      id: fixture.id, label: fixture.label, expectation: fixture.expectation,
      status: 'error', error: error instanceof Error ? error.message : String(error),
    };
    return { ...result, gate: gateFor(fixture, result) };
  }
}

function display(value) {
  return value == null ? '—' : String(value);
}

function markdown(report) {
  const lines = [
    '# Metriq corpus replay',
    '',
    `- Generated: ${report.generatedAt}`,
    `- Commit: \`${report.commit}\``,
    `- Manifest: v${report.manifestVersion} (${report.results.length} selected cases)`,
    `- Gate thresholds: F1 ≥ ${report.thresholds.f1}; quantity-weighted overlap ≥ ${report.thresholds.quantityWeightedOverlap}`,
    `- Gate: **${report.gate.pass ? 'PASS' : 'FAIL'}**`,
    '',
    '| Case | Expectation | Status | Route | Accuracy | Precision | Recall | F1 | Qty overlap | Gate |',
    '|---|---|---|---|---:|---:|---:|---:|---:|---|',
  ];
  for (const result of report.results) {
    lines.push(`| ${result.id} | ${result.expectation} | ${result.status} | ${display(result.route)} | ${display(result.accuracy)} | ${display(result.metrics?.precision)} | ${display(result.metrics?.recall)} | ${display(result.metrics?.f1)} | ${display(result.metrics?.quantityWeightedOverlap?.percent)} | ${result.gate.pass ? 'PASS' : `FAIL: ${result.gate.reasons.join('; ')}`} |`);
  }
  lines.push('', '## Notes', '');
  for (const result of report.results.filter(value => value.error || value.reason || value.localError)) {
    lines.push(`- **${result.id}:** ${result.error || result.reason || result.localError}`);
  }
  return `${lines.join('\n')}\n`;
}

let commit = 'unknown';
try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* non-Git runner */ }

const fixtures = metriqCorpusManifest.filter(fixture => selectedIds.size === 0 || selectedIds.has(fixture.id));
const results = [];
for (const fixture of fixtures) {
  process.stderr.write(`[corpus] ${fixture.id}\n`);
  results.push(await replay(fixture));
}
const report = {
  schemaVersion: 1,
  manifestVersion: METRIQ_CORPUS_MANIFEST_VERSION,
  generatedAt: new Date().toISOString(),
  commit,
  thresholds,
  results,
  gate: {
    pass: results.every(result => result.gate.pass),
    failedCases: results.filter(result => !result.gate.pass).map(result => result.id),
  },
};
const reportMarkdown = markdown(report);
await mkdir(outputRoot, { recursive: true });
const jsonPath = path.join(outputRoot, 'metriq-corpus-report.json');
const markdownPath = path.join(outputRoot, 'metriq-corpus-report.md');
await Promise.all([
  writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
  writeFile(markdownPath, reportMarkdown, 'utf8'),
]);
process.stdout.write(reportMarkdown);
process.stdout.write(`\nJSON: ${jsonPath}\nMarkdown: ${markdownPath}\n`);
if (gateMode && !report.gate.pass) process.exitCode = 1;
