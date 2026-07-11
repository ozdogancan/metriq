// Metriq — zod v4 doğrulama şemaları: API gövdeleri tek kaynaktan doğrulanır.
// Teklif-kritik veri: MTO satırları hem PATCH'te hem Excel öncesi aynı şemadan geçer.
import { z } from 'zod';

export const MtoRowSchema = z.object({
  id: z.string().min(1),
  line: z.string(),
  code: z.string(),
  sub: z.string(),
  s1: z.number().finite().positive().nullable(),
  s2: z.number().finite().nonnegative(),
  qty: z.number().finite().nonnegative(),
  unit: z.enum(['M', 'EA']),
  remark: z.string(),
  scope: z.enum(['MAIN', 'INFO']),
  edited: z.boolean().optional(),
});

export const RowsPatchSchema = z.object({
  rows: z.array(MtoRowSchema).max(5000),
});

export const AnswerValueSchema = z.object({
  code: z.string().trim().min(1).max(160),
  s1: z.number().finite().positive().nullable(),
  s2: z.number().finite().nonnegative().max(10_000),
  qty: z.number().finite().positive().max(1_000_000_000),
  unit: z.enum(['M', 'EA']),
});

export const ItemCorrectionRuleSchema = z.object({
  id: z.uuid(),
  match: z.object({
    code: z.string().min(1).max(160),
    s1: z.number().finite().positive().nullable(),
    s2: z.number().finite().nonnegative().max(10_000),
    unit: z.enum(['M', 'EA']),
    line: z.string().min(1).max(240).optional(),
    sub: z.string().min(1).max(240).optional(),
  }),
  set: z.object({
    code: z.string().min(1).max(160).optional(),
    s1: z.number().finite().positive().nullable().optional(),
    s2: z.number().finite().nonnegative().max(10_000).optional(),
    unit: z.enum(['M', 'EA']).optional(),
    scope: z.enum(['MAIN', 'INFO']).optional(),
  }).refine(value => Object.keys(value).length > 0, 'en az bir düzeltme alanı gerekir'),
  source: z.enum(['accepted_answer', 'custom']),
  evidenceCount: z.number().int().positive().max(1_000_000),
});

export const CalibrationRulesSchema = z.object({
  vocab: z.enum(['steel-plant', 'hygienic']),
  merge45Into90: z.boolean(),
  collarOneToOne: z.boolean(),
  excludeCompanionFlanges: z.boolean(),
  includeValvesInMain: z.boolean(),
  includeFasteners: z.boolean(),
  grossPipeFactor: z.number().finite().min(0.5).max(2),
  codeRenames: z.record(z.string().max(160), z.string().max(160)),
  excludeLines: z.array(z.string().min(1)).max(1000).optional(),
  itemCorrections: z.array(ItemCorrectionRuleSchema).max(2000).optional(),
});

export const CalibrationPostSchema = z.object({
  id: z.uuid().optional(),
  expectedVersion: z.number().int().nonnegative().default(0),
  name: z.string().trim().min(1, 'isim boş olamaz').max(120),
  rules: CalibrationRulesSchema,
  learnedFrom: z.array(z.uuid()).max(1000).default([]),
});

const CalibrationDecisionSchema = z.object({
  itemId: z.string().min(1).max(100),
  choice: z.enum(['ours', 'answer', 'custom']),
  custom: AnswerValueSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.choice === 'custom' && !value.custom) {
    ctx.addIssue({ code: 'custom', path: ['custom'], message: 'özel seçim için değer gerekir' });
  }
  if (value.choice !== 'custom' && value.custom) {
    ctx.addIssue({ code: 'custom', path: ['custom'], message: 'özel değer yalnız özel seçimde gönderilebilir' });
  }
});

export const CalibrationApplySchema = z.object({
  comparisonId: z.uuid(),
  idempotencyKey: z.uuid(),
  profileId: z.uuid().nullable().optional(),
  expectedProfileVersion: z.number().int().nonnegative(),
  profileName: z.string().trim().min(1).max(120),
  decisions: z.array(CalibrationDecisionSchema).min(1).max(1000),
}).superRefine((value, ctx) => {
  if (!value.profileId && value.expectedProfileVersion !== 0) {
    ctx.addIssue({ code: 'custom', path: ['expectedProfileVersion'], message: 'yeni profil sürümü 0 olmalı' });
  }
});

// zod hatasını kullanıcıya dönecek kısa Türkçe mesaja indir
export function zodMessage(err: z.ZodError): string {
  const first = err.issues[0];
  if (!first) return 'geçersiz istek gövdesi';
  const path = first.path.length ? first.path.join('.') + ': ' : '';
  return path + first.message;
}
