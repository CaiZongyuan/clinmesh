import { z } from 'zod'

export const preparedDatasetSchema = z.enum(['icd10', 'icd9', 'services', 'drugs', 'drg', 'prices', 'assessment'])
export const preparedRecordSchema = z.object({
  dataset: preparedDatasetSchema,
  table: z.string().min(1),
  id: z.string().min(1),
  code: z.string().nullable(),
  name: z.string(),
  sourceVersion: z.string(),
  // 保留来源的全部规范字段、原文、修正和定位；只有显式映射的字段参与计算。
  payload: z.record(z.string(), z.json()),
}).strict()
export const preparedSearchSchema = z.object({
  releaseId: z.string(), total: z.number().int().nonnegative(),
  items: z.array(preparedRecordSchema),
}).strict()
export const preparedSummarySchema = z.object({
  releaseId: z.string(), manifestSha256: z.string(),
  tables: z.array(z.object({ dataset: z.string(), table: z.string(), count: z.number().int() })),
}).strict()
const money = z.number().int().safe().nonnegative()
const signedMoney = z.number().int().safe()
const version = z.string().min(1)
export const simMappingSchema = z.object({
  id: z.string(), name: z.string(), unit: z.string(), specification: z.string(),
  category: z.enum(['drug', 'service']),
  sourceDataset: preparedDatasetSchema, sourceRecordId: z.string(), sourceCode: z.string().nullable(),
  sourceReleaseId: version, mappingVersion: version, priceVersion: version,
  chargePrice: z.string().regex(/^\d+(\.\d{1,6})?$/).nullable(),
  costPrice: z.string().regex(/^\d+(\.\d{1,6})?$/).nullable(),
  validFrom: z.iso.date(), validTo: z.iso.date(), synthetic: z.literal(true),
}).strict()
export const simClinicalSchema = z.object({
  mainDiagnosisId: z.string().min(1),
  secondaryDiagnosisIds: z.array(z.string().min(1)).max(8),
  completedProcedureIds: z.array(z.string().min(1)).max(8),
}).strict()
export const simDraftLineSchema = z.object({
  mappingId: z.string().min(1), quantity: z.number().int().min(1).max(10000),
  dose: z.string().max(100), frequency: z.string().max(100), days: z.number().int().min(1).max(365),
}).strict()
export const simLineSchema = simDraftLineSchema.extend({
  id: z.string(), mapping: simMappingSchema,
  chargeFen: money.nullable(), costFen: money.nullable(),
  chargeState: z.enum(['committed', 'incurred', 'reversed']),
  costState: z.enum(['committed', 'incurred', 'released']),
  withdrawn: z.boolean(),
}).strict()
export const simGroupSchema = z.object({
  code: z.string(), name: z.string(), referenceFen: money,
  reason: z.string(),
}).strict()
export const simAssessmentSchema = z.object({
  group: simGroupSchema.nullable(),
  incurredChargeFen: money, committedChargeFen: money, draftChargeFen: money, reserveChargeFen: money,
  incurredCostFen: money, committedCostFen: money, draftCostFen: money, reserveCostFen: money,
  knownChargeFen: money, knownCostFen: money,
  totalChargeFen: money.nullable(), totalCostFen: money.nullable(),
  chargeProgress: z.number().nonnegative().nullable(), remainingFen: signedMoney.nullable(),
  costBalanceFen: signedMoney.nullable(), costBalanceRatio: z.number().nullable(),
  missing: z.array(z.string()), coverage: z.string(),
}).strict()
export const simHistorySchema = z.object({
  revision: z.number().int(), clinicalRevision: z.number().int(), at: z.iso.datetime(), action: z.string(),
  clinical: simClinicalSchema, assessment: simAssessmentSchema,
  referenceReleaseId: version, mappingVersion: version, ruleVersion: version, paymentVersion: version,
}).strict()
export const simRulesSchema = z.object({
  mainDiagnosisId: z.string(), complicationId: z.string(), completedProcedureId: z.string(),
  basePaymentFen: money.positive(), complicationPaymentFen: money.positive(), procedurePaymentFen: money.positive(),
}).strict()
export const simCaseSchema = z.object({
  id: z.string(), name: z.string(), synthetic: z.literal(true), revision: z.number().int().positive(),
  clinicalRevision: z.number().int().positive(), clinical: simClinicalSchema,
  referenceReleaseId: version, mappingVersion: version, ruleVersion: version, paymentVersion: version,
  simulationDate: z.iso.date(),
  configuration: z.object({ rules: simRulesSchema, mappings: z.array(simMappingSchema) }).strict(),
  lines: z.array(simLineSchema),
  baseChargeFen: money, baseCostFen: money, reserveChargeFen: money, reserveCostFen: money,
  history: z.array(simHistorySchema),
}).strict()
export const simViewSchema = z.object({ case: simCaseSchema, assessment: simAssessmentSchema }).strict()
export const simCatalogSchema = z.object({
  reference: preparedSummarySchema.nullable(), mappings: z.array(simMappingSchema),
  diagnoses: z.array(preparedRecordSchema), procedures: z.array(preparedRecordSchema),
  cases: z.array(z.object({ id: z.string(), name: z.string(), revision: z.number().int() })),
}).strict()
export const simActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('confirm-clinical'), clinical: simClinicalSchema }).strict(),
  z.object({ kind: z.literal('issue'), lines: z.array(simDraftLineSchema).min(1).max(20) }).strict(),
  z.object({ kind: z.enum(['record-charge', 'execute', 'withdraw', 'reverse']), lineId: z.string().min(1) }).strict(),
])
export const simCommandSchema = z.object({ expectedRevision: z.number().int().positive(), action: simActionSchema }).strict()
export const simPreviewSchema = z.object({
  expectedRevision: z.number().int().positive(),
  lines: z.array(simDraftLineSchema).max(20), clinical: simClinicalSchema.optional(),
}).strict()
export type PreparedRecord = z.infer<typeof preparedRecordSchema>
export type SimMapping = z.infer<typeof simMappingSchema>
export type SimClinical = z.infer<typeof simClinicalSchema>
export type SimDraftLine = z.infer<typeof simDraftLineSchema>
export type SimLine = z.infer<typeof simLineSchema>
export type SimCase = z.infer<typeof simCaseSchema>
export type SimAssessment = z.infer<typeof simAssessmentSchema>
export type SimAction = z.infer<typeof simActionSchema>
export type SimRules = z.infer<typeof simRulesSchema>
