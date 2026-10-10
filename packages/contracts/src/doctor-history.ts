import { z } from 'zod'
import { doctorCompletedCaseDetailSchema } from './his.ts'

export const doctorHistorySourceSchema = z.enum(['local-completed', 'visible-source'])
export const doctorCaseHistoryInputSchema = z.object({
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(20).default(10),
  source: doctorHistorySourceSchema,
}).strict()
export const doctorCaseHistoryDetailInputSchema = z.object({
  entryId: z.string().trim().min(1).max(512),
  source: doctorHistorySourceSchema,
}).strict()

export const doctorCaseHistoryItemSchema = z.object({
  clinicalDate: z.iso.datetime({ offset: true }),
  entryId: z.string().min(1).max(512),
  resourceType: z.string().min(1).max(128),
  source: doctorHistorySourceSchema,
  title: z.string().min(1).max(500),
}).strict()

export const doctorCaseHistorySchema = z.object({
  availability: z.enum(['available', 'no-data', 'no-materialization']),
  coverage: z.enum(['current-patient-responsible-doctor', 'materialized-visible-history']),
  items: z.array(doctorCaseHistoryItemSchema).max(20),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive().max(20),
  source: doctorHistorySourceSchema,
  total: z.number().int().nonnegative(),
}).strict()

export const doctorCompletedHistoryDetailSchema = z.object({
  entryId: z.string().min(1).max(512),
  record: doctorCompletedCaseDetailSchema,
  source: z.literal('local-completed'),
}).strict()

const conceptSchema = z.object({
  coding: z.array(z.object({
    code: z.string().optional(), display: z.string().optional(), system: z.string().optional(),
  })).optional(),
  text: z.string().optional(),
})
const quantitySchema = z.object({
  code: z.string().optional(), comparator: z.string().optional(), unit: z.string().optional(),
  value: z.number().finite().optional(),
})
const periodSchema = z.object({ start: z.string().optional(), end: z.string().optional() })
const rangeSchema = z.object({ low: quantitySchema.optional(), high: quantitySchema.optional(), text: z.string().optional() })
const observationFields = {
  code: conceptSchema.optional(), dataAbsentReason: conceptSchema.optional(),
  interpretation: z.array(conceptSchema).optional(), referenceRange: z.array(rangeSchema).optional(),
  valueBoolean: z.boolean().optional(), valueCodeableConcept: conceptSchema.optional(),
  valueDateTime: z.string().optional(), valueInteger: z.number().int().optional(),
  valuePeriod: periodSchema.optional(), valueQuantity: quantitySchema.optional(), valueRange: rangeSchema.optional(),
  valueRatio: z.object({ numerator: quantitySchema.optional(), denominator: quantitySchema.optional() }).optional(),
  valueString: z.string().optional(), valueTime: z.string().optional(),
}

/** 临床可见字段白名单；Zod 在每层移除原文、附件、扩展、URL 和对象关联。 */
export const visibleSourceClinicalSchema = z.object({
  ...observationFields,
  abatementDateTime: z.string().optional(), abatementPeriod: periodSchema.optional(),
  authoredOn: z.string().optional(), bodySite: z.union([conceptSchema, z.array(conceptSchema)]).optional(),
  class: z.object({ code: z.string().optional(), display: z.string().optional() }).optional(),
  clinicalStatus: conceptSchema.optional(), component: z.array(z.object(observationFields)).optional(),
  conclusion: z.string().optional(), effectiveDateTime: z.string().optional(), effectivePeriod: periodSchema.optional(),
  issued: z.string().optional(), medicationCodeableConcept: conceptSchema.optional(),
  medicationReference: z.object({ display: z.string().optional() }).optional(),
  note: z.array(z.object({ text: z.string().optional() })).optional(),
  occurrenceDateTime: z.string().optional(), occurrenceString: z.string().optional(),
  onsetDateTime: z.string().optional(), onsetPeriod: periodSchema.optional(),
  performedDateTime: z.string().optional(), performedPeriod: periodSchema.optional(), period: periodSchema.optional(),
  reasonCode: z.array(conceptSchema).optional(), recordedDate: z.string().optional(),
  severity: conceptSchema.optional(), status: z.string().optional(), title: z.string().optional(),
  type: z.array(conceptSchema).optional(), vaccineCode: conceptSchema.optional(), verificationStatus: conceptSchema.optional(),
  dosageInstruction: z.array(z.object({
    asNeededBoolean: z.boolean().optional(), asNeededCodeableConcept: conceptSchema.optional(),
    doseAndRate: z.array(z.object({
      doseQuantity: quantitySchema.optional(), doseRange: rangeSchema.optional(),
      rateQuantity: quantitySchema.optional(), rateRange: rangeSchema.optional(),
    })).optional(),
    method: conceptSchema.optional(), route: conceptSchema.optional(), text: z.string().optional(),
    timing: z.object({
      code: conceptSchema.optional(), repeat: z.object({
        frequency: z.number().optional(), frequencyMax: z.number().optional(),
        period: z.number().optional(), periodMax: z.number().optional(), periodUnit: z.string().optional(),
      }).optional(),
    }).optional(),
  })).optional(),
})

export const doctorVisibleHistoryDetailSchema = doctorCaseHistoryItemSchema.extend({
  clinical: visibleSourceClinicalSchema,
  missingFieldMeaning: z.literal('not-recorded'),
  source: z.literal('visible-source'),
}).strict()

export const doctorCaseHistoryDetailSchema = z.discriminatedUnion('source', [
  doctorCompletedHistoryDetailSchema, doctorVisibleHistoryDetailSchema,
])

export type DoctorCaseHistoryInput = z.infer<typeof doctorCaseHistoryInputSchema>
export type DoctorCaseHistoryDetailInput = z.infer<typeof doctorCaseHistoryDetailInputSchema>
export type DoctorCaseHistory = z.infer<typeof doctorCaseHistorySchema>
export type DoctorCaseHistoryDetail = z.infer<typeof doctorCaseHistoryDetailSchema>
