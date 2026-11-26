import { z } from 'zod'
import { clinicalScoreMissingInputSchema, clinicalScoreSourceReferenceSchema } from './clinical-scores.ts'
import { packSourceSummarySchema } from './pack-source.ts'
import { preopOrderPolicySchema } from './inpatient-surgery.ts'
import { outpatientInvestigationPriceSchema } from './investigation-billing.ts'
import { medicationFrequencySchema, medicationRouteSchema } from './medication-safety.ts'

export const orderSetTemplateIds = [
  'chest-pain-stat-workup',
  'cad-admission-baseline',
  'cin-perioperative-hydration',
  'cad-pci-secondary-prevention',
  'pci-postop-standard',
  'general-surgery-postop-standard',
] as const
export const outpatientOrderSetTemplateIds = [
  'chest-pain-stat-workup',
  'cad-pci-secondary-prevention',
] as const
export const postoperativeOrderSetTemplateIds = [
  'pci-postop-standard',
  'general-surgery-postop-standard',
] as const
/**
 * 专病包动态注册组套模板；合同层保留开放 slug，不枚举具体病种模板 ID（#553 AC4）。
 */
export const orderSetTemplateIdSchema = z.string().regex(/^[a-z0-9-]{1,64}$/)
export type OrderSetTemplateId = z.infer<typeof orderSetTemplateIdSchema>

export const orderSetScopeSchema = z.enum(['outpatient', 'inpatient'])
const scope = orderSetScopeSchema
export type OrderSetScope = z.infer<typeof scope>

const itemKind = z.enum(['laboratory', 'examination', 'medication', 'service'])
export type OrderSetItemKind = z.infer<typeof itemKind>

const strict = <Shape extends z.ZodRawShape>(shape: Shape) => z.object(shape).strict()
const text = (max: number) => z.string().trim().min(1).max(max)
const id = z.string().min(1).max(512)
const slug = z.string().regex(/^[a-z0-9-]{1,64}$/)
const ref = z.string().min(1).max(160)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const num = z.number().finite()
const int = z.number().int()
const posInt = int.positive()
const nonnegInt = int.nonnegative()
const isoTime = z.iso.datetime({ offset: true })
const examCode = z.enum(['ecg-12-lead', 'tte'])
const duration = z.enum(['long', 'temporary'])
const vitalSource = z.enum(['triage', 'inpatient-nursing'])

export const orderSetScreeningRuleSchema = strict({
  action: z.enum(['exclude', 'caution']),
  comparator: z.enum(['below', 'at-least', 'required']),
  input: z.enum(['pulseBpm', 'systolicMmHg', 'egfr', 'weightKg']),
  rationaleZh: text(240),
  threshold: num.positive().nullable(),
}).refine(r => (r.comparator === 'required') === (r.threshold === null))
const rule = orderSetScreeningRuleSchema
export type OrderSetScreeningRule = z.infer<typeof rule>

export const orderSetTemplateOptionSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('laboratory'), referenceCode: text(64), referenceSystem: z.url() }),
  strict({ examCode, indication: text(500), kind: z.literal('examination') }),
  strict({
    courseDays: int.min(1).max(30),
    doseText: text(120),
    frequencyCode: medicationFrequencySchema,
    inpatientDuration: duration,
    instructionsZh: text(240).optional(),
    kind: z.literal('medication'),
    medicationKey: slug,
    prnQuantity: posInt.max(1_000).optional(),
    routeCode: medicationRouteSchema,
    rules: z.array(rule).max(8),
  }).refine(o => (o.frequencyCode === 'PRN') === (o.prnQuantity !== undefined) && (o.frequencyCode !== 'ONCE' || o.inpatientDuration === 'temporary')),
  strict({
    inpatientDuration: duration,
    kind: z.literal('service'),
    quantity: posInt.max(100),
    serviceId: id,
  }),
])
const option = orderSetTemplateOptionSchema
export type OrderSetTemplateOption = z.infer<typeof option>

const title = text(160)
const scopes = z.array(scope).min(1).max(2)
const ver = z.string().regex(/^\d+$/)

const templateItem = strict({
  key: slug,
  kind: itemKind,
  options: z.array(option).min(1).max(4),
  rationaleZh: text(500),
  rules: z.array(rule).max(8),
  scopes,
  titleEn: title,
  titleZh: title,
}).refine(i => i.options.every(o => o.kind === i.kind) && (i.kind !== 'service' || i.scopes.every(s => s === 'inpatient')))
export type OrderSetTemplateItem = z.infer<typeof templateItem>

const draftTemplate = strict({
  applicableProcedureCodes: z.array(text(64)).min(1).max(32).optional(),
  descriptionZh: text(1000),
  fingerprint: sha256,
  id: orderSetTemplateIdSchema,
  scopes,
  titleEn: title,
  titleZh: title,
  version: text(64),
})
export type OrderSetDraftTemplate = z.infer<typeof draftTemplate>

export const orderSetTemplateSchema = draftTemplate.extend({ items: z.array(templateItem).min(1).max(16) }).strict()
export type OrderSetTemplate = z.infer<typeof orderSetTemplateSchema>

const reasonCode = z.enum([
  'allergy-contraindication',
  'pulse-below-threshold',
  'systolic-below-threshold',
  'egfr-below-threshold',
  'egfr-at-or-above-threshold',
  'heart-failure-or-reduced-lvef',
  'vital-signs-missing',
  'egfr-missing',
  'weight-missing',
  'already-active-order',
  'mutually-exclusive-active-order',
  'in-flight-investigation',
  'catalog-unavailable',
  'catalog-rule-mismatch',
  'catalog-unpriced',
])
export type OrderSetReasonCode = z.infer<typeof reasonCode>

const reason = strict({
  allergen: strict({ code: text(128), display: text(240) }).optional(),
  code: reasonCode,
  messageZh: text(500),
  observedValue: num.nullable(),
  severity: z.enum(['exclude', 'skip', 'caution', 'pending-verification', 'unavailable']),
  sourceReference: ref.nullable(),
  threshold: num.nullable(),
})
export type OrderSetReason = z.infer<typeof reason>

const disposition = z.enum(['ready', 'needs-review', 'skipped', 'excluded', 'unavailable'])
export type OrderSetDisposition = z.infer<typeof disposition>

const candidate = z.discriminatedUnion('kind', [
  strict({
    catalogItemId: id,
    catalogVersion: posInt,
    display: text(500),
    indicationCode: text(64),
    indicationCodes: z.array(text(64)).min(1).max(32),
    kind: z.literal('laboratory'),
    outpatientBilling: outpatientInvestigationPriceSchema.nullable(),
    priceFen: posInt,
  }),
  strict({
    catalogVersion: posInt,
    display: text(500),
    examCode,
    indication: text(500),
    kind: z.literal('examination'),
    outpatientBilling: outpatientInvestigationPriceSchema.nullable(),
    priceFen: posInt,
    serviceId: id,
  }),
  strict({
    catalogItemId: id,
    catalogVersion: posInt,
    display: text(500),
    doseText: text(120),
    frequencyCode: medicationFrequencySchema,
    inpatient: strict({ doseQuantity: posInt.max(100), duration }).nullable(),
    instructionsZh: text(500).nullable(),
    kind: z.literal('medication'),
    outpatient: strict({ courseDays: int.min(1).max(30), quantity: int.min(1).max(1_000) }).nullable(),
    routeCode: medicationRouteSchema,
  }).refine(c => (c.inpatient === null) !== (c.outpatient === null)),
  strict({
    display: text(500),
    duration,
    kind: z.literal('service'),
    priceFen: posInt,
    quantity: posInt.max(100),
    serviceId: id,
    serviceVersion: posInt,
    unit: text(64),
  }),
])
export type OrderSetCandidate = z.infer<typeof candidate>

const draftItem = strict({
  candidate: candidate.nullable(),
  disposition,
  key: slug,
  kind: itemKind,
  matchedCatalogId: id.nullable(),
  reasons: z.array(reason).max(16),
  titleZh: title,
}).refine(i =>
  (i.candidate === null) === (i.disposition === 'excluded' || i.disposition === 'unavailable' || i.disposition === 'skipped')
  && (i.candidate === null || (i.candidate.kind === i.kind && i.matchedCatalogId === (i.candidate.kind === 'examination' || i.candidate.kind === 'service' ? i.candidate.serviceId : i.candidate.catalogItemId))))
export type OrderSetDraftItem = z.infer<typeof draftItem>

const draft = strict({
  counts: strict({ excluded: nonnegInt, needsReview: nonnegInt, ready: nonnegInt, skipped: nonnegInt.default(0), unavailable: nonnegInt }),
  fingerprint: sha256,
  items: z.array(draftItem).min(1).max(16),
  packId: slug.optional(),
  packVersion: text(64).optional(),
  template: draftTemplate,
})
export type OrderSetDraft = z.infer<typeof draft>

const facts = strict({
  allergies: z.array(strict({ code: text(128), display: text(240), reference: ref })).max(100),
  egfr: z.discriminatedUnion('status', [
    strict({ sourceReferences: z.array(clinicalScoreSourceReferenceSchema).max(8), status: z.literal('present'), valueMlMin173: num.nonnegative() }),
    strict({ missingInputs: z.array(clinicalScoreMissingInputSchema).min(1), status: z.literal('missing') }),
  ]),
  vitalSigns: z.discriminatedUnion('status', [
    strict({ diastolicMmHg: num, pulseBpm: num, recordedAt: isoTime, reference: ref, source: vitalSource, status: z.literal('present'), systolicMmHg: num, versionId: text(64) }),
    strict({ source: vitalSource, status: z.literal('missing') }),
  ]),
  weight: z.discriminatedUnion('status', [
    strict({ recordedAt: isoTime, reference: ref, status: z.literal('present'), versionId: text(64), weightKg: num.positive() }),
    strict({ status: z.literal('missing') }),
  ]),
})
export type OrderSetPatientFacts = z.infer<typeof facts>

export const orderSetDraftBundleSchema = strict({
  drafts: z.array(draft).min(0).max(64),
  evaluatedAt: isoTime,
  packId: slug.optional(),
  packVersion: text(64).optional(),
  patientFacts: facts,
  sourcePacks: z.array(packSourceSummarySchema).max(32).optional(),
  target: z.discriminatedUnion('scope', [
    strict({ caseId: id, encounterId: id, encounterVersion: ver, scope: z.literal('outpatient') }),
    strict({
      admissionId: id,
      encounterVersion: ver,
      preopOrderPolicy: preopOrderPolicySchema.optional(),
      scope: z.literal('inpatient'),
      surgeryExecutionId: id.optional(),
      surgeryProcedureCode: text(64).optional(),
      surgeryProcedureDisplay: text(240).optional(),
    }),
  ]),
})
export type OrderSetDraftBundle = z.infer<typeof orderSetDraftBundleSchema>

export const orderSetTemplateListQuerySchema = strict({ scope: scope.optional() })
export type OrderSetTemplateListQuery = z.infer<typeof orderSetTemplateListQuerySchema>

export const orderSetTemplateListSchema = strict({ items: z.array(orderSetTemplateSchema).min(1).max(64) })
export type OrderSetTemplateList = z.infer<typeof orderSetTemplateListSchema>

const keyId = z.string().min(1).max(64)
export const orderSetDraftQuerySchema = strict({ templateId: orderSetTemplateIdSchema.optional() })
export const inpatientOrderSetDraftQuerySchema = strict({
  surgeryExecutionId: keyId.optional(),
  templateId: orderSetTemplateIdSchema.optional(),
})
export const outpatientOrderSetDraftsInputSchema = strict({ caseId: keyId, templateId: orderSetTemplateIdSchema.optional() })
export const inpatientOrderSetDraftsInputSchema = strict({
  admissionId: keyId,
  surgeryExecutionId: keyId.optional(),
  templateId: orderSetTemplateIdSchema.optional(),
})
