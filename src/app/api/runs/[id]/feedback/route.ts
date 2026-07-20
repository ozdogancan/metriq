// Metriq — sonuç geri bildirimi → öğrenme döngüsü.
// Serbest metin, Claude ile MEVCUT kural sözlüğüne çevrilir (rakam uydurma yok);
// kapsam seçimine göre yalnız bu dosyaya uygulanır ya da profile de işlenir
// (sonraki dosyalar otomatik faydalanır). Satırlar güncellenir, karne/analizler
// bayatlatılır (saveRows revision+1), her şey learning_events'e loglanır.
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import {
  getRun, getRows, getSteel, saveRows, updateRunMeta, addLearningEvents,
  listCalibrations, saveCalibration,
} from '@/lib/store';
import { interpretFeedback, aiEnabled, type FeedbackActions } from '@/lib/ai';
import { computeTotals } from '@/lib/vocab';
import { DEFAULT_RULES, type Calibration, type MtoRow } from '@/lib/types';
import { requireApiSession, getSessionUser } from '@/lib/session';
import { isUuid } from '@/lib/upload-policy';

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

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireApiSession();
  if (denied) return denied;
  const actor = (await getSessionUser())!;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: 'geçersiz id' }, { status: 400 });
  const run = await getRun(id);
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (run.status !== 'done') {
    return NextResponse.json({ error: 'Geri bildirim için metrajın tamamlanmış olması gerekir.' }, { status: 409 });
  }
  if (!aiEnabled) return NextResponse.json({ error: 'AI yapılandırılmamış — geri bildirim yorumlanamıyor.' }, { status: 503 });

  const body = await req.json().catch(() => null) as { text?: unknown; scope?: unknown } | null;
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  const scope = body?.scope === 'global' ? 'global' as const : body?.scope === 'file' ? 'file' as const : null;
  if (text.length < 5 || text.length > 2000 || !scope) {
    return NextResponse.json({ error: 'Geri bildirim 5-2000 karakter olmalı ve kapsam seçilmeli.' }, { status: 400 });
  }

  try {
    const rows = await getRows(id);
    const interp = await interpretFeedback({ text, rows, vocab: run.vocab });
    if (!interp) return NextResponse.json({ error: 'Geri bildirim yorumlanamadı — tekrar dene.' }, { status: 502 });

    const a = interp.actions;
    const actionable = a.codeRenames.length + a.excludeLines.length + a.itemCorrections.length > 0;
    if (!actionable) {
      // dürüstlük: uygulanabilir kural çıkmadıysa hiçbir şey değiştirme, nedenini söyle
      return NextResponse.json({ applied: false, unmappable: interp.unmappable, summaryTr: interp.summaryTr, summaryEn: interp.summaryEn });
    }

    const { rows: newRows, changed } = applyFeedbackActions(rows, a);
    const steel = await getSteel(id);
    const totals = computeTotals(newRows, steel);
    await saveRows(id, newRows); // revision+1, bayat cevap karşılaştırması temizlenir
    await updateRunMeta(id, { totals, answer: null });

    // kapsam=global: kuralları profile işle — sonraki dosyalar otomatik öğrensin
    let profileNote: string | null = null;
    if (scope === 'global') {
      const cals = await listCalibrations();
      const target = cals.find(c => c.id === run.calibrationId)
        ?? cals.filter(c => c.rules.vocab === run.vocab).sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))[0]
        ?? null;
      const cal: Calibration = target ?? {
        id: randomUUID(),
        name: `Geri bildirim — ${new Date().toISOString().slice(0, 10)}`,
        rules: { ...DEFAULT_RULES[run.vocab] ?? DEFAULT_RULES['steel-plant'], codeRenames: {}, excludeLines: [], itemCorrections: [] },
        learnedFrom: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      const rules = { ...cal.rules, codeRenames: { ...cal.rules.codeRenames } };
      for (const r of a.codeRenames) rules.codeRenames[r.from.toUpperCase()] = r.to.toUpperCase();
      rules.excludeLines = [...new Set([...(rules.excludeLines ?? []), ...a.excludeLines])];
      rules.itemCorrections = [
        ...(rules.itemCorrections ?? []),
        ...a.itemCorrections.map(c => ({
          id: randomUUID(),
          match: { code: c.match.code.toUpperCase(), s1: c.match.s1, s2: c.match.s2, unit: c.match.unit, ...(c.match.line ? { line: c.match.line } : {}), ...(c.match.sub ? { sub: c.match.sub } : {}) },
          set: c.set,
          source: 'custom' as const,
          evidenceCount: 1,
        })),
      ];
      const saved = await saveCalibration(
        { ...cal, rules, learnedFrom: [...new Set([...cal.learnedFrom, id])] },
        target?.version ?? 0,
        actor,
      );
      profileNote = `${saved.name} v${saved.version ?? 1}`;
      if (run.calibrationId !== saved.id) await updateRunMeta(id, { calibrationId: saved.id });
    }

    await addLearningEvents([{
      id: randomUUID(), runId: id, ts: new Date().toISOString(), kind: 'run_feedback',
      before: null,
      after: { feedback: text, scope, actions: a as unknown as Record<string, unknown>, changedRows: changed },
      context: { vocab: run.vocab, fileName: run.fileName, calibrationId: run.calibrationId },
    }]).catch(e => console.error('feedback learning event yazılamadı (fail-soft)', e));

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
    const msg = e instanceof Error && /CONFLICT|STALE/.test(e.message)
      ? 'Profil bu sırada değişti — sayfayı yenileyip tekrar dene.'
      : 'Geri bildirim uygulanamadı.';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
