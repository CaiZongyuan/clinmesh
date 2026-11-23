import { z } from 'zod'

export const medicationFrequencySchema = z.enum(['QD', 'BID', 'TID', 'QN', 'PRN', 'ONCE'])
export type MedicationFrequency = z.infer<typeof medicationFrequencySchema>

export const medicationRouteCodes = ['PO', 'IVGTT', 'IV', 'IM', 'IH', 'SL', 'TOP', 'INH'] as const
export const medicationRouteSchema = z.enum(medicationRouteCodes)
export type MedicationRoute = z.infer<typeof medicationRouteSchema>

/** 有界合成药事规则；剂量单位与目录计价/库存单位分别声明。 */
export const medicationSafetyRuleSchema = z.object({
  maximumDailyQuantity: z.number().positive(),
  pharmacologyClasses: z.array(z.string().min(1)).min(1),
  indicationPrefixes: z.array(z.string().min(1)).min(1),
  doseLimits: z.object({
    unit: z.enum(['mg', 'g', 'mL', 'IU']),
    minimumSingleDose: z.number().positive(),
    maximumSingleDose: z.number().positive(),
    maximumDailyDose: z.number().positive(),
  }).strict(),
}).strict()
export type MedicationSafetyRule = z.infer<typeof medicationSafetyRuleSchema>

export const SYNTHETIC_PACKAGE_INSERT_DISCLAIMER = '合成教学参考，非真实上市产品法定说明书' as const

/** 目录级只读合成药品说明书摘要；不进入处方收费快照或病案归档指纹。 */
export const medicationPackageInsertSchema = z.object({
  genericName: z.string().trim().min(1).max(200),
  specificationAndForm: z.string().trim().min(1).max(300),
  indicationsSummary: z.string().trim().min(1).max(1_000),
  dosageAndAdministration: z.string().trim().min(1).max(1_000),
  contraindications: z.string().trim().min(1).max(1_000),
  precautions: z.string().trim().min(1).max(1_000),
  adverseReactions: z.string().trim().min(1).max(1_000),
  disclaimer: z.literal(SYNTHETIC_PACKAGE_INSERT_DISCLAIMER),
}).strict()
export type MedicationPackageInsert = z.infer<typeof medicationPackageInsertSchema>
