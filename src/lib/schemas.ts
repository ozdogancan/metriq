// Metriq — zod v4 doğrulama şemaları: API gövdeleri tek kaynaktan doğrulanır.
// Teklif-kritik veri: MTO satırları hem PATCH'te hem Excel öncesi aynı şemadan geçer.
import { z } from 'zod';

export const MtoRowSchema = z.object({
  id: z.string().min(1),
  line: z.string(),
  code: z.string(),
  sub: z.string(),
  s1: z.number().finite().nullable(),
  s2: z.number().finite(),
  qty: z.number().finite(),
  unit: z.enum(['M', 'EA']),
  remark: z.string(),
  scope: z.enum(['MAIN', 'INFO']),
  edited: z.boolean().optional(),
});

export const RowsPatchSchema = z.object({
  rows: z.array(MtoRowSchema).max(5000),
});

export const CalibrationRulesSchema = z.object({
  vocab: z.enum(['steel-plant', 'hygienic']),
  merge45Into90: z.boolean(),
  collarOneToOne: z.boolean(),
  excludeCompanionFlanges: z.boolean(),
  includeValvesInMain: z.boolean(),
  includeFasteners: z.boolean(),
  grossPipeFactor: z.number().finite().min(0.5).max(2),
  codeRenames: z.record(z.string(), z.string()),
  excludeLines: z.array(z.string().min(1)).max(1000).optional(),
});

export const CalibrationPostSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, 'isim boş olamaz'),
  rules: CalibrationRulesSchema,
  learnedFrom: z.array(z.string()).default([]),
});

// zod hatasını kullanıcıya dönecek kısa Türkçe mesaja indir
export function zodMessage(err: z.ZodError): string {
  const first = err.issues[0];
  if (!first) return 'geçersiz istek gövdesi';
  const path = first.path.length ? first.path.join('.') + ': ' : '';
  return path + first.message;
}
