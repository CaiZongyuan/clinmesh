import { z } from 'zod'
import { packSourceSummarySchema } from './pack-source.ts'
import { medicationFrequencySchema } from './medication-safety.ts'

const s = z.string(), id = s.regex(/^[A-Za-z0-9.-]{1,64}$/), dt = z.iso.datetime({ offset: true })
const ev = z.object({ label: s.min(1).max(240), reference: s.min(1).max(200), versionId: s.min(1).max(64).optional() }).strict()
const base = { catalogItemId: s.min(1).max(128).optional(), evidence: z.array(ev).max(8), message: s.min(1).max(500) }

export const clinicalQualityGateSchema = z.enum([
  'outpatient-prescription', 'outpatient-completion', 'inpatient-order', 'inpatient-pci-plan', 'inpatient-discharge',
])
export type ClinicalQualityGate = z.infer<typeof clinicalQualityGateSchema>

export const clinicalQualityRedLineCodeSchema = z.enum([
  'RENAL_CONTRAINDICATED_MEDICATION', 'MEDICATION_ALLERGY_CONFLICT', 'MEDICATION_DOSE_LIMIT_EXCEEDED', 'MEDICATION_CLASS_DUPLICATION',
])
export const clinicalQualityAlertCodeSchema = z.enum([
  'CHEST_PAIN_WORKUP_INCOMPLETE', 'PCI_NON_ISCHEMIC_LESION', 'DISCHARGE_ANTIPLATELET_MISSING',
  'DISCHARGE_STATIN_MISSING', 'RENAL_CREATININE_MISSING', 'ANTIBIOTIC_WITHOUT_BACTERIAL_INDICATION',
  'INVESTIGATION_WITHOUT_INDICATION',
])
export type ClinicalQualityAlertCode = z.infer<typeof clinicalQualityAlertCodeSchema>

export const clinicalQualityRedLineSchema = z.object({ ...base, code: clinicalQualityRedLineCodeSchema, tier: z.literal('red-line') }).strict()
/** 无指征黄牌的“需要／已查到／判断”三段，界面直接显示；内部规则 ID 只放 `ruleId`。 */
export const clinicalQualityAlertBasisSchema = z.object({ foundZh: s.min(1).max(500), judgementZh: s.min(1).max(500), needZh: s.min(1).max(500) }).strict()
export const clinicalQualityAlertSchema = z.object({
  ...base, basis: clinicalQualityAlertBasisSchema.optional(), code: clinicalQualityAlertCodeSchema, ruleId: s.min(1).max(128).optional(), tier: z.literal('alert'),
}).strict()
export type ClinicalQualityRedLine = z.infer<typeof clinicalQualityRedLineSchema>
export type ClinicalQualityAlert = z.infer<typeof clinicalQualityAlertSchema>

/** 适应症所需资料未齐时的“缺项待补”提示：不拦截保存，也不判为无指征。 */
export const clinicalQualityPendingIndicationSchema = z.object({
  catalogItemId: s.min(1).max(128).optional(),
  messageZh: s.min(1).max(500),
  missingInputs: z.array(s.min(1).max(120)).min(1).max(16),
  orderDisplay: s.min(1).max(240),
}).strict()
export type ClinicalQualityPendingIndication = z.infer<typeof clinicalQualityPendingIndicationSchema>

export const clinicalQualityCheckSchema = z.object({
  alerts: z.array(clinicalQualityAlertSchema).max(16),
  evaluatedAt: dt,
  gate: clinicalQualityGateSchema,
  packId: z.string().regex(/^[a-z0-9-]{1,64}$/).optional(),
  packVersion: z.string().trim().min(1).max(64).optional(),
  pendingIndications: z.array(clinicalQualityPendingIndicationSchema).max(16).optional(),
  redLines: z.array(clinicalQualityRedLineSchema).max(16),
  sourcePacks: z.array(packSourceSummarySchema).max(32).optional(),
  status: z.enum(['pass', 'alert', 'blocked']).optional(),
}).strict()
export type ClinicalQualityCheck = z.infer<typeof clinicalQualityCheckSchema>

export const clinicalOverrideReasonSchema = z.enum([
  'documented-contraindication', 'external-result-verified', 'result-pending-follow-up',
  'patient-informed-refusal', 'clinical-judgement', 'emergency-care',
])
export type ClinicalOverrideReason = z.infer<typeof clinicalOverrideReasonSchema>

export const clinicalOverrideInputSchema = z.object({
  acknowledgedAlerts: z.array(clinicalQualityAlertCodeSchema).min(1).max(16)
    .refine(c => new Set(c).size === c.length, 'Acknowledged alerts must be unique'),
  note: s.trim().min(4).max(500),
  reasonCode: clinicalOverrideReasonSchema,
}).strict()
export type ClinicalOverrideInput = z.infer<typeof clinicalOverrideInputSchema>

export const clinicalQualityReceiptSchema = z.object({
  alerts: z.array(clinicalQualityAlertSchema).min(1).max(16),
  gate: clinicalQualityGateSchema,
  override: z.object({ note: s.min(1).max(500), reasonCode: clinicalOverrideReasonSchema }).strict(),
  overrideId: id,
  recordedAt: dt,
}).strict()
export type ClinicalQualityReceipt = z.infer<typeof clinicalQualityReceiptSchema>

export const outpatientClinicalQualityInputSchema = z.object({
  encounterId: s.min(1).max(64),
  gate: z.enum(['outpatient-prescription', 'outpatient-completion']),
}).strict()

export const inpatientClinicalQualityInputSchema = z.object({
  admissionId: id,
  catalogItemId: s.min(1).max(128).optional(),
  doseText: s.trim().min(1).max(120).optional(),
  frequencyCode: medicationFrequencySchema.optional(),
  gate: z.enum(['inpatient-order', 'inpatient-pci-plan', 'inpatient-discharge']),
}).strict().refine(v => v.gate !== 'inpatient-order' || v.catalogItemId !== undefined, {
  message: 'The inpatient order gate requires a candidate catalogItemId',
  path: ['catalogItemId'],
})
