// Operasyonel kurtarma endpoint'i. Normal akış Vercel Workflow tarafından
// tarayıcıdan bağımsız ilerler; bu endpoint aynı idempotent APS adımını elle
// tetiklemek ve teşhis etmek için korunur.
import { NextRequest, NextResponse } from 'next/server';
import { advanceApsRun } from '@/lib/run-processing';
import { langFromCookie } from '@/lib/i18n';
import { isApiDenial, requireApiIdentity } from '@/lib/session';
import { isUuid } from '@/lib/upload-policy';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const identity = await requireApiIdentity();
  if (isApiDenial(identity)) return identity;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: 'geçersiz id' }, { status: 400 });
  const state = await advanceApsRun(identity, id, langFromCookie(req.cookies.get('lang')?.value));
  return NextResponse.json(state);
}
