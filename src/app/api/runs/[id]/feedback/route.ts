// Metriq — sonuç geri bildirimi → öğrenme döngüsü.
// Serbest metin, Claude ile MEVCUT kural sözlüğüne çevrilir (rakam uydurma yok);
// kapsam seçimine göre yalnız bu dosyaya uygulanır ya da profile de işlenir
// (sonraki dosyalar otomatik faydalanır). Satırlar güncellenir, karne/analizler
// bayatlatılır (saveRows revision+1), her şey learning_events'e loglanır.
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import {
  applyRunFeedback, findLatestCalibration, getCalibration, getRun, getRows, getSteel,
} from '@/lib/store';
import { interpretFeedback, aiEnabled, type FeedbackActions } from '@/lib/ai';
import { computeTotals } from '@/lib/vocab';
import { DEFAULT_RULES, type Calibration, type CalibrationRules, type ItemCorrectionRule, type MtoRow } from '@/lib/types';
import { isApiDenial, requireApiIdentity } from '@/lib/session';
import { isUuid } from '@/lib/upload-policy';
import { FeedbackRequestSchema, zodMessage } from '@/lib/schemas';
import { hashMtoRows } from '@/lib/answer-compare';

export const runtime = 'nodejs';
export const maxDuration = 120;

// Yorumlanan eylemleri satırlara uygula (yalnız kural sözlüğü — miktar dokunulmaz)
function applyFeedbackActions(rows: MtoRow[], actions: FeedbackActions): { rows: MtoRow[]; changed: number } {
  const renames = new Map(actions.codeRenames.map(r => [r.from.trim().toUpperCase(), r.to.trim().toUpperCase()]));
  const excl = new Set(actions.excludeLines);
  let changed = 0;
  const out = rows.map(r => {
    let next = r;
    const renamed = renames.get(next.code.toUpperCase());
    if (renamed && renamed !== next.code) {
      next = { ...next, code: renamed, edited: true };
    }
    if (excl.has(next.line) && next.scope === 'MAIN') {
      next = {
        ...next, scope: 'INFO', edited: true,
        remark: [next.remark, 'kapsam dışı (geri bildirim)'].filter(Boolean).join('; '),
      };
    }
    for (const c of actions.itemCorrections) {
      const m = c.match;
      if (m.code.toUpperCase() !== next.code.toUpperCase() || m.s1 !== next.s1
        || m.s2 !== next.s2 || m.unit !== next.unit
        || (m.line !== undefined && m.line !== next.line)
        || (m.sub !== undefined && m.sub !== next.sub)) continue;
      next = {
        ...next,
        ...(c.set.code !== undefined ? { code: c.set.code.toUpperCase() } : {}),
        ...(Object.prototype.hasOwnProperty.call(c.set, 's1') ? { s1: c.set.s1 ?? null } : {}),
        ...(c.set.s2 !== undefined ? { s2: c.set.s2 } : {}),
        ...(c.set.unit !== undefined ? { unit: c.set.unit } : {}),
        ...(c.set.scope !== undefined ? { scope: c.set.scope } : {}),
        edited: true,
      };
    }
    if (next !== r) changed++;
    return next;
  });
  return { rows: out, changed };
}

function norm(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, ' ');
}

function actionsBelongToRows(rows: MtoRow[], actions: FeedbackActions): boolean {
  const codes = new Set(rows.map(row => norm(row.code)));
  const lines = new Set(rows.map(row => row.line));
  if (actions.codeRenames.some(rename => !codes.has(norm(rename.from)) || norm(rename.from) === norm(rename.to))) return false;
  if (actions.excludeLines.some(line => !lines.has(line)
    || !rows.some(row => row.line === line && row.scope === 'MAIN'))) return false;
  return actions.itemCorrections.every(correction => rows.some(row => {
    const match = correction.match;
    const matches = norm(row.code) === norm(match.code) && row.s1 === match.s1
      && row.s2 === match.s2 && row.unit === match.unit
      && (match.line === undefined || row.line === match.line)
      && (match.sub === undefined || row.sub === match.sub);
    if (!matches) return false;
    const set = correction.set;
    return (set.code !== undefined && norm(set.code) !== norm(row.code))
      || (Object.prototype.hasOwnProperty.call(set, 's1') && set.s1 !== row.s1)
      || (set.s2 !== undefined && set.s2 !== row.s2)
      || (set.unit !== undefined && set.unit !== row.unit)
      || (set.scope !== undefined && set.scope !== row.scope);
  }));
}

function ruleKey(rule: Pick<ItemCorrectionRule, 'match' | 'set'>): string {
  return JSON.stringify({
    match: { ...rule.match, code: norm(rule.match.code) },
    set: rule.set,
  });
}

function candidateRulesFromFeedback(rows: MtoRow[], actions: FeedbackActions): Array<Pick<ItemCorrectionRule, 'match' | 'set'>> {
  const result: Array<Pick<ItemCorrectionRule, 'match' | 'set'>> = actions.itemCorrections.map(correction => ({
    match: {
      ...correction.match,
      code: norm(correction.match.code),
      ...(correction.match.line ? { line: correction.match.line } : {}),
      ...(correction.match.sub ? { sub: correction.match.sub } : {}),
    },
    set: { ...correction.set, ...(correction.set.code ? { code: norm(correction.set.code) } : {}) },
  }));
  for (const rename of actions.codeRenames) {
    for (const row of rows.filter(value => norm(value.code) === norm(rename.from))) {
      result.push({
        match: { code: norm(row.code), s1: row.s1, s2: row.s2, unit: row.unit, line: row.line, ...(row.sub ? { sub: row.sub } : {}) },
        set: { code: norm(rename.to) },
      });
    }
  }
  for (const line of actions.excludeLines) {
    for (const row of rows.filter(value => value.line === line && value.scope === 'MAIN')) {
      result.push({
        match: { code: norm(row.code), s1: row.s1, s2: row.s2, unit: row.unit, line, ...(row.sub ? { sub: row.sub } : {}) },
        set: { scope: 'INFO' },
      });
    }
  }
  return [...new Map(result.map(rule => [ruleKey(rule), rule])).values()];
}

function mergeFeedbackCandidates(
  base: CalibrationRules,
  rows: MtoRow[],
  actions: FeedbackActions,
  runId: string,
): CalibrationRules {
  const itemCorrections = (base.itemCorrections ?? []).map(rule => ({
    ...rule, match: { ...rule.match }, set: { ...rule.set },
    evidenceRunIds: [...(rule.evidenceRunIds ?? [])],
  }));
  for (const candidate of candidateRulesFromFeedback(rows, actions)) {
    const key = ruleKey(candidate);
    const existing = itemCorrections.find(rule => ruleKey(rule) === key);
    if (existing) {
      if (existing.status === 'rejected') continue;
      const evidence = new Set(existing.evidenceRunIds ?? []);
      evidence.add(runId);
      existing.evidenceRunIds = [...evidence];
      existing.evidenceCount = Math.max(existing.evidenceCount, evidence.size);
      existing.minEvidence = Math.max(existing.minEvidence ?? 2, 2);
      const conflict = itemCorrections.some(rule => rule.id !== existing.id
        && JSON.stringify({ ...rule.match, code: norm(rule.match.code) })
          === JSON.stringify({ ...existing.match, code: norm(existing.match.code) })
        && ruleKey(rule) !== key && (rule.status === undefined || rule.status === 'active'));
      existing.status = !conflict && evidence.size >= existing.minEvidence ? 'active' : 'candidate';
      continue;
    }
    itemCorrections.push({
      id: randomUUID(), match: candidate.match, set: candidate.set, source: 'custom',
      evidenceCount: 1, evidenceRunIds: [runId], minEvidence: 2, status: 'candidate',
    });
  }
  // Serbest metin tek başına geniş codeRenames/excludeLines listelerine yazılmaz.
  // Yalnız tam imzalı aday kurallar kanıt biriktirir.
  return {
    ...base,
    codeRenames: { ...base.codeRenames },
    excludeLines: [...(base.excludeLines ?? [])],
    itemCorrections,
  };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const identity = await requireApiIdentity();
  if (isApiDenial(identity)) return identity;
  const actor = identity.email;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: 'geçersiz id' }, { status: 400 });
  const run = await getRun(identity, id);
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (run.status !== 'done') {
    return NextResponse.json({ error: 'Geri bildirim için metrajın tamamlanmış olması gerekir.' }, { status: 409 });
  }
  if (!aiEnabled) return NextResponse.json({ error: 'AI yapılandırılmamış — geri bildirim yorumlanamıyor.' }, { status: 503 });

  const parsedBody = FeedbackRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsedBody.success) {
    return NextResponse.json({ error: `Geçersiz geri bildirim — ${zodMessage(parsedBody.error)}` }, { status: 400 });
  }
  const { text, scope } = parsedBody.data;

  try {
    const rows = await getRows(identity, id);
    const interp = await interpretFeedback({ text, rows, vocab: run.vocab });
    if (!interp) return NextResponse.json({ error: 'Geri bildirim yorumlanamadı — tekrar dene.' }, { status: 502 });

    const a = interp.actions;
    if (!actionsBelongToRows(rows, a)) {
      return NextResponse.json({ error: 'AI çıktısı bu metrajın satırlarıyla doğrulanamadı; hiçbir değişiklik uygulanmadı.' }, { status: 502 });
    }
    const actionable = a.codeRenames.length + a.excludeLines.length + a.itemCorrections.length > 0;
    if (!actionable) {
      // dürüstlük: uygulanabilir kural çıkmadıysa hiçbir şey değiştirme, nedenini söyle
      return NextResponse.json({ applied: false, unmappable: interp.unmappable, summaryTr: interp.summaryTr, summaryEn: interp.summaryEn });
    }

    const { rows: newRows, changed } = applyFeedbackActions(rows, a);
    if (changed === 0) {
      return NextResponse.json({
        applied: false,
        unmappable: interp.unmappable || 'İstenen değişiklik mevcut satırlarda bir fark üretmedi.',
        summaryTr: interp.summaryTr,
        summaryEn: interp.summaryEn,
      });
    }
    const steel = await getSteel(identity, id);
    const totals = computeTotals(newRows, steel);

    const modelFamily = run.analysis?.family && run.analysis.family !== 'plant3d-local'
      ? 'aps' as const : 'plant3d-local' as const;
    const clientKey = 'default';
    let calibrationInput: Parameters<typeof applyRunFeedback>[1]['calibration'];
    if (scope === 'global') {
      const selected = run.calibrationId ? await getCalibration(identity, run.calibrationId) : null;
      const selectedInScope = selected?.status !== 'archived'
        && (selected?.modelFamily === modelFamily || selected?.modelFamily === 'legacy')
        && selected?.clientKey === clientKey ? selected : null;
      const target = selectedInScope ?? await findLatestCalibration(identity, {
        vocab: run.vocab, modelFamily, clientKey,
      });
      const now = new Date().toISOString();
      const cal: Calibration & {
        modelFamily: 'plant3d-local' | 'aps' | 'legacy'; clientKey: string;
        status: 'draft' | 'active';
      } = target ? { ...target, status: target.status === 'draft' ? 'draft' : 'active' } : {
        id: randomUUID(),
        name: `Geri bildirim — ${now.slice(0, 10)}`,
        rules: { ...DEFAULT_RULES[run.vocab], codeRenames: {}, excludeLines: [], itemCorrections: [] },
        learnedFrom: [], createdAt: now, updatedAt: now,
        modelFamily, clientKey, status: 'active',
      };
      calibrationInput = {
        value: {
          ...cal,
          rules: mergeFeedbackCandidates(cal.rules, rows, a, id),
          learnedFrom: [...new Set([...cal.learnedFrom, id])],
          modelFamily: target?.modelFamily ?? modelFamily,
          clientKey: target?.clientKey ?? clientKey,
          status: target?.status === 'draft' ? 'draft' : 'active',
        },
        expectedVersion: target?.version ?? 0,
      };
    }

    const event = {
      id: randomUUID(), runId: id, ts: new Date().toISOString(), kind: 'run_feedback',
      before: null,
      after: { feedback: text, scope, actions: a as unknown as Record<string, unknown>, changedRows: changed },
      context: { vocab: run.vocab, fileName: run.fileName, calibrationId: calibrationInput?.value.id ?? run.calibrationId },
    } as const;
    const applied = await applyRunFeedback(identity, {
      runId: id,
      expectedRowRevision: run.rowRevision ?? 0,
      expectedRowsHash: hashMtoRows(rows),
      rows: newRows,
      rowsAfterHash: hashMtoRows(newRows),
      totals,
      actor,
      events: [event],
      calibration: calibrationInput,
    });
    const profileNote = calibrationInput
      ? `${calibrationInput.value.name} v${applied.calibrationVersion ?? 1}`
      : null;

    return NextResponse.json({
      applied: true,
      changes: {
        renamed: a.codeRenames.length,
        excludedLines: a.excludeLines.length,
        corrections: a.itemCorrections.length,
        changedRows: changed,
      },
      unmappable: interp.unmappable,
      summaryTr: interp.summaryTr,
      summaryEn: interp.summaryEn,
      profile: profileNote,
      totals,
    });
  } catch (e) {
    console.error('feedback apply failed', e);
    const conflict = (e as { code?: string }).code === 'PT409'
      || (e instanceof Error && /CONFLICT|STALE/.test(e.message));
    const msg = conflict
      ? 'Profil bu sırada değişti — sayfayı yenileyip tekrar dene.'
      : 'Geri bildirim uygulanamadı.';
    return NextResponse.json({ error: msg }, { status: conflict ? 409 : 500 });
  }
}
