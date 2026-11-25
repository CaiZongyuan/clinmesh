import { z } from 'zod'
import { clinicalOverrideInputSchema } from './clinical-quality.ts'
import { commandResponseSchema } from './his.ts'
import { inpatientMaterialReservationSchema } from './inpatient-drg-simulation.ts'
import {
  medicationPackageInsertSchema,
  medicationRouteSchema,
  medicationSafetyRuleSchema,
} from './medication-safety.ts'

const id = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/)
const version = z.number().int().positive()
const note = z.string().trim().min(1).max(2000)
const optionalNote = z.string().trim().max(2000).optional()

export const surgeryTypes = ['elective', 'semi-elective', 'emergency', 'day-surgery'] as const
export const surgeryTypeSchema = z.enum(surgeryTypes)
export type SurgeryType = z.infer<typeof surgeryTypeSchema>

export const anesthesiaMethods = ['local-infiltration', 'local-sedation', 'general', 'neuraxial', 'nerve-block'] as const
export const anesthesiaMethodSchema = z.enum(anesthesiaMethods)
export type AnesthesiaMethod = z.infer<typeof anesthesiaMethodSchema>

export const preopOrderPolicies = ['continue-active', 'stop-on-completion'] as const
export const preopOrderPolicySchema = z.enum(preopOrderPolicies)
export type PreopOrderPolicy = z.infer<typeof preopOrderPolicySchema>

export const surgeryLocationIds = [
  'location-catheterization-lab',
  'location-operating-center',
  'location-endoscopy-suite',
  'location-outpatient-or',
] as const
export const surgeryLocationIdSchema = z.enum(surgeryLocationIds)
export type SurgeryLocationId = z.infer<typeof surgeryLocationIdSchema>

export const inpatientSurgeryLocationSchema = z.object({
  id: surgeryLocationIdSchema,
  name: z.string().min(1),
  nameEn: z.string().min(1),
}).strict()
export type InpatientSurgeryLocation = z.infer<typeof inpatientSurgeryLocationSchema>

export const inpatientSurgeryPractitionerSchema = z.object({
  id,
  name: z.string().min(1),
  title: z.string().min(1).optional(),
}).strict()
export type InpatientSurgeryPractitioner = z.infer<typeof inpatientSurgeryPractitionerSchema>

export const surgeryExecutionStages = ['primary', 'ad-hoc-pci'] as const
export const surgeryExecutionStageSchema = z.enum(surgeryExecutionStages)
export type SurgeryExecutionStage = z.infer<typeof surgeryExecutionStageSchema>

export const surgicalConsentTemplateIds = [
  'coronary-angiography',
  'coronary-angiography-ad-hoc-pci',
  'coronary-des-pci',
  'coronary-balloon-pci',
  'general-surgery',
] as const
export const surgicalConsentTemplateIdSchema = z.enum(surgicalConsentTemplateIds)
export type SurgicalConsentTemplateId = z.infer<typeof surgicalConsentTemplateIdSchema>

export const surgicalConsentSignerRoles = ['patient', 'family-proxy'] as const
export const surgicalConsentSignerRoleSchema = z.enum(surgicalConsentSignerRoles)
export type SurgicalConsentSignerRole = z.infer<typeof surgicalConsentSignerRoleSchema>

export const SURGICAL_CONSENT_DISCLAIMER = '合成临床教学文书模板，仅供仿真演练使用，非真实医疗法律文书' as const

export const inpatientSurgicalConsentDocumentSchema = z.object({
  templateId: surgicalConsentTemplateIdSchema,
  templateVersion: z.literal('2026-11-23.r1'),
  title: z.string().min(1),
  disclaimer: z.literal(SURGICAL_CONSENT_DISCLAIMER),
  patient: z.object({
    name: z.string().min(1),
    gender: z.enum(['female', 'male', 'other', 'unknown']),
    birthDate: z.iso.date().nullable(),
    inpatientNumber: z.string().min(1),
  }).strict(),
  primaryDiagnosis: z.object({
    code: z.string().min(1),
    display: z.string().min(1),
  }).strict().nullable(),
  surgeryNotice: z.object({
    surgeryType: surgeryTypeSchema.nullable(),
    procedureCode: z.string().min(1),
    procedureDisplay: z.string().min(1),
    plannedFor: z.iso.datetime({ offset: true }),
    locationName: z.string().min(1).nullable(),
    anesthesiaMethod: anesthesiaMethodSchema.nullable(),
    surgeonName: z.string().min(1).nullable(),
    assistantName: z.string().min(1).nullable(),
    standbyAdHocPci: z.boolean().optional(),
  }).strict(),
  purposeAndMethod: z.string().min(1),
  commonRisks: z.array(z.string().min(1)).min(3),
  individualizedRisks: z.string().trim().max(2000).nullable(),
  alternativePlans: z.string().min(1),
  patientChoiceStatement: z.string().min(1),
  signature: z.object({
    signerRole: surgicalConsentSignerRoleSchema,
    signerName: z.string().trim().min(1).max(80),
    signerRelationship: z.string().trim().min(1).max(40).nullable(),
    patientChoice: z.literal('agree'),
    talkingDoctorId: id,
    talkingDoctorName: z.string().min(1),
    signedAt: z.iso.datetime({ offset: true }),
  }).strict(),
  renderedText: z.string().min(1),
}).strict()
export type InpatientSurgicalConsentDocument = z.infer<typeof inpatientSurgicalConsentDocumentSchema>

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

export const inpatientBaseStockMedicationSchema = z.object({
  id,
  version,
  code: z.string().min(1),
  display: z.string().min(1),
  unit: z.string().min(1),
  priceFen: z.number().int().positive().safe(),
  strength: z.string().min(1),
  packageDescription: z.string().min(1),
  defaultRouteCode: medicationRouteSchema,
  allowedRouteCodes: z.array(medicationRouteSchema).min(1),
  doses: z.array(z.object({
    doseText: z.string().trim().min(1).max(120),
    quantity: z.number().int().positive().max(1000),
  }).strict()),
  doseBasis: z.object({
    amount: z.number().positive(),
    unit: z.string().trim().min(1),
  }).strict().optional(),
  maxDoseQuantity: z.number().int().positive().max(1000),
  safety: medicationSafetyRuleSchema.optional(),
  packageInsert: medicationPackageInsertSchema.optional(),
}).strict()
export type InpatientBaseStockMedication = z.infer<typeof inpatientBaseStockMedicationSchema>

export const surgicalMedicationPackageIds = [
  'catheterization-contrast-anticoagulation',
  'catheterization-local-anesthesia-vasodilator',
  'general-surgery-perioperative-fluid',
] as const
export const surgicalMedicationPackageIdSchema = z.enum(surgicalMedicationPackageIds)
export type SurgicalMedicationPackageId = z.infer<typeof surgicalMedicationPackageIdSchema>

export const inpatientSurgicalMedicationPackageItemSchema = z.object({
  medicationId: id,
  display: z.string().min(1),
  doseText: z.string().trim().min(1).max(120),
  quantity: z.number().int().positive().max(1000),
  unit: z.string().min(1),
  routeCode: medicationRouteSchema,
  available: z.boolean(),
  catalogVersion: version.nullable(),
  priceFen: z.number().int().nonnegative().safe().nullable(),
  unavailableReason: z.enum(['not-installed', 'inactive']).optional(),
}).strict()
export type InpatientSurgicalMedicationPackageItem = z.infer<typeof inpatientSurgicalMedicationPackageItemSchema>

export const inpatientSurgicalMedicationPackageSchema = z.object({
  id: surgicalMedicationPackageIdSchema,
  display: z.string().min(1),
  displayEn: z.string().min(1),
  procedureCodes: z.array(z.string().min(1)).min(1),
  items: z.array(inpatientSurgicalMedicationPackageItemSchema).min(1),
}).strict()
export type InpatientSurgicalMedicationPackage = z.infer<typeof inpatientSurgicalMedicationPackageSchema>

export const inpatientProcedureNursingBindingSchema = z.object({
  serviceId: id,
  serviceVersion: version,
  display: z.string().min(1),
  unit: z.string().min(1),
  priceFen: z.number().int().positive().safe(),
  procedureIds: z.array(id).min(1),
}).strict()
export type InpatientProcedureNursingBinding = z.infer<typeof inpatientProcedureNursingBindingSchema>

export const inpatientSurgeryCatalogSchema = z.object({
  procedures: z.array(inpatientProcedureItemSchema),
  materials: z.array(z.union([inpatientMaterialItemSchema, unavailableMaterial])),
  locations: z.array(inpatientSurgeryLocationSchema).default([]),
  practitioners: z.array(inpatientSurgeryPractitionerSchema).default([]),
  baseStockMedications: z.array(inpatientBaseStockMedicationSchema).default([]),
  medicationPackages: z.array(inpatientSurgicalMedicationPackageSchema).default([]),
  nursingBindings: z.array(inpatientProcedureNursingBindingSchema).default([]),
}).strict()

const surgeryRequestFields = {
  encounterVersion: z.string().regex(/^\d+$/),
  surgeryType: surgeryTypeSchema,
  procedureId: id,
  catalogVersion: version,
  plannedFor: z.iso.datetime({ offset: true }),
  locationId: surgeryLocationIdSchema,
  surgeonPractitionerId: id,
  assistantPractitionerId: id.optional(),
  anesthesiaMethod: anesthesiaMethodSchema,
  preopOrderPolicy: preopOrderPolicySchema,
  standbyAdHocPci: z.boolean().optional(),
  reason: note,
  clinicalOverride: clinicalOverrideInputSchema.optional(),
}

function distinctSurgeons(input: { surgeonPractitionerId: string; assistantPractitionerId?: string | undefined }): boolean {
  return input.assistantPractitionerId === undefined || input.assistantPractitionerId !== input.surgeonPractitionerId
}

export const inpatientSurgeryRequestBodySchema = z.object(surgeryRequestFields).strict().refine(distinctSurgeons, {
  message: '主刀医师与第一助手不能为同一人',
  path: ['assistantPractitionerId'],
})

export const inpatientSurgeryRequestInputSchema = z.object({
  admissionId: id,
  ...surgeryRequestFields,
}).strict().refine(distinctSurgeons, {
  message: '主刀医师与第一助手不能为同一人',
  path: ['assistantPractitionerId'],
})

/** 升级前旧版手术申请入参，仅用于既有持久回执（`command_receipt`）原样幂等重放。 */
const legacySurgeryRequestFields = {
  encounterVersion: z.string().regex(/^\d+$/),
  procedureId: id,
  catalogVersion: version,
  plannedFor: z.iso.datetime({ offset: true }),
  reason: note,
  clinicalOverride: clinicalOverrideInputSchema.optional(),
}

export const inpatientLegacySurgeryRequestBodySchema = z.object(legacySurgeryRequestFields).strict()

export const inpatientLegacySurgeryRequestInputSchema = z.object({
  admissionId: id,
  ...legacySurgeryRequestFields,
}).strict()

const surgeryActionBaseSchema = z.object({ admissionId: id, requestId: id, expectedRequestVersion: version }).strict()
export const inpatientSurgeryActionInputSchema = surgeryActionBaseSchema.extend({ note }).strict()

const confirmConsentFields = {
  requestId: id,
  expectedRequestVersion: version,
  expectedDiagnosisRevision: z.number().int().nonnegative(),
  signerRole: surgicalConsentSignerRoleSchema,
  signerName: z.string().trim().min(1).max(80),
  signerRelationship: z.string().trim().min(1).max(40).optional(),
  patientChoice: z.literal('agree'),
  individualizedRisks: z.string().trim().max(2000).optional(),
  note: optionalNote,
}

function validConsentSigner(input: { signerRole: SurgicalConsentSignerRole; signerRelationship?: string | undefined }): boolean {
  return input.signerRole === 'family-proxy'
    ? input.signerRelationship !== undefined && input.signerRelationship.trim().length > 0
    : input.signerRelationship === undefined
}

export const inpatientSurgeryConfirmConsentBodySchema = z.object(confirmConsentFields).strict().refine(validConsentSigner, {
  message: '受托人签署须提供与患者关系，患者本人签署不填写受托关系',
  path: ['signerRelationship'],
})

export const inpatientSurgeryConfirmConsentInputSchema = z.object({
  admissionId: id,
  ...confirmConsentFields,
}).strict().refine(validConsentSigner, {
  message: '受托人签署须提供与患者关系，患者本人签署不填写受托关系',
  path: ['signerRelationship'],
})

export const inpatientSurgeryMedicationSelectionSchema = z.object({
  medicationId: id,
  catalogVersion: version,
  doseText: z.string().trim().min(1).max(120),
  quantity: z.number().int().positive().max(1000),
  routeCode: medicationRouteSchema,
}).strict()
export type InpatientSurgeryMedicationSelection = z.infer<typeof inpatientSurgeryMedicationSelectionSchema>

export const inpatientSurgeryExecuteInputSchema = surgeryActionBaseSchema.extend({ procedureId: id, catalogVersion: version, note: optionalNote,
  materials: z.array(z.object({ materialId: id, catalogVersion: version, quantity: z.number().int().positive().max(1000),
    /** 预留替换：引用本住院预留中的耗材记录，执行时一次性转为实际使用，不重复计费。 */
    reservationId: id.optional() }).strict()).max(20)
    .refine(items => new Set(items.map(item => item.materialId)).size === items.length, '耗材不得重复')
    .refine(items => { const ids = items.map(item => item.reservationId).filter(value => value !== undefined); return new Set(ids).size === ids.length }, '耗材预留不得重复引用'),
  medications: z.array(inpatientSurgeryMedicationSelectionSchema).max(20)
    .refine(items => new Set(items.map(item => item.medicationId)).size === items.length, '同批台内药品不得重复，同品种请合并本次用量')
    .optional(),
})
export const inpatientSurgeryStartInputSchema = surgeryActionBaseSchema.extend({ note: optionalNote, procedureId: id, catalogVersion: version }).strict()
export const inpatientSurgeryMaterialSelectionSchema = z.object({ materialId: id, catalogVersion: version,
  quantity: z.number().int().positive().max(1000), reservationId: id.optional(), expectedReservationVersion: version.optional() }).strict()
  .refine(input => input.reservationId === undefined ? input.expectedReservationVersion === undefined : input.expectedReservationVersion !== undefined,
    '引用预留须提供其当前版本')
export const inpatientSurgeryRecordMaterialInputSchema = surgeryActionBaseSchema.extend({ note: optionalNote, executionId: id,
  material: inpatientSurgeryMaterialSelectionSchema }).strict()
export const inpatientSurgeryRecordMedicationInputSchema = surgeryActionBaseSchema.extend({ note: optionalNote, executionId: id,
  medication: inpatientSurgeryMedicationSelectionSchema }).strict()
export const inpatientSurgerySupplementMaterialInputSchema = surgeryActionBaseSchema.extend({
  note, executionId: id, material: inpatientSurgeryMaterialSelectionSchema,
  expectedCharge: charge.pick({ id: true, priceFen: true, unit: true }),
}).strict()
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
export const inpatientSurgeryCompletionReviewInputSchema = surgeryActionBaseSchema.extend({ note: optionalNote, executionId: id, ...reconciliation }).strict()
export const inpatientSurgeryCompleteInputSchema = surgeryActionBaseSchema.extend({ note: optionalNote, executionId: id,
  reconciliation: z.object({ ...reconciliation, expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
}).strict()
export const inpatientSurgeryConvertToPciInputSchema = surgeryActionBaseSchema.extend({
  procedureId: id,
  catalogVersion: version,
  note: optionalNote,
  clinicalOverride: clinicalOverrideInputSchema.optional(),
}).strict()
export const inpatientSurgeryFinalizeStandbyInputSchema = surgeryActionBaseSchema.extend({
  note: optionalNote,
}).strict()
const preparation = z.object({ actorId: z.string().min(1), practitionerRoleId: id, recordedAt: z.iso.datetime({ offset: true }), note }).strict()
export const inpatientConsentConfirmationSchema = preparation.extend({
  document: inpatientSurgicalConsentDocumentSchema.optional(),
}).strict()
export type InpatientConsentConfirmation = z.infer<typeof inpatientConsentConfirmationSchema>

export const inpatientAdHocPciConversionSchema = z.object({
  status: z.enum(['converted', 'cancelled']),
  procedure: inpatientProcedureItemSchema,
  convertedAt: z.iso.datetime({ offset: true }),
  convertedBy: z.string().min(1),
  practitionerRoleId: id,
  note,
  angiographyExecutionId: id,
  angiographyReportId: id.nullable(),
  cancellation: preparation.optional(),
}).strict()
export type InpatientAdHocPciConversion = z.infer<typeof inpatientAdHocPciConversionSchema>

export const inpatientSurgeryRequestSchema = z.object({
  id, admissionId: id, version, status: z.enum(['requested','ready','standby-pci','completed','cancelled']),
  surgeryType: surgeryTypeSchema.optional(),
  plannedProcedure: inpatientProcedureItemSchema,
  plannedFor: z.iso.datetime({ offset: true }),
  location: inpatientSurgeryLocationSchema.pick({ id: true, name: true }).optional(),
  surgeon: inpatientSurgeryPractitionerSchema.optional(),
  assistant: inpatientSurgeryPractitionerSchema.optional(),
  anesthesiaMethod: anesthesiaMethodSchema.optional(),
  preopOrderPolicy: preopOrderPolicySchema.default('continue-active'),
  standbyAdHocPci: z.boolean().optional(),
  adHocPci: inpatientAdHocPciConversionSchema.optional(),
  standbyFinalization: preparation.optional(),
  reason: note,
  requestedAt: z.iso.datetime({ offset: true }),
  requestedBy: z.string().min(1),
  organizationId: id,
  preopCheck: preparation.optional(),
  consentConfirmation: inpatientConsentConfirmationSchema.optional(),
  cancellation: preparation.optional(),
}).strict()
export const inpatientSurgeryMaterialUseSchema = z.object({ id, item: inpatientMaterialItemSchema,
  quantity: z.number().int().positive().max(1000), amountFen: z.number().int().nonnegative().safe() }).strict()
export const inpatientSurgeryMaterialHistorySchema = inpatientSurgeryMaterialUseSchema.extend({
  recordingKind: z.enum(['initial', 'postoperative-addendum']).default('initial'),
  recordedAt: z.iso.datetime({ offset: true }), recordedBy: z.string().min(1), practitionerRoleId: id, note,
  reservationId: id.nullable(), chargeId: id.nullable().default(null),
  correction: z.object({ id, recordedAt: z.iso.datetime({ offset: true }), recordedBy: z.string().min(1), practitionerRoleId: id,
    note, replacementMaterialUseId: id.nullable(), originalChargeId: id, reversalChargeId: id }).strict().nullable().default(null),
}).strict()
export const inpatientSurgeryMedicationUseSchema = z.object({
  id,
  administrationId: id,
  medicationId: id,
  catalogVersion: version,
  display: z.string().min(1),
  doseText: z.string().min(1),
  quantity: z.number().int().positive().max(1000),
  unit: z.string().min(1),
  routeCode: medicationRouteSchema,
  priceFen: z.number().int().nonnegative().safe(),
  amountFen: z.number().int().nonnegative().safe(),
  recordedAt: z.iso.datetime({ offset: true }),
  recordedBy: z.string().min(1),
  practitionerRoleId: id,
  note,
  chargeId: id.nullable().default(null),
}).strict()
export type InpatientSurgeryMedicationUse = z.infer<typeof inpatientSurgeryMedicationUseSchema>

export const inpatientSurgeryNursingChargeSchema = z.object({
  serviceId: id,
  serviceVersion: version,
  display: z.string().min(1),
  unit: z.string().min(1),
  amountFen: z.number().int().nonnegative().safe(),
  chargeId: id.nullable().default(null),
}).strict()
export type InpatientSurgeryNursingCharge = z.infer<typeof inpatientSurgeryNursingChargeSchema>

export const inpatientSurgeryExecutionSchema = z.object({ id, admissionId: id, requestId: id,
  executionStage: z.literal('ad-hoc-pci').optional(),
  actualProcedure: inpatientProcedureItemSchema,
  performedAt: z.iso.datetime({ offset: true }), performedBy: z.string().min(1), practitionerRoleId: id, organizationId: id, note,
  materials: z.array(inpatientSurgeryMaterialUseSchema), materialHistory: z.array(inpatientSurgeryMaterialHistorySchema).default([]),
  medications: z.array(inpatientSurgeryMedicationUseSchema).optional(),
  linkedNursing: inpatientSurgeryNursingChargeSchema.optional(),
  sameSessionNursingIncluded: z.literal(true).optional(),
  completedAt: z.iso.datetime({ offset: true }).optional(),
}).strict()
export const inpatientSurgerySchema = z.object({ admissionId: id, encounterVersion: z.string().regex(/^\d+$/), virtualTime: z.iso.datetime({ offset: true }),
  requests: z.array(inpatientSurgeryRequestSchema), executions: z.array(inpatientSurgeryExecutionSchema), inProgress: z.array(inpatientSurgeryExecutionSchema).default([]) }).strict()
export const inpatientSurgeryResponseSchema = commandResponseSchema(inpatientSurgerySchema)
export const inpatientSurgeryAutoStopOrderPreviewSchema = z.object({
  orderId: id,
  orderVersion: version,
  kind: z.enum(['medication', 'service']),
  display: z.string().min(1),
  state: z.enum(['signed', 'verified']),
  doseText: z.string().min(1).optional(),
  frequencyCode: z.string().min(1).optional(),
  routeCode: medicationRouteSchema.optional(),
}).strict()
export type InpatientSurgeryAutoStopOrderPreview = z.infer<typeof inpatientSurgeryAutoStopOrderPreviewSchema>

export const inpatientSurgeryCompletionPreviewSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  materials: z.array(z.object({ item: inpatientMaterialItemSchema, materialUseIds: z.array(id), reservationId: id.nullable(),
    previousQuantity: z.number().int().nonnegative(), quantity: z.number().int().nonnegative(),
    deltaQuantity: z.number().int(), deltaFen: z.number().int().safe(),
  }).strict()),
  retainedReservations: z.array(inpatientMaterialReservationSchema),
  materialDeltaFen: z.number().int().safe(), procedureAmountFen: z.number().int().nonnegative().safe(),
  nursingAmountFen: z.number().int().nonnegative().safe().default(0),
  linkedNursing: inpatientSurgeryNursingChargeSchema.omit({ chargeId: true }).nullable().default(null),
  sameSessionNursingIncluded: z.boolean().optional(),
  preopOrderPolicy: preopOrderPolicySchema.default('continue-active'),
  autoStopPreopOrders: z.array(inpatientSurgeryAutoStopOrderPreviewSchema).default([]),
  totalDeltaFen: z.number().int().safe(),
}).strict()

/** 医生 Session 内的申请理由草稿，不创建正式手术申请。 */
export const inpatientSurgeryRequestReasonInputSchema = z.object({ admissionId: id }).strict()
export const inpatientSurgeryRequestReasonGenerationSchema = z.object({ reason: note }).strict()
export const inpatientSurgeryRequestReasonSchema = z.object({
  admissionId: id, taskId: id.nullable(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  status: z.enum(['unavailable', 'idle', 'queued', 'running', 'succeeded', 'stale', 'blocked', 'unknown', 'failed']),
  reason: note.nullable(), failureCode: z.string().nullable(),
}).strict()
export const inpatientSurgeryRequestReasonResponseSchema = commandResponseSchema(inpatientSurgeryRequestReasonSchema)
