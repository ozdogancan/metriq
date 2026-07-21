import type {
  AnswerDiff,
  AnswerDiffRow,
  AnswerValue,
  CalibrationRules,
  ItemCorrectionRule,
  MtoRow,
} from './types';

export type CalibrationChoice = 'ours' | 'answer' | 'custom';

export interface CalibrationDecisionInput {
  itemId: string;
  choice: CalibrationChoice;
  custom?: AnswerValue;
}

export interface DerivedRulesResult {
  rules: CalibrationRules;
  activatedRules: number;
  candidateRules: number;
  recordedExamples: number;
}

const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const normCode = (value: string) => value.trim().toUpperCase().replace(/\s+/g, ' ');

export function answerValuesEqual(a: AnswerValue | null, b: AnswerValue | null): boolean {
  if (a === null || b === null) return a === b;
  const qtyTolerance = b.unit === 'M' ? Math.max(0.1, Math.abs(b.qty) * 0.02) : 0.001;
  return normCode(a.code) === normCode(b.code)
    && a.unit === b.unit
    && (a.s1 === null || b.s1 === null ? a.s1 === b.s1 : Math.abs(a.s1 - b.s1) <= 0.001)
    && Math.abs(a.s2 - b.s2) <= 0.001
    && Math.abs(a.qty - b.qty) <= qtyTolerance;
}

export function selectedValue(item: AnswerDiffRow, decision: CalibrationDecisionInput): AnswerValue | null {
  if (decision.choice === 'custom') return decision.custom ?? null;
  if (decision.choice === 'answer') return item.answerSide?.value ?? null;
  return item.oursSide?.value ?? null;
}

export function projectedAccuracy(answer: AnswerDiff, decisions: CalibrationDecisionInput[]): number {
  const byId = new Map(decisions.map(decision => [decision.itemId, decision]));
  let matched = 0;
  for (const item of answer.rows) {
    if (item.status === 'match') {
      matched++;
      continue;
    }
    if (!item.id) continue;
    const decision = byId.get(item.id);
    if (decision && answerValuesEqual(selectedValue(item, decision), item.answerSide?.value ?? null)) matched++;
  }
  return answer.rows.length ? Math.round((matched / answer.rows.length) * 1000) / 10 : 0;
}

function distributeQuantity(source: MtoRow[], total: number): number[] {
  if (source.length === 1) return [round6(total)];
  const sourceTotal = source.reduce((sum, row) => sum + row.qty, 0);
  if (sourceTotal <= 0) return source.map((_, index) => index === 0 ? round6(total) : 0);
  const values = source.map(row => round6((row.qty / sourceTotal) * total));
  values[values.length - 1] = round6(values[values.length - 1] + total - values.reduce((a, b) => a + b, 0));
  return values;
}

export function applyCalibrationDecisions(
  currentRows: MtoRow[],
  answer: AnswerDiff,
  decisions: CalibrationDecisionInput[],
  idFactory: (item: AnswerDiffRow) => string = item => `cal-${item.id ?? 'row'}`,
): MtoRow[] {
  const result = currentRows.map(row => ({ ...row }));
  const byId = new Map(decisions.map(decision => [decision.itemId, decision]));

  for (const item of answer.rows) {
    if (item.status === 'match' || !item.id) continue;
    const decision = byId.get(item.id);
    if (!decision) throw new Error(`Karar eksik: ${item.id}`);
    const chosen = selectedValue(item, decision);
    const sourceIds = new Set(item.oursSide?.rowIds ?? []);
    const source = result.filter(row => sourceIds.has(row.id));

    if (sourceIds.size && source.length !== sourceIds.size) {
      throw new Error(`Karşılaştırmanın kaynak satırları değişmiş: ${item.id}`);
    }
    if (answerValuesEqual(chosen, item.oursSide?.value ?? null)) continue;

    if (!chosen) {
      for (let index = result.length - 1; index >= 0; index--) {
        if (sourceIds.has(result[index].id)) result.splice(index, 1);
      }
      continue;
    }

    if (!source.length) {
      result.push({
        id: idFactory(item),
        line: '?',
        code: chosen.code,
        sub: '',
        s1: chosen.s1,
        s2: chosen.s2,
        qty: chosen.qty,
        unit: chosen.unit,
        remark: 'kalibrasyon kararıyla eklendi',
        scope: 'MAIN',
        edited: true,
      });
      continue;
    }

    const quantities = distributeQuantity(source, chosen.qty);
    source.forEach((sourceRow, index) => {
      const target = result.find(row => row.id === sourceRow.id)!;
      target.code = chosen.code;
      target.s1 = chosen.s1;
      target.s2 = chosen.s2;
      target.qty = quantities[index];
      target.unit = chosen.unit;
      target.edited = true;
      if (!target.remark.includes('kalibrasyon')) {
        target.remark = [target.remark, 'kalibrasyon kararı'].filter(Boolean).join('; ');
      }
    });
  }

  return result.filter(row => row.qty > 0);
}

function oneUseful(values: string[] | undefined, rejected: Set<string>): string | undefined {
  const unique = [...new Set((values ?? []).map(value => value.trim()).filter(value => value && !rejected.has(value)))];
  return unique.length === 1 ? unique[0] : undefined;
}

function sameRuleMatch(a: ItemCorrectionRule['match'], b: ItemCorrectionRule['match']): boolean {
  return normCode(a.code) === normCode(b.code)
    && a.s1 === b.s1 && a.s2 === b.s2 && a.unit === b.unit
    && a.line === b.line && a.sub === b.sub;
}

function sameRuleSet(a: ItemCorrectionRule['set'], b: ItemCorrectionRule['set']): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Legacy rules pre-date lifecycle state and remain active for compatibility. */
export function isCorrectionRuleActive(rule: ItemCorrectionRule): boolean {
  return rule.status === undefined || rule.status === 'active';
}

function minimumEvidence(rule: Pick<ItemCorrectionRule, 'match' | 'set'>): number {
  // A line/sub-qualified correction has a deliberately narrow blast radius. Generic
  // transforms (especially unknown-size assignment, scope and quantity scaling) need
  // two distinct models before they may affect a future take-off.
  if (rule.match.line !== undefined || rule.match.sub !== undefined) return 1;
  return 2;
}

function evidenceIds(rule: ItemCorrectionRule, currentRunId: string): string[] {
  const ids = new Set(rule.evidenceRunIds ?? []);
  if (currentRunId) ids.add(currentRunId);
  return [...ids];
}

export function deriveCalibrationRules(
  base: CalibrationRules,
  answer: AnswerDiff,
  decisions: CalibrationDecisionInput[],
  idFactory: () => string,
  evidenceRunId = answer.id ?? '',
): DerivedRulesResult {
  const rules: CalibrationRules = {
    ...base,
    codeRenames: { ...base.codeRenames },
    excludeLines: [...(base.excludeLines ?? [])],
    itemCorrections: (base.itemCorrections ?? []).map(rule => ({
      ...rule,
      match: { ...rule.match },
      set: { ...rule.set },
    })),
  };
  const byId = new Map(decisions.map(decision => [decision.itemId, decision]));
  let activatedRules = 0;
  let candidateRules = 0;
  let recordedExamples = 0;

  for (const item of answer.rows) {
    if (item.status === 'match' || !item.id) continue;
    const decision = byId.get(item.id);
    if (!decision) continue;
    recordedExamples++;
    const ours = item.oursSide?.value ?? null;
    const chosen = selectedValue(item, decision);
    if (answerValuesEqual(ours, chosen) || !ours) continue;

    const source = decision.choice === 'custom' ? 'custom' : 'accepted_answer';
    const line = oneUseful(item.oursSide?.lines, new Set(['?', '*']));
    const sub = oneUseful(item.oursSide?.subs, new Set(['']));
    const match: ItemCorrectionRule['match'] = {
      code: ours.code,
      s1: ours.s1,
      s2: ours.s2,
      unit: ours.unit,
      ...(line ? { line } : {}),
      ...(sub ? { sub } : {}),
    };
    const set: ItemCorrectionRule['set'] = {};

    if (!chosen) {
      // Tek örnekten bütün bir kodu yok saymak tehlikelidir. Yalnız hat/alt-tip
      // bağlamı varsa gelecekte INFO kapsamına indiren kesin bir kural üret.
      if (!line && !sub) continue;
      set.scope = 'INFO';
    } else {
      if (normCode(ours.code) !== normCode(chosen.code)) set.code = chosen.code;
      if (ours.s1 !== chosen.s1) set.s1 = chosen.s1;
      if (ours.s2 !== chosen.s2) set.s2 = chosen.s2;
      if (ours.unit !== chosen.unit) set.unit = chosen.unit;
      if (ours.qty > 0 && !answerValuesEqual(ours, chosen)) {
        const factor = round6(chosen.qty / ours.qty);
        if (Number.isFinite(factor) && factor > 0 && Math.abs(factor - 1) > 0.000001) {
          set.qtyFactor = factor;
        }
      }
      if (!Object.keys(set).length) continue;
    }

    const existing = rules.itemCorrections!.find(rule => sameRuleMatch(rule.match, match) && sameRuleSet(rule.set, set));
    if (existing) {
      if (existing.status === 'rejected') continue;
      const wasActive = isCorrectionRuleActive(existing);
      const ids = evidenceIds(existing, evidenceRunId);
      existing.evidenceRunIds = ids;
      existing.evidenceCount = Math.max(existing.evidenceCount, ids.length);
      existing.minEvidence ??= minimumEvidence(existing);
      const hasActiveConflict = rules.itemCorrections!.some(other => other.id !== existing.id
        && sameRuleMatch(other.match, match) && !sameRuleSet(other.set, set) && isCorrectionRuleActive(other));
      existing.status = !hasActiveConflict && existing.evidenceCount >= existing.minEvidence ? 'active' : 'candidate';
      if (!wasActive && existing.status === 'active') {
        activatedRules++;
      } else if (existing.status === 'candidate') {
        candidateRules++;
      }
      continue;
    }
    const candidate: ItemCorrectionRule = {
      id: idFactory(), match, set, source,
      evidenceCount: evidenceRunId ? 1 : 0,
      evidenceRunIds: evidenceRunId ? [evidenceRunId] : [],
      minEvidence: minimumEvidence({ match, set }),
      status: 'candidate',
    };
    const hasActiveConflict = rules.itemCorrections!.some(other => sameRuleMatch(other.match, match)
      && !sameRuleSet(other.set, set) && isCorrectionRuleActive(other));
    if (!hasActiveConflict && candidate.evidenceCount >= candidate.minEvidence!) {
      candidate.status = 'active';
      activatedRules++;
    } else {
      candidateRules++;
    }
    rules.itemCorrections!.push(candidate);
  }

  return { rules, activatedRules, candidateRules, recordedExamples };
}
