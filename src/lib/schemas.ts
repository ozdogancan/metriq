// Metriq — zod v4 doğrulama şemaları: API gövdeleri tek kaynaktan doğrulanır.
// Teklif-kritik veri: MTO satırları hem PATCH'te hem Excel öncesi aynı şemadan geçer.
import { z } from 'zod';

export const MtoRowSchema = z.object({
  id: z.string().min(1).max(100),
  line: z.string().max(240),
  code: z.string().min(1).max(160),
  sub: z.string().max(240),
  s1: z.number().finite().positive().max(10_000).nullable(),
  s2: z.number().finite().nonnegative().max(10_000),
  qty: z.number().finite().nonnegative().max(1_000_000_000),
  unit: z.enum(['M', 'EA']),
  remark: z.string().max(2000),
  scope: z.enum(['MAIN', 'INFO']),
  edited: z.boolean().optional(),
});

export const RowsPatchSchema = z.object({
  rows: z.array(MtoRowSchema).max(5000),
  expectedRowRevision: z.number().int().nonnegative(),
}).strict();

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
    qtyFactor: z.number().finite().positive().max(100).optional(),
  }).refine(value => Object.keys(value).length > 0, 'en az bir düzeltme alanı gerekir'),
  source: z.enum(['accepted_answer', 'custom']),
  evidenceCount: z.number().int().positive().max(1_000_000),
  status: z.enum(['candidate', 'active', 'rejected']).optional(),
  evidenceRunIds: z.array(z.uuid()).max(1000).optional(),
  minEvidence: z.number().int().positive().max(100).optional(),
});

export const CalibrationRulesSchema = z.object({
  vocab: z.enum(['steel-plant', 'hygienic']),
  merge45Into90: z.boolean(),
  collarOneToOne: z.boolean(),
  excludeCompanionFlanges: z.boolean(),
  includeValvesInMain: z.boolean(),
  includeFasteners: z.boolean(),
  grossPipeFactor: z.number().finite().min(0.5).max(2),
  codeRenames: z.record(z.string().min(1).max(160), z.string().min(1).max(160)),
  excludeLines: z.array(z.string().min(1).max(240)).max(1000).optional(),
  itemCorrections: z.array(ItemCorrectionRuleSchema).max(2000).optional(),
});

export const CalibrationPostSchema = z.object({
  id: z.uuid().optional(),
  expectedVersion: z.number().int().nonnegative().default(0),
  name: z.string().trim().min(1, 'isim boş olamaz').max(120),
  rules: CalibrationRulesSchema,
  learnedFrom: z.array(z.uuid()).max(1000).default([]),
  modelFamily: z.enum(['plant3d-local', 'aps', 'legacy']).default('legacy'),
  clientKey: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).default('default'),
  status: z.enum(['draft', 'active']).default('active'),
});

export const FeedbackRequestSchema = z.object({
  text: z.string().trim().min(5).max(2000),
  scope: z.enum(['file', 'global']),
});

const FeedbackActionSchema = z.object({
  codeRenames: z.array(z.object({
    from: z.string().trim().min(1).max(160),
    to: z.string().trim().min(1).max(160),
  }).strict()).max(200),
  excludeLines: z.array(z.string().trim().min(1).max(240)).max(500),
  itemCorrections: z.array(z.object({
    match: z.object({
      code: z.string().trim().min(1).max(160),
      s1: z.number().finite().positive().nullable(),
      s2: z.number().finite().nonnegative().max(10_000),
      unit: z.enum(['M', 'EA']),
      line: z.string().min(1).max(240).optional(),
      sub: z.string().max(240).optional(),
    }).strict(),
    set: z.object({
      code: z.string().trim().min(1).max(160).optional(),
      s1: z.number().finite().positive().nullable().optional(),
      s2: z.number().finite().nonnegative().max(10_000).optional(),
      unit: z.enum(['M', 'EA']).optional(),
      scope: z.enum(['MAIN', 'INFO']).optional(),
    }).strict().refine(value => Object.keys(value).length > 0, 'en az bir düzeltme alanı gerekir'),
  }).strict()).max(500),
}).strict();

export const FeedbackInterpretationSchema = z.object({
  actions: FeedbackActionSchema,
  unmappable: z.string().max(4000),
  summaryTr: z.string().min(1).max(2000),
  summaryEn: z.string().min(1).max(2000),
}).strict();

const LearningRowPatchSchema = MtoRowSchema.partial().strict()
  .refine(value => Object.keys(value).length > 0, 'öğrenme satırı boş olamaz');
const RowLearningEventInputSchema = z.object({
  kind: z.enum(['row_edit', 'row_add', 'row_delete']),
  before: LearningRowPatchSchema.nullable(),
  after: LearningRowPatchSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.kind === 'row_add' && (!value.after || value.before)) {
    ctx.addIssue({ code: 'custom', message: 'row_add before=null ve after dolu olmalı' });
  }
  if (value.kind === 'row_delete' && (!value.before || value.after)) {
    ctx.addIssue({ code: 'custom', message: 'row_delete before dolu ve after=null olmalı' });
  }
  if (value.kind === 'row_edit' && (!value.before || !value.after)) {
    ctx.addIssue({ code: 'custom', message: 'row_edit before ve after gerektirir' });
  }
  if (value.kind === 'row_edit' && value.before && value.after
    && JSON.stringify(value.before) === JSON.stringify(value.after)) {
    ctx.addIssue({ code: 'custom', message: 'row_edit gerçek bir alan farkı gerektirir' });
  }
});

const CalibrationLearningEventInputSchema = z.object({
  kind: z.literal('calibration_saved'),
  before: CalibrationRulesSchema.nullable(),
  after: CalibrationRulesSchema,
}).strict();

export const LearningEventsRequestSchema = z.object({
  events: z.array(z.union([RowLearningEventInputSchema, CalibrationLearningEventInputSchema])).max(200),
}).strict();

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
  // Kullanıcının onayladığı kapsam kuralları ("vanaları da teklife kat" gibi).
  // Yalnız beyaz listedeki bayraklar; serbest kural enjeksiyonu yok.
  acceptScopeRules: z.array(z.enum(['includeValvesInMain', 'includeFasteners'])).max(4).optional(),
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
