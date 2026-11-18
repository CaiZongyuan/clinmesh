import { z } from 'zod'

export const medicationFrequencySchema = z.enum(['QD', 'BID', 'TID', 'QN', 'PRN', 'ONCE'])
export type MedicationFrequency = z.infer<typeof medicationFrequencySchema>

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
