import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { listRuns, saveRun, saveRows, saveSteel, storeFile, fetchStoredFile, listCalibrations } from '@/lib/store';
import { parseNwd } from '@/lib/parser/nwd';
import { applyRules } from '@/lib/vocab';
import { DEFAULT_RULES, type Run, type VocabProfileId } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET() {
  return NextResponse.json(await listRuns());
}

export async function POST(req: NextRequest) {
  try {
    let buf: Buffer;
    let meta: { projectName: string; vocab: VocabProfileId; calibrationId: string | null; fileName: string };
    let runId = randomUUID();
    let fileSize = 0;

    const ctype = req.headers.get('content-type') || '';
    if (ctype.includes('multipart/form-data')) {
      const fd = await req.formData();
      const file = fd.get('file') as File | null;
      if (!file) return NextResponse.json({ error: 'file missing' }, { status: 400 });
      meta = JSON.parse(String(fd.get('meta') || '{}'));
      buf = Buffer.from(await file.arrayBuffer());
      fileSize = buf.length;
      await storeFile(runId, meta.fileName || file.name, buf);
    } else {
      const body = await req.json();
      meta = body;
      runId = body.runId || runId;
      fileSize = body.fileSize || 0;
      buf = await fetchStoredFile(body.storagePath);
      fileSize = fileSize || buf.length;
    }

    // kurallar: kalibrasyon > profil varsayılanı
    let rules = DEFAULT_RULES[meta.vocab] ?? DEFAULT_RULES['steel-plant'];
    if (meta.calibrationId) {
      const cal = (await listCalibrations()).find(c => c.id === meta.calibrationId);
      if (cal) rules = cal.rules;
    }

    const parsed = parseNwd(buf);
    const { rows, steel, totals } = applyRules(parsed, rules);

    const run: Run = {
      id: runId,
      projectName: meta.projectName || meta.fileName,
      fileName: meta.fileName,
      fileSize,
      vocab: rules.vocab,
      calibrationId: meta.calibrationId,
      status: 'done',
      totals,
      fasteners: parsed.fasteners,
      createdAt: new Date().toISOString(),
    };
    await saveRun(run);
    await saveRows(runId, rows);
    await saveSteel(runId, steel);

    return NextResponse.json({ id: runId, totals });
  } catch (e) {
    console.error('run create failed', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'parse failed' }, { status: 500 });
  }
}
