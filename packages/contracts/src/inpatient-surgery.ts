import { z } from 'zod'
import { commandResponseSchema } from './his.ts'
import { inpatientMaterialReservationSchema } from './inpatient-drg-simulation.ts'

const id = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/)
const version = z.number().int().positive()
const note = z.string().trim().min(1).max(2000)
export const inpatientProcedureCodingSchema = z.object({ system: z.literal('urn:clinmesh:classification:icd-9-cm-3-clinical'),
  version: z.literal('3.0'), code: z.string().min(1), display: z.string().min(1), category: z.enum(['手术','介入治疗','诊断性操作']),
  releaseId: z.literal('clinmesh-surgery-subset-2026-10-20'), sourceUrl: z.url(), sourceSha256: z.string().length(64), sourceLocator: z.string().min(1),
}).strict()
const charge = z.object({ id, priceFen: z.number().int().nonnegative().safe(), unit: z.string().min(1),
  synthetic: z.literal(true), trigger: z.literal('execution') }).strict()
export const inpatientMaterialReferenceSchema = z.object({
  workbookSha256: z.string().regex(/^[a-f0-9]{64}$/), verifiedOn: z.iso.date(), sheet: z.string().min(1), row: z.number().int().positive(),
  category: z.string().min(1), enterprise: z.string().min(1), specification: z.string().min(1).nullable(), unit: z.string().min(1).nullable(),
  priceFen: z.number().int().nonnegative().safe(), baseSupplyPriceFen: z.number().int().nonnegative().safe().nullable(),
  priceType: z.string().min(1), region: z.string().min(1), effectiveFrom: z.iso.date().nullable(), effectiveThrough: z.iso.date().nullable(),
  applicability: z.string().min(1), materialCode: z.string().min(1).nullable(), registrationNumber: z.string().min(1).nullable(),
  sourceId: z.string().min(1), sourceLocator: z.string().min(1),
  original: z.record(z.enum(['类别','产品或支付类别名称','企业（原表口径）','型号或规格','中选价格（元）','原表计价单位','价格类型',
    '来源地区','执行起日','原周期止日','适用性说明','原耗材代码','注册证号','来源编号','原表定位','提取备注','基准品拟供应价（元）']), z.string()),
  source: z.object({ '来源编号': z.string().min(1), '官方发布': z.string().min(1), '价格类型': z.string().min(1), '适用范围': z.string().min(1),
    '执行起日': z.string(), '原协议止日': z.string(), '记录粒度': z.string().min(1), '当前适用性': z.string().min(1),
    '通知地址': z.url(), '原始附件': z.url(), '原件 SHA-256': z.string().regex(/^[a-f0-9]{64}$/), '提取说明': z.string().min(1) }).strict(),
}).strict()
export const inpatientProcedureItemSchema = z.object({ id, version, coding: inpatientProcedureCodingSchema, chargeDefinition: charge }).strict()
export const inpatientMaterialItemSchema = z.object({ id, version, display: z.string().min(1), chargeDefinition: charge,
  reference: inpatientMaterialReferenceSchema.optional() }).strict()
const unavailableMaterial = inpatientMaterialItemSchema.omit({ chargeDefinition: true, reference: true }).extend({
  unavailableReason: z.literal('unit-unconfirmed'), reference: inpatientMaterialReferenceSchema.extend({ unit: z.null() }),
}).strict()
export const inpatientSurgeryCatalogSchema = z.object({ procedures: z.array(inpatientProcedureItemSchema),
  materials: z.array(z.union([inpatientMaterialItemSchema, unavailableMaterial])) }).strict()
export const inpatientSurgeryRequestInputSchema = z.object({ admissionId: id, encounterVersion: z.string().regex(/^\d+$/),
  procedureId: id, catalogVersion: version, plannedFor: z.iso.datetime({ offset: true }), reason: note }).strict()
export const inpatientSurgeryActionInputSchema = z.object({ admissionId: id, requestId: id, expectedRequestVersion: version, note }).strict()
export const inpatientSurgeryExecuteInputSchema = inpatientSurgeryActionInputSchema.omit({ note: true }).extend({ procedureId: id, catalogVersion: version, note,
  materials: z.array(z.object({ materialId: id, catalogVersion: version, quantity: z.number().int().positive().max(1000),
    /** 预留替换：引用本住院预留中的耗材记录，执行时一次性转为实际使用，不重复计费。 */
    reservationId: id.optional() }).strict()).max(20)
    .refine(items => new Set(items.map(item => item.materialId)).size === items.length, '耗材不得重复')
    .refine(items => { const ids = items.map(item => item.reservationId).filter(value => value !== undefined); return new Set(ids).size === ids.length }, '耗材预留不得重复引用'),
})
export const inpatientSurgeryStartInputSchema = inpatientSurgeryActionInputSchema.extend({ procedureId: id, catalogVersion: version }).strict()
export const inpatientSurgeryMaterialSelectionSchema = z.object({ materialId: id, catalogVersion: version,
  quantity: z.number().int().positive().max(1000), reservationId: id.optional(), expectedReservationVersion: version.optional() }).strict()
  .refine(input => input.reservationId === undefined ? input.expectedReservationVersion === undefined : input.expectedReservationVersion !== undefined,
    '引用预留须提供其当前版本')
export const inpatientSurgeryRecordMaterialInputSchema = inpatientSurgeryActionInputSchema.extend({ executionId: id,
  material: inpatientSurgeryMaterialSelectionSchema }).strict()
export const inpatientSurgeryCorrectMaterialInputSchema = inpatientSurgeryActionInputSchema.extend({ executionId: id, materialUseId: id,
  replacement: inpatientSurgeryMaterialSelectionSchema.optional() }).strict()
export const inpatientSurgeryFinalMaterialSchema = z.object({ materialId: id, catalogVersion: version,
  quantity: z.number().int().min(0).max(1000), materialUseIds: z.array(id).max(1000),
  reservationId: id.optional(), expectedReservationVersion: version.optional(),
}).strict().refine(input => input.reservationId === undefined ? input.expectedReservationVersion === undefined : input.expectedReservationVersion !== undefined,
  '引用预留须提供其当前版本')
const reconciliation = {
  finalMaterials: z.array(inpatientSurgeryFinalMaterialSchema).max(100),
  releaseReservations: z.array(z.object({ reservationId: id, expectedReservationVersion: version }).strict()).max(100),
}
export const inpatientSurgeryCompletionReviewInputSchema = inpatientSurgeryActionInputSchema.extend({ executionId: id, ...reconciliation }).strict()
export const inpatientSurgeryCompleteInputSchema = inpatientSurgeryActionInputSchema.extend({ executionId: id,
  reconciliation: z.object({ ...reconciliation, expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
}).strict()
const preparation = z.object({ actorId: z.string().min(1), practitionerRoleId: id, recordedAt: z.iso.datetime({ offset: true }), note }).strict()
export const inpatientSurgeryRequestSchema = z.object({ id, admissionId: id, version, status: z.enum(['requested','ready','completed','cancelled']),
  plannedProcedure: inpatientProcedureItemSchema, plannedFor: z.iso.datetime({ offset: true }), reason: note,
  requestedAt: z.iso.datetime({ offset: true }), requestedBy: z.string().min(1), organizationId: id,
  preopCheck: preparation.optional(), consentConfirmation: preparation.optional(), cancellation: preparation.optional(),
}).strict()
export const inpatientSurgeryMaterialUseSchema = z.object({ id, item: inpatientMaterialItemSchema,
  quantity: z.number().int().positive().max(1000), amountFen: z.number().int().nonnegative().safe() }).strict()
export const inpatientSurgeryMaterialHistorySchema = inpatientSurgeryMaterialUseSchema.extend({
  recordedAt: z.iso.datetime({ offset: true }), recordedBy: z.string().min(1), practitionerRoleId: id, note,
  reservationId: id.nullable(), chargeId: id.nullable().default(null),
  correction: z.object({ id, recordedAt: z.iso.datetime({ offset: true }), recordedBy: z.string().min(1), practitionerRoleId: id,
    note, replacementMaterialUseId: id.nullable(), originalChargeId: id, reversalChargeId: id }).strict().nullable().default(null),
}).strict()
export const inpatientSurgeryExecutionSchema = z.object({ id, admissionId: id, requestId: id, actualProcedure: inpatientProcedureItemSchema,
  performedAt: z.iso.datetime({ offset: true }), performedBy: z.string().min(1), practitionerRoleId: id, organizationId: id, note,
  materials: z.array(inpatientSurgeryMaterialUseSchema), materialHistory: z.array(inpatientSurgeryMaterialHistorySchema).default([]),
  completedAt: z.iso.datetime({ offset: true }).optional(),
}).strict()
export const inpatientSurgerySchema = z.object({ admissionId: id, encounterVersion: z.string().regex(/^\d+$/), virtualTime: z.iso.datetime({ offset: true }),
  requests: z.array(inpatientSurgeryRequestSchema), executions: z.array(inpatientSurgeryExecutionSchema), inProgress: z.array(inpatientSurgeryExecutionSchema).default([]) }).strict()
export const inpatientSurgeryResponseSchema = commandResponseSchema(inpatientSurgerySchema)
export const inpatientSurgeryCompletionPreviewSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  materials: z.array(z.object({ item: inpatientMaterialItemSchema, materialUseIds: z.array(id), reservationId: id.nullable(),
    previousQuantity: z.number().int().nonnegative(), quantity: z.number().int().nonnegative(),
    deltaQuantity: z.number().int(), deltaFen: z.number().int().safe(),
  }).strict()),
  retainedReservations: z.array(inpatientMaterialReservationSchema),
  materialDeltaFen: z.number().int().safe(), procedureAmountFen: z.number().int().nonnegative().safe(), totalDeltaFen: z.number().int().safe(),
}).strict()
