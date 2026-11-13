import { medicationSafetyRuleSchema } from '@clinmesh/contracts/medication-safety'
import { createHmac } from 'node:crypto'
import type { DoctorCaseHistoryDetail } from '@clinmesh/contracts/agent'
import { fhirResourceSchema, type FhirResource } from '@clinmesh/contracts/fhir'
import {
  caseImagingServiceCatalogSchema,
  caseLaboratoryCatalogSearchSchema,
  casePathologyServiceCatalogSchema,
  clinicalPresentationSchema,
  confirmDiagnosisResponseSchema,
  consultationTurnSchema,
  diagnosisDraftContentSchema,
  diagnosisDraftResponseSchema,
  imagingRequestDraftResponseSchema,
  imagingRequestStateSchema,
  issueImagingRequestResponseSchema,
  issueLaboratoryRequestResponseSchema,
  issuePathologyRequestResponseSchema,
  issuePrescriptionResponseSchema,
  laboratoryRequestDraftResponseSchema,
  pathologyRequestDraftResponseSchema,
  prescriptionDraftResponseSchema,
  type ApiConflict,
  type ClinicalCatalog,
  type DiagnosisConfirmation,
  type DiagnosisDraftEntry,
  type InvestigationGenerationCapability,
  type LaboratoryRequest,
  type LaboratoryRequestCatalogItemId,
  type PatientSummary,
  type PrescriptionConflictReason,
  type PrescriptionDraftItem,
} from '@clinmesh/contracts/his'
import type { ImagingExamCode } from '@clinmesh/contracts/imaging'
import type { PathologyExamCode, PathologySourceProcedure } from '@clinmesh/contracts/pathology'
import { referenceConceptSnapshotSchema } from '@clinmesh/contracts/reference-data'
import { scenarioProductMedicationCatalogItemSchema } from '@clinmesh/contracts/scenario'
import { z } from 'zod'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { FhirRepository } from '../infrastructure/sqlite/fhir-repository.ts'
import type { ClinicalRequestKernel } from './clinical-request-kernel.ts'
import {
  ExpectedVersionConflictError,
  type ActorContext,
  type CommandEffect,
  type CommandExecutor,
  type CommandTransaction,
} from './command-executor.ts'
import { consultationReplyProjection } from './consultation-reply-attempts.ts'
import type { OutpatientInvestigationBilling } from './outpatient-investigation-billing.ts'
import type { PaymentLedger } from './payment-ledger.ts'
import type { ReferenceDataService } from './reference-data-service.ts'
import { WorkflowError } from './workflow-error.ts'

export interface CatalogRow {
  code: string
  config_json?: string
  item_id: string
  name_en: string
  name_zh: string
  price_fen: number
  version: number
}

export interface MedicationRuleSelection {
  catalogItemId: string
  configJson: string | undefined
  doseText: string
  frequencyCode: string
}

export interface InvestigationCapabilityResolver {
  generationCapabilityForCase: (
    workspaceId: string,
    epoch: string,
    outpatientCaseId: string,
    concept: z.infer<typeof referenceConceptSnapshotSchema>,
  ) => InvestigationGenerationCapability
}

export const diagnosisCatalogRowSchema = z.object({
  code: z.string().min(1),
  code_system: z.string().url(),
  item_id: z.string().min(1),
  name_en: z.string().min(1),
  name_zh: z.string().min(1),
  version: z.number().int().positive(),
})

// 空条目保留已丢弃草稿的单调版本，不投影为临床待办。
export const storedDiagnosisDraftContentSchema = diagnosisDraftContentSchema.extend({
  entries: z.array(diagnosisDraftContentSchema.shape.entries.element).max(8),
})

export const diagnosisStateRowSchema = z.object({
  draft_json: z.string().nullable(),
  status: z.enum(['draft', 'confirmed']),
  version: z.number().int().positive(),
})

const diagnosisConfirmationRowSchema = z.object({
  confirmation_id: z.string().min(1),
  confirmed_at: z.string().datetime({ offset: true }),
  provenance_id: z.string().min(1),
  revision_number: z.number().int().positive(),
  supersedes_confirmation_id: z.string().min(1).nullable(),
})

const diagnosisEntryRowSchema = z.object({
  catalog_item_id: z.string().min(1),
  condition_id: z.string().min(1),
  ordinal: z.number().int().positive(),
  role: z.enum(['primary', 'secondary']),
})

export const confirmedDiagnosisConditionSchema = z.object({
  code: z.object({
    coding: z.array(z.object({
      code: z.string().min(1),
      display: z.string().min(1),
      system: z.string().url(),
    }).loose()).min(1),
  }).loose(),
  note: z.array(z.object({ text: z.string().min(1) }).loose()).optional(),
}).loose()

export const prescriptionDraftStateRowSchema = z.object({
  draft_json: z.string().nullable(),
  version: z.number().int().positive(),
})

export const noMedicationConclusionRowSchema = z.object({
  authored_at: z.string().datetime({ offset: true }),
  authored_by_actor_id: z.string().min(1),
  authored_by_practitioner_role_id: z.string().min(1),
  conclusion_id: z.string().min(1),
  version: z.number().int().positive(),
})

export const prescriptionWithdrawalRowSchema = z.object({
  version: z.number().int().positive(),
  withdrawal_id: z.string().min(1),
  withdrawn_at: z.string().datetime({ offset: true }),
  withdrawn_by_actor_id: z.string().min(1),
  withdrawn_by_practitioner_role_id: z.string().min(1),
})

const medicationScopeConfigSchema = z.object({
  availableScopes: z.array(z.string()).optional(),
}).strip()

export const medicationPresentationSchema = z.object({
  product: z.object({
    dosageForm: z.string().trim().min(1).optional(),
    packageDescription: z.string().trim().min(1).optional(),
    strength: z.string().trim().min(1).optional(),
  }).partial().optional(),
  unit: z.string().trim().min(1).nullable().optional(),
}).strip()

const outpatientCaseStatusRowSchema = z.enum([
  'awaiting-triage',
  'awaiting-doctor',
  'first-visit',
  'awaiting-lab-payment',
  'awaiting-lis',
  'awaiting-report',
  'awaiting-revisit',
  'revisit-draft',
  'awaiting-medication-payment',
  'awaiting-dispense',
  'completed',
])

const prescriptionStatusRowSchema = z.enum(['dispensed', 'draft', 'paid', 'signed'])

export const activePrescriptionRowSchema = z.object({
  withdrawal_id: z.string().nullable(),
})

const withdrawablePrescriptionRowSchema = activePrescriptionRowSchema.extend({
  status: prescriptionStatusRowSchema,
  version: z.number().int().positive(),
})

export const prescriptionWithdrawalLookupRowSchema = withdrawablePrescriptionRowSchema.extend({
  case_id: z.string().min(1),
})

export const prescriptionWorkflowRowSchema = withdrawablePrescriptionRowSchema.extend({
  case_status: outpatientCaseStatusRowSchema,
  encounter_id: z.string().min(1),
})

export const prescriptionDispenseWorkflowRowSchema = prescriptionWorkflowRowSchema.extend({
  case_id: z.string().min(1),
  patient_id: z.string().min(1),
  prescription_id: z.string().min(1),
  prescription_number: z.string().min(1),
  review_id: z.string().min(1).nullable(),
  scenario_run_id: z.string().min(1),
})

export const prescriptionDispensingRowSchema = z.object({
  dispensed_quantity: z.number().int().nonnegative(),
  medication_request_id: z.string().min(1),
})

export const issuedPrescriptionRowSchema = z.object({
  authored_at: z.string().datetime({ offset: true }),
  authored_by_practitioner_role_id: z.string().min(1).nullable(),
  prescription_id: z.string().min(1),
  prescription_number: z.string().min(1),
  status: z.enum(['dispensed', 'paid', 'signed']),
  version: z.number().int().positive(),
})

export const issuedPrescriptionItemRowSchema = z.object({
  course_days: z.number().int().positive(),
  dose_text: z.string().min(1),
  frequency_code: z.string().min(1),
  medication_id: z.string().min(1),
  medication_request_id: z.string().min(1),
  medication_snapshot_json: z.string(),
  quantity: z.number().int().positive(),
})

const chargeStatusRowSchema = z.enum([
  'ambiguous',
  'billable',
  'declined',
  'paid',
  'payment-pending',
])

const paymentWorkflowRowSchema = activePrescriptionRowSchema.extend({
  case_status: outpatientCaseStatusRowSchema,
  prescription_status: prescriptionStatusRowSchema.nullable(),
})

export const paymentChargeRowSchema = paymentWorkflowRowSchema.extend({
  charge_id: z.string().min(1),
  charge_item_id: z.string().min(1),
  encounter_id: z.string().min(1),
  status: chargeStatusRowSchema,
  total_fen: z.number().int().nonnegative(),
  version: z.number().int().positive(),
})

export const paymentPreviewRowSchema = paymentWorkflowRowSchema.extend({
  account_id: z.string().min(1),
  actor_context_hash: z.string().nullable(),
  amount_fen: z.number().int().nonnegative(),
  case_id: z.string().min(1),
  category: z.enum(['laboratory', 'imaging', 'pathology', 'medication']),
  charge_id: z.string().min(1),
  charge_item_id: z.string().min(1),
  charge_status: chargeStatusRowSchema,
  charge_version: z.number().int().positive(),
  consumed_at: z.string().datetime({ offset: true }).nullable(),
  current_amount_fen: z.number().int().nonnegative(),
  encounter_id: z.string().min(1),
  expected_charge_version: z.number().int().positive(),
  expires_at: z.string().datetime({ offset: true }),
  patient_id: z.string().min(1),
  prescription_id: z.string().min(1).nullable(),
  service_request_id: z.string().min(1).nullable(),
  simulator_rule: z.string().min(1),
  tenders_json: z.string().nullable(),
  token_hash: z.string().min(1),
})

export const issuedMedicationRequestSchema = z.object({
  medication: z.object({
    reference: z.object({
      display: z.string().min(1).optional(),
      reference: z.string().min(1),
    }),
  }),
  requester: z.object({ reference: z.string().regex(/^PractitionerRole\/[A-Za-z0-9._-]+$/) }),
})

export const legacyMedicationCatalogConfigSchema = z.object({
  safety: medicationSafetyRuleSchema.optional(),
  allowedCombinationIds: z.array(z.string().min(1)),
  allowedDoseTexts: z.array(z.string().min(1)).min(1),
  allowedFrequencyCodes: z.array(z.string().min(1)).min(1),
  dose: z.string().min(1),
  frequency: z.string().min(1),
})

export const prescriptionMedicationCatalogConfigSchema = legacyMedicationCatalogConfigSchema.extend({
  allowedCourseDays: z.array(z.number().int().positive()).min(1),
  allowedDiagnosisCatalogItemIds: z.array(z.string().min(1)),
  allowedQuantities: z.array(z.number().int().positive()).min(1),
  defaultCourseDays: z.number().int().positive(),
  defaultQuantity: z.number().int().positive(),
})

export const medicationCourseDefaultsSchema = z.object({
  defaultCourseDays: z.number().int().positive().optional(),
}).passthrough()

export const medicationCatalogConfigRowSchema = z.object({
  config_json: z.string().min(1),
})

export const triageRecordContentSchema = z.object({
  acuityCode: z.enum(['level-1', 'level-2', 'level-3', 'level-4']),
  bloodPressure: z.object({
    diastolicMmHg: z.number(),
    systolicMmHg: z.number(),
  }),
  chiefComplaint: z.string(),
  oxygenSaturationPct: z.number(),
  pulseBpm: z.number(),
  respirationBpm: z.number(),
  temperatureC: z.number(),
})

export const countRowSchema = z.object({ count: z.number().int().nonnegative() }).strict()
export const hiddenFactValueRowSchema = z.object({ value_json: z.string() }).strict()

const consultationStateRowSchema = z.object({
  version: z.number().int().positive(),
})

export type ConsultationTurnDto = z.infer<typeof consultationTurnSchema>

export const consultationTurnRowSchema = z.object({
  actor_id: z.string().nullable(),
  practitioner_id: z.string().nullable(),
  case_id: z.string().min(1),
  kind: z.enum(['text', 'report-card']),
  message_text: z.string().min(1),
  persona_revision: z.number().int().positive().nullable(),
  recorded_at: z.string().min(1),
  report_reference: z.string().min(1).nullable(),
  sequence: z.number().int().positive(),
  source: z.enum([
    'doctor-typed',
    'patient-agent',
    'persona-opening',
    'report-card',
    'legacy-question-answer',
    'asr-import',
    'external-sync',
  ]),
  speaker: z.enum(['doctor', 'patient']),
  turn_id: z.string().min(1),
})

export const encounterCompletionResourceSchema = fhirResourceSchema.extend({
  actualPeriod: z.object({
    end: z.iso.datetime({ offset: true }).optional(),
    start: z.iso.datetime({ offset: true }),
  }).loose(),
  meta: z.object({
    lastUpdated: z.iso.datetime({ offset: true }),
    versionId: z.string().regex(/^\d+$/),
  }).loose(),
  resourceType: z.literal('Encounter'),
  status: z.enum(['completed', 'in-progress']),
}).loose()

export const signedClinicalDocumentRowSchema = z.object({
  bundle_id: z.string().min(1),
  composition_id: z.string().min(1),
  document_id: z.string().min(1),
  provenance_id: z.string().min(1),
  revision_of_document_id: z.string().min(1).nullable(),
  signed_at: z.iso.datetime({ offset: true }),
}).strict()

const activeOutpatientCaseRowSchema = z.object({
  case_id: z.string().min(1),
  doctor_task_id: z.string().min(1).nullable(),
  encounter_id: z.string().min(1),
  initial_task_id: z.string().min(1),
  registration_id: z.string().min(1),
  status: z.enum([
    'awaiting-triage',
    'awaiting-doctor',
    'first-visit',
    'awaiting-lab-payment',
    'awaiting-lis',
    'awaiting-report',
    'awaiting-revisit',
    'revisit-draft',
    'awaiting-medication-payment',
    'awaiting-dispense',
  ]),
})

const diagnosisDraftSchema = z.object({
  code: z.string(),
  display: z.string(),
})

export const firstVisitDraftContentSchema = z.object({
  assessment: z.string(),
  historyOfPresentIllness: z.string(),
})

export const revisitDraftContentSchema = z.object({
  conditionId: z.string().min(1),
  diagnosis: diagnosisDraftSchema,
})

export const documentDraftContentSchema = z.object({
  assessment: z.string(),
  composition: fhirResourceSchema.refine(resource => resource.resourceType === 'Composition'),
  diagnosis: diagnosisDraftSchema,
  medicationRequestIds: z.array(z.string().min(1)),
  plan: z.string(),
})

export const clinicalSignExpectedVersionsSchema = z.object({
  documentDraft: z.number().int().positive(),
  prescription: z.number().int().positive(),
  revisitDraft: z.number().int().positive(),
})

export const respiratoryPathogenFactSchema = z.object({
  code: z.string().min(1),
  detected: z.boolean(),
})

export const diagnosticReportContentSchema = z.object({
  result: z.array(z.object({ reference: z.string().min(1) }).loose()).optional(),
  status: z.string().min(1),
}).loose()

export const observationResultContentSchema = z.object({
  code: z.object({
    coding: z.array(z.object({ code: z.string().optional() }).loose()).optional(),
  }).loose().optional(),
  interpretation: z.array(z.object({
    coding: z.array(z.object({ code: z.string().optional() }).loose()).optional(),
  }).loose()).optional(),
  referenceRange: z.array(z.object({ text: z.string().optional() }).loose()).optional(),
  valueBoolean: z.boolean().optional(),
  valueCodeableConcept: z.object({
    coding: z.array(z.object({
      code: z.string().min(1),
      display: z.string().min(1),
      system: z.string().url(),
    }).loose()).min(1),
  }).loose().optional(),
  valueQuantity: z.object({
    unit: z.string().optional(),
    value: z.number().optional(),
  }).loose().optional(),
  valueString: z.string().optional(),
}).loose()

export const lisOrderDataSchema = z.object({
  diagnosticReportId: z.string().min(1),
  encounterVersion: z.string().min(1),
  status: z.literal('awaiting-revisit'),
})

export const practitionerRoleIdRowSchema = z.object({
  practitioner_role_id: z.string().min(1),
}).strict()

export const provenanceReasonSchema = z.object({
  reason: z.array(z.object({
    concept: z.object({ text: z.string().optional() }).loose(),
  }).loose()).optional(),
}).loose()

export const documentBundleEntrySchema = z.object({
  fullUrl: z.string().optional(),
  resource: fhirResourceSchema,
}).loose()

const structuredCompositionSectionSchema = z.object({
  section: z.array(z.object({
    entry: z.array(z.object({ reference: z.string().min(1) }).loose()).optional(),
    title: z.string().optional(),
  }).loose()),
}).loose()

const caseEncounterRowSchema = z.object({
  account_id: z.string(),
  case_id: z.string(),
  doctor_task_id: z.string().nullable(),
  encounter_id: z.string(),
  patient_id: z.string(),
  status: z.string(),
})

export type OutpatientCaseRow = z.infer<typeof caseEncounterRowSchema>

export function isOutpatientMedicationConfig(rawConfig: unknown): boolean {
  const scope = medicationScopeConfigSchema.safeParse(rawConfig)
  if (!scope.success) return false
  return scope.data.availableScopes === undefined
    || scope.data.availableScopes.includes('outpatient')
}

export function encounterDiagnosisConditionReference(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const conditions = (value as Record<string, unknown>).condition
  if (!Array.isArray(conditions)) return undefined
  for (const condition of conditions) {
    if (typeof condition !== 'object' || condition === null) continue
    const reference = (condition as Record<string, unknown>).reference
    if (typeof reference !== 'object' || reference === null) continue
    const candidate = (reference as Record<string, unknown>).reference
    if (typeof candidate === 'string') return candidate
  }
  return undefined
}

export function parseStoredFhirResource(content: string): FhirResource {
  return fhirResourceSchema.parse(JSON.parse(content))
}

function patientAddressText(resource: FhirResource): string | undefined {
  const addresses = Array.isArray(resource.address) ? resource.address : []
  const first = addresses[0] as { text?: unknown } | undefined
  return typeof first?.text === 'string' && first.text.length > 0 ? first.text : undefined
}

export function patientSummary(resource: FhirResource): PatientSummary {
  const identifier = Array.isArray(resource.identifier)
    ? (resource.identifier[0] as { value?: unknown } | undefined)?.value
    : undefined
  const name = Array.isArray(resource.name)
    ? (resource.name[0] as { text?: unknown } | undefined)?.text
    : undefined
  const clinicalName = typeof name === 'string'
    ? name.replace(/^合成(?:候选|密度)?患者/, '').replace(/^Synthetic\s+(?:candidate\s+)?patient\s+/i, '')
    : ''
  const address = patientAddressText(resource)
  return {
    ...(address === undefined ? {} : { address }),
    ...(typeof resource.birthDate === 'string' ? { birthDate: resource.birthDate } : {}),
    ...(typeof resource.gender === 'string' ? { gender: resource.gender } : {}),
    id: resource.id,
    identifier: typeof identifier === 'string' ? identifier : '',
    name: clinicalName,
    synthetic: true,
    versionId: resource.meta?.versionId ?? '1',
  }
}

function presentationFromTriage(value: z.infer<typeof triageRecordContentSchema>) {
  return clinicalPresentationSchema.parse({
    chiefComplaint: value.chiefComplaint,
    summary: value.chiefComplaint,
    vitalSigns: {
      bloodPressure: value.bloodPressure,
      oxygenSaturationPct: value.oxygenSaturationPct,
      pulseBpm: value.pulseBpm,
      respirationBpm: value.respirationBpm,
      temperatureC: value.temperatureC,
    },
  })
}

export function casePresentation(triage: z.infer<typeof triageRecordContentSchema> | undefined) {
  if (triage !== undefined) {
    return presentationFromTriage(triage)
  }
  return null
}

export function xhtmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function xhtmlTextValue(value: string): string | undefined {
  const prefix = '<div xmlns="http://www.w3.org/1999/xhtml">'
  const suffix = '</div>'
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return undefined
  return value.slice(prefix.length, -suffix.length)
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&')
}

export function localFhirReferences(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(localFhirReferences)
  if (typeof value !== 'object' || value === null) return []
  const record = value as Record<string, unknown>
  const reference = typeof record.reference === 'string'
    && /^[A-Z][A-Za-z]+\/[A-Za-z0-9.-]{1,64}$/.test(record.reference)
    ? [record.reference]
    : []
  return [...reference, ...Object.values(record).flatMap(localFhirReferences)]
}

export function legacyDiagnosisReferenceFromComposition(resource: FhirResource): string | undefined {
  const composition = structuredCompositionSectionSchema.safeParse(resource)
  if (!composition.success) return undefined
  return composition.data.section
    .find(section => section.title === '诊断')
    ?.entry?.find(entry => entry.reference.startsWith('Condition/'))
    ?.reference
}

export function consultationTurnDto(row: z.infer<typeof consultationTurnRowSchema>): ConsultationTurnDto {
  return {
    actorId: row.actor_id,
    practitionerId: row.practitioner_id,
    id: row.turn_id,
    kind: row.kind,
    messageText: row.message_text,
    personaRevision: row.persona_revision,
    recordedAt: row.recorded_at,
    reportReference: row.report_reference,
    sequence: row.sequence,
    source: row.source,
    speaker: row.speaker,
  }
}

function allergyStatusCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const coding = (value as Record<string, unknown>).coding
  if (!Array.isArray(coding)) return undefined
  for (const candidate of coding) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const code = (candidate as Record<string, unknown>).code
    if (typeof code === 'string') return code
  }
  return undefined
}

export const recommendationMedicationPresentationSchema = scenarioProductMedicationCatalogItemSchema.pick({
  availableScopes: true,
  drugConcept: true,
  product: true,
  regulatoryVerification: true,
}).partial().strip()

export type DoctorRecommendationMedicationCatalogItem = Extract<
  ClinicalCatalog,
  { prescriptionConclusionSupported: true }
>['medications'][number] & z.infer<typeof recommendationMedicationPresentationSchema>

export interface OutpatientPrescriptionTransactionPort {
  applySavePrescriptionDraft(
    transaction: CommandTransaction,
    input: {
      context: ActorContext
      encounterId: string
      expectedDraftVersion: number
      expectedVersions: Record<string, string>
      idempotencyKey: string
      items: PrescriptionDraftItem[]
    },
  ): {
    data: z.infer<typeof prescriptionDraftResponseSchema.shape.data>
    effects: CommandEffect[]
  }
  applyIssuePrescription(
    transaction: CommandTransaction,
    input: {
      context: ActorContext
      encounterId: string
      expectedDraftVersion: number
      expectedVersions: Record<string, string>
      idempotencyKey: string
    },
  ): {
    data: z.infer<typeof issuePrescriptionResponseSchema.shape.data>
    effects: CommandEffect[]
  }
}

export interface OutpatientLaboratoryTransactionPort {
  applySaveLaboratoryRequestDraft(
    transaction: CommandTransaction,
    input: {
      catalogItemId: LaboratoryRequestCatalogItemId
      context: ActorContext
      encounterId: string
      expectedDraftVersion: number
      expectedVersions: Record<string, string>
      idempotencyKey: string
      indicationCode: string
    },
  ): {
    data: z.infer<typeof laboratoryRequestDraftResponseSchema.shape.data>
    effects: CommandEffect[]
  }
  applyDeleteLaboratoryRequestDraft(
    transaction: CommandTransaction,
    input: {
      context: ActorContext
      encounterId: string
      expectedDraftVersion: number
      expectedVersions: Record<string, string>
      idempotencyKey: string
    },
  ): {
    data: z.infer<typeof laboratoryRequestDraftResponseSchema.shape.data>
    effects: CommandEffect[]
  }
  applyIssueLaboratoryRequest(
    transaction: CommandTransaction,
    input: {
      context: ActorContext
      encounterId: string
      expectedDraftVersion: number
      expectedVersions: Record<string, string>
      idempotencyKey: string
    },
  ): {
    data: z.infer<typeof issueLaboratoryRequestResponseSchema.shape.data>
    effects: CommandEffect[]
  }
}

export interface ImagingWorkflowPort {
  serviceCatalog(
    context: ActorContext,
    readyExamCodes: ReadonlySet<ImagingExamCode>,
  ): z.infer<typeof caseImagingServiceCatalogSchema>
  state(context: ActorContext, caseId: string): z.infer<typeof imagingRequestStateSchema>
  applySaveDraft(
    transaction: CommandTransaction,
    input: {
      context: ActorContext
      encounterId: string
      expectedDraftVersion: number
      expectedVersions: Record<string, string>
      idempotencyKey: string
      indication: string
      serviceId: string
    },
  ): {
    data: z.infer<typeof imagingRequestDraftResponseSchema.shape.data>
    effects: CommandEffect[]
  }
  applyDeleteDraft(
    transaction: CommandTransaction,
    input: {
      context: ActorContext
      encounterId: string
      expectedDraftVersion: number
      expectedVersions: Record<string, string>
      idempotencyKey: string
    },
  ): {
    data: z.infer<typeof imagingRequestDraftResponseSchema.shape.data>
    effects: CommandEffect[]
  }
  applyIssue(
    transaction: CommandTransaction,
    input: {
      context: ActorContext
      encounterId: string
      expectedDraftVersion: number
      expectedVersions: Record<string, string>
      idempotencyKey: string
      readyExamCodes: ReadonlySet<ImagingExamCode>
    },
  ): {
    data: z.infer<typeof issueImagingRequestResponseSchema.shape.data>
    effects: CommandEffect[]
  }
}

export interface PathologyWorkflowPort {
  serviceCatalog(
    context: ActorContext,
    readyExamCodes: ReadonlySet<PathologyExamCode>,
    sourceProcedures: ReadonlyMap<PathologyExamCode, PathologySourceProcedure[]>,
  ): z.infer<typeof casePathologyServiceCatalogSchema>
  applySaveDraft(
    transaction: CommandTransaction,
    input: {
      context: ActorContext
      encounterId: string
      expectedDraftVersion: number
      expectedVersions: Record<string, string>
      idempotencyKey: string
      purpose: string
      serviceId: string
      sourceProcedureReference: string
      sourceProcedures: ReadonlyMap<PathologyExamCode, PathologySourceProcedure[]>
    },
  ): {
    data: z.infer<typeof pathologyRequestDraftResponseSchema.shape.data>
    effects: CommandEffect[]
  }
  applyDeleteDraft(
    transaction: CommandTransaction,
    input: {
      context: ActorContext
      encounterId: string
      expectedDraftVersion: number
      expectedVersions: Record<string, string>
      idempotencyKey: string
    },
  ): {
    data: z.infer<typeof pathologyRequestDraftResponseSchema.shape.data>
    effects: CommandEffect[]
  }
  applyIssue(
    transaction: CommandTransaction,
    input: {
      context: ActorContext
      encounterId: string
      expectedDraftVersion: number
      expectedVersions: Record<string, string>
      idempotencyKey: string
      readyExamCodes: ReadonlySet<PathologyExamCode>
      sourceProcedures: ReadonlyMap<PathologyExamCode, PathologySourceProcedure[]>
    },
  ): {
    data: z.infer<typeof issuePathologyRequestResponseSchema.shape.data>
    effects: CommandEffect[]
  }
}

export interface DoctorRecommendationCaseSnapshot {
  diagnosis?: {
    draft?: z.infer<typeof diagnosisDraftContentSchema>
    draftVersion: number
  }
  encounter: {
    id: string
    status: unknown
    versionId: string | undefined
  }
  imagingRequests?: {
    draft?: unknown
    draftVersion: number
  }
  laboratoryRequests?: {
    draft?: unknown
    draftVersion: number
  }
  medicationConclusion?: {
    draft?: unknown
    draftVersion: number
  }
  pathologyRequests?: {
    draft?: unknown
    draftVersion: number
  }
}

export interface DoctorRecommendationsWorkflowPort
  extends OutpatientPrescriptionTransactionPort, OutpatientLaboratoryTransactionPort {
  readonly imaging: Pick<
    ImagingWorkflowPort,
    'serviceCatalog' | 'applyDeleteDraft' | 'applySaveDraft' | 'applyIssue'
  >
  readonly pathology: PathologyWorkflowPort
  doctorRecommendationCase(
    context: ActorContext,
    caseId: string,
    inactiveReason?: PrescriptionConflictReason,
  ): DoctorRecommendationCaseSnapshot
  doctorRecommendationHistory(
    context: ActorContext,
    caseId: string,
  ): DoctorCaseHistoryDetail[]
  doctorRecommendationMedications(
    context: ActorContext,
  ): DoctorRecommendationMedicationCatalogItem[]
  clinicalCatalog(context: ActorContext): ClinicalCatalog
  caseLaboratoryCatalog(
    context: ActorContext,
    caseId: string,
    input: { page: number; pageSize: number; query?: string },
  ): z.infer<typeof caseLaboratoryCatalogSearchSchema>
  applySaveDiagnosisDraft(
    transaction: CommandTransaction,
    input: {
      context: ActorContext
      encounterId: string
      entries: DiagnosisDraftEntry[]
      expectedDraftVersion: number
      expectedVersions: Record<string, string>
      idempotencyKey: string
    },
  ): {
    data: z.infer<typeof diagnosisDraftResponseSchema.shape.data>
    effects: CommandEffect[]
  }
  applyConfirmDiagnosis(
    transaction: CommandTransaction,
    input: {
      context: ActorContext
      encounterId: string
      expectedDraftVersion: number
      expectedVersions: Record<string, string>
      idempotencyKey: string
    },
  ): {
    data: z.infer<typeof confirmDiagnosisResponseSchema.shape.data>
    effects: CommandEffect[]
  }
}

export interface InpatientInvestigationsWorkflowPort
  extends Pick<OutpatientLaboratoryTransactionPort, 'applySaveLaboratoryRequestDraft' | 'applyIssueLaboratoryRequest'> {
  readonly imaging: Pick<ImagingWorkflowPort, 'state' | 'applySaveDraft' | 'applyIssue'>
  inpatientLaboratoryRequests(context: ActorContext, admissionId: string): LaboratoryRequest[]
}

export class OutpatientWorkflowContext {
  readonly commands: CommandExecutor
  readonly database: ClinMeshDatabase
  readonly fhir: FhirRepository
  readonly investigation: InvestigationCapabilityResolver | undefined
  readonly now: () => Date
  readonly outpatientBilling: OutpatientInvestigationBilling
  readonly payments: PaymentLedger
  readonly referenceData: ReferenceDataService | undefined
  readonly requests: ClinicalRequestKernel
  readonly #tokenSecret: string

  constructor(options: {
    commands: CommandExecutor
    database: ClinMeshDatabase
    fhir: FhirRepository
    investigation?: InvestigationCapabilityResolver
    now: () => Date
    outpatientBilling: OutpatientInvestigationBilling
    payments: PaymentLedger
    referenceData?: ReferenceDataService
    requests: ClinicalRequestKernel
    tokenSecret: string
  }) {
    this.commands = options.commands
    this.database = options.database
    this.fhir = options.fhir
    this.investigation = options.investigation
    this.now = options.now
    this.outpatientBilling = options.outpatientBilling
    this.payments = options.payments
    this.referenceData = options.referenceData
    this.requests = options.requests
    this.#tokenSecret = options.tokenSecret
  }

  hashToken(value: string): string {
    return createHmac('sha256', this.#tokenSecret).update(value).digest('hex')
  }

  actorContextHash(context: ActorContext): string {
    return this.hashToken(JSON.stringify([
      context.workspaceId,
      context.epoch,
      context.scenarioRunId,
      context.actorId,
      context.roleCode,
      context.practitionerId ?? null,
      context.practitionerRoleId ?? null,
      context.organizationId ?? null,
      context.locationId ?? null,
    ]))
  }

  virtualTime(context: ActorContext): string {
    const row = this.database.driver.prepare(`
      SELECT virtual_time FROM scenario_epoch_state
      WHERE workspace_id = ? AND epoch = ? AND scenario_run_id = ?
    `).get(context.workspaceId, context.epoch, context.scenarioRunId) as { virtual_time: string } | undefined
    if (row === undefined) throw new WorkflowError('WORKFLOW_CONFLICT', 'The active virtual clock is unavailable')
    return row.virtual_time
  }

  assertRole(context: ActorContext, roles: readonly string[]): void {
    if (!roles.includes(context.roleCode)) {
      throw new WorkflowError('ROLE_NOT_ALLOWED', 'The active Practitioner Role cannot perform this action')
    }
  }

  requiredPractitionerRoleId(context: ActorContext): string {
    if (context.practitionerRoleId === undefined) {
      throw new WorkflowError('ROLE_NOT_ALLOWED', 'An active Practitioner Role is required')
    }
    return context.practitionerRoleId
  }

  assertExpectedVersions(expectedVersions: Record<string, string>, references: string[]): void {
    const missing = references.filter(reference => expectedVersions[reference] === undefined)
    if (missing.length > 0) {
      throw new WorkflowError(
        'WORKFLOW_CONFLICT',
        `Expected versions are required for ${missing.join(', ')}`,
      )
    }
  }

  expectedVersionWorkflowError(
    error: ExpectedVersionConflictError,
    options: {
      code: WorkflowError['code']
      currentStatus: NonNullable<ApiConflict['currentStatus']>
      message: string
      owner: ApiConflict['owner']
      resource: string
    },
  ): WorkflowError {
    return new WorkflowError(options.code, options.message, {
      currentStatus: options.currentStatus,
      ...(error.currentVersion === undefined
        ? {}
        : { currentVersion: error.currentVersion }),
      expectedVersion: error.expectedVersion,
      owner: options.owner,
      resource: error.reference ?? options.resource,
    })
  }

  assignCaseResponsibility(context: ActorContext, caseId: string, assignedAt: string): void {
    const practitionerRoleId = this.requiredPractitionerRoleId(context)
    this.database.driver.prepare(`
      INSERT INTO outpatient_case_responsibility (
        workspace_id, epoch, case_id, practitioner_role_id, assigned_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, epoch, case_id) DO NOTHING
    `).run(
      context.workspaceId,
      context.epoch,
      caseId,
      practitionerRoleId,
      assignedAt,
    )
    this.assertCaseResponsibility(context, caseId)
  }

  assertCaseResponsibility(context: ActorContext, caseId: string): void {
    const responsibility = practitionerRoleIdRowSchema.optional().parse(
      this.database.driver.prepare(`
        SELECT practitioner_role_id
        FROM outpatient_case_responsibility
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(context.workspaceId, context.epoch, caseId),
    )
    if (responsibility?.practitioner_role_id !== this.requiredPractitionerRoleId(context)) {
      throw new WorkflowError('ROLE_NOT_ALLOWED', 'The outpatient case belongs to another doctor')
    }
  }

  hasCaseResponsibility(context: ActorContext, caseId: string): boolean {
    return this.database.driver.prepare(`
      SELECT 1 FROM outpatient_case_responsibility
      WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND practitioner_role_id = ?
    `).get(context.workspaceId, context.epoch, caseId, context.practitionerRoleId) !== undefined
  }

  activeCaseByPatient(context: ActorContext, patientId: string) {
    return activeOutpatientCaseRowSchema.optional().parse(this.database.driver.prepare(`
      SELECT case_id, registration_id, encounter_id, initial_task_id, doctor_task_id, status
      FROM outpatient_case
      WHERE workspace_id = ? AND epoch = ? AND patient_id = ? AND status != 'completed'
    `).get(context.workspaceId, context.epoch, patientId))
  }

  requireDoctorCase(context: ActorContext, caseId: string): void {
    this.assertRole(context, ['outpatient-doctor'])
    const row = this.database.driver.prepare(`
      SELECT 1 AS present
      FROM outpatient_case
      JOIN fhir_resource AS patient
        ON patient.workspace_id = outpatient_case.workspace_id
       AND patient.epoch = outpatient_case.epoch
       AND patient.resource_type = 'Patient'
       AND patient.resource_id = outpatient_case.patient_id
      JOIN fhir_resource AS encounter
        ON encounter.workspace_id = outpatient_case.workspace_id
       AND encounter.epoch = outpatient_case.epoch
       AND encounter.resource_type = 'Encounter'
       AND encounter.resource_id = outpatient_case.encounter_id
      JOIN fhir_resource AS task
        ON task.workspace_id = outpatient_case.workspace_id
       AND task.epoch = outpatient_case.epoch
       AND task.resource_type = 'Task'
       AND task.resource_id = outpatient_case.doctor_task_id
      WHERE outpatient_case.workspace_id = ? AND outpatient_case.epoch = ?
        AND outpatient_case.case_id = ?
    `).get(context.workspaceId, context.epoch, caseId)
    if (row === undefined) throw new WorkflowError('WORKFLOW_CONFLICT', 'The outpatient case was not found')
  }

  caseByEncounter(context: ActorContext, encounterId: string): OutpatientCaseRow {
    const row = caseEncounterRowSchema.optional().parse(this.database.driver.prepare(`
      SELECT case_id, patient_id, encounter_id, account_id, doctor_task_id, status
      FROM outpatient_case
      WHERE workspace_id = ? AND epoch = ? AND encounter_id = ?
    `).get(context.workspaceId, context.epoch, encounterId))
    if (row === undefined) throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter was not found')
    return row
  }

  catalogItem(context: ActorContext, itemId: string, kind: string): CatalogRow {
    const row = this.database.driver.prepare(`
      SELECT code, item_id, name_zh, name_en, price_fen, version, config_json
      FROM outpatient_catalog
      WHERE workspace_id = ? AND epoch = ? AND item_id = ? AND kind = ? AND active = 1
    `).get(context.workspaceId, context.epoch, itemId, kind) as CatalogRow | undefined
    if (row === undefined) throw new WorkflowError('CATALOG_CONFLICT', 'The catalog item is unavailable')
    return row
  }

  diagnosisState(context: ActorContext, caseId: string) {
    return diagnosisStateRowSchema.optional().parse(
      this.database.driver.prepare(`
        SELECT version, status, draft_json FROM diagnosis_state
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(context.workspaceId, context.epoch, caseId),
    )
  }

  confirmedDiagnoses(context: ActorContext, caseId: string): DiagnosisConfirmation | undefined {
    const confirmation = diagnosisConfirmationRowSchema.optional().parse(
      this.database.driver.prepare(`
        SELECT confirmation_id, provenance_id, confirmed_at, revision_number,
          supersedes_confirmation_id
        FROM diagnosis_confirmation
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        ORDER BY revision_number DESC
        LIMIT 1
      `).get(context.workspaceId, context.epoch, caseId),
    )
    if (confirmation === undefined) return undefined
    const entries = z.array(diagnosisEntryRowSchema).parse(
      this.database.driver.prepare(`
        SELECT ordinal, condition_id, catalog_item_id, role
        FROM diagnosis_entry
        WHERE workspace_id = ? AND epoch = ? AND confirmation_id = ?
        ORDER BY ordinal
      `).all(
        context.workspaceId,
        context.epoch,
        confirmation.confirmation_id,
      ),
    ).map((entry) => {
      const resource = this.fhir.read(context, 'Condition', entry.condition_id)
      const condition = confirmedDiagnosisConditionSchema.parse(resource)
      const coding = condition.code.coding[0]
      if (coding === undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The confirmed diagnosis is incomplete')
      }
      const note = condition.note?.[0]?.text
      return {
        catalogItemId: entry.catalog_item_id,
        code: coding.code,
        conditionId: entry.condition_id,
        conditionVersion: resource.meta?.versionId ?? '1',
        display: coding.display,
        ...(note === undefined ? {} : { note }),
        role: entry.role,
        system: coding.system,
      }
    })
    return {
      confirmedAt: confirmation.confirmed_at,
      entries,
      id: confirmation.confirmation_id,
      provenanceId: confirmation.provenance_id,
      revisionNumber: confirmation.revision_number,
      ...(confirmation.supersedes_confirmation_id === null
        ? {}
        : { supersedesConfirmationId: confirmation.supersedes_confirmation_id }),
    }
  }

  #diagnosisCatalogItem(context: ActorContext, itemId: string) {
    const row = diagnosisCatalogRowSchema.optional().parse(
      this.database.driver.prepare(`
        SELECT item_id, code_system, code, name_zh, name_en, version
        FROM diagnosis_catalog
        WHERE workspace_id = ? AND epoch = ? AND item_id = ? AND active = 1
      `).get(context.workspaceId, context.epoch, itemId),
    )
    if (row === undefined) {
      throw new WorkflowError('CATALOG_CONFLICT', 'The diagnosis catalog item is unavailable')
    }
    return row
  }

  resolvedDiagnosisSelection(
    context: ActorContext,
    entry: DiagnosisDraftEntry,
  ): DiagnosisDraftEntry {
    const { referenceConcept: _untrustedReference, ...draftEntry } = entry
    const reference = this.referenceData?.diagnosisById(context, entry.catalogItemId)
    if (reference !== undefined) {
      return {
        ...draftEntry,
        referenceConcept: referenceConceptSnapshotSchema.parse({
          code: reference.code,
          display: reference.display,
          id: reference.id,
          sourceLocator: reference.sourceLocator,
          system: reference.system,
          version: reference.version,
        }),
      }
    }
    const catalog = this.#diagnosisCatalogItem(context, entry.catalogItemId)
    return {
      ...draftEntry,
      referenceConcept: referenceConceptSnapshotSchema.parse({
        code: catalog.code,
        display: catalog.name_zh,
        id: catalog.item_id,
        sourceLocator: 'operational:diagnosis_catalog',
        system: catalog.code_system,
        version: String(catalog.version),
      }),
    }
  }

  assertNoIndependentDiagnosisOwner(context: ActorContext, caseId: string): void {
    const diagnosisState = this.database.driver.prepare(`
      SELECT 1 AS present FROM diagnosis_state
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
    `).get(context.workspaceId, context.epoch, caseId)
    if (diagnosisState !== undefined) {
      throw new WorkflowError(
        'WORKFLOW_CONFLICT',
        'The independent diagnosis state already owns diagnosis editing',
      )
    }
  }

  assertNoLegacyDiagnosisOwner(context: ActorContext, caseId: string): void {
    const legacyDraft = this.database.driver.prepare(`
      SELECT 1 AS present FROM clinical_draft
      WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND draft_kind = 'revisit'
    `).get(context.workspaceId, context.epoch, caseId)
    if (legacyDraft !== undefined) {
      throw new WorkflowError(
        'WORKFLOW_CONFLICT',
        'The legacy revisit draft already owns diagnosis editing',
      )
    }
  }

  assertNoIndependentPrescriptionOwner(context: ActorContext, caseId: string): void {
    const prescriptionState = this.database.driver.prepare(`
      SELECT 1 AS present FROM prescription_draft_state
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
    `).get(context.workspaceId, context.epoch, caseId)
    if (prescriptionState !== undefined) {
      throw new WorkflowError(
        'WORKFLOW_CONFLICT',
        'The independent prescription state already owns prescription editing',
      )
    }
  }

  assertNoLegacyPrescriptionOwner(context: ActorContext, caseId: string): void {
    const legacyDraft = this.database.driver.prepare(`
      SELECT 1 AS present FROM clinical_draft
      WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND draft_kind = 'revisit'
    `).get(context.workspaceId, context.epoch, caseId)
    if (legacyDraft !== undefined) {
      throw new WorkflowError(
        'WORKFLOW_CONFLICT',
        'The legacy revisit draft already owns prescription editing',
      )
    }
  }

  consultationState(context: ActorContext, caseId: string) {
    return consultationStateRowSchema.optional().parse(
      this.database.driver.prepare(`
        SELECT version FROM consultation
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(context.workspaceId, context.epoch, caseId),
    )
  }

  hasConsultation(context: ActorContext, caseId: string): boolean {
    return this.consultationState(context, caseId) !== undefined
  }

  consultationTurnRows(context: ActorContext, caseId: string) {
    return z.array(consultationTurnRowSchema).parse(
      this.database.driver.prepare(`
        SELECT turn_id, case_id, sequence, speaker, kind, source, actor_id, practitioner_id,
          message_text, persona_revision, report_reference, recorded_at
        FROM consultation_turn
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        ORDER BY sequence
      `).all(context.workspaceId, context.epoch, caseId),
    )
  }

  consultationSnapshot(context: ActorContext, caseId: string) {
    const state = this.consultationState(context, caseId)
    if (state === undefined) return undefined
    const turns = this.consultationTurnRows(context, caseId).map(row => consultationTurnDto(row))
    const lastDoctorTurn = turns.findLast(turn => turn.kind === 'text' && turn.speaker === 'doctor')
    const replyAttempt = lastDoctorTurn === undefined ? undefined
      : consultationReplyProjection(this.database, context, lastDoctorTurn.id)
    return {
      turns,
      version: state.version,
      ...(replyAttempt === undefined ? {} : { replyAttempt }),
    }
  }

  prescriptionChargeLines(context: ActorContext, sourceReference: string) {
    const prescriptionId = sourceReference.startsWith('Prescription/')
      ? sourceReference.slice('Prescription/'.length)
      : ''
    const rows = this.database.driver.prepare(`
      SELECT item.medication_request_id, item.quantity, catalog.name_zh,
        catalog.name_en, catalog.price_fen
      FROM prescription_item AS item
      JOIN outpatient_catalog AS catalog
        ON catalog.workspace_id = item.workspace_id
       AND catalog.epoch = item.epoch
       AND catalog.item_id = item.medication_id
      WHERE item.workspace_id = ? AND item.epoch = ? AND item.prescription_id = ?
      ORDER BY item.medication_request_id
    `).all(context.workspaceId, context.epoch, prescriptionId) as Array<{
      medication_request_id: string
      name_en: string
      name_zh: string
      price_fen: number
      quantity: number
    }>
    if (rows.length === 0) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription charge has no medication lines')
    }
    return rows.map(row => ({
      descriptionEn: row.name_en,
      descriptionZh: row.name_zh,
      quantity: row.quantity,
      sourceReference: `MedicationRequest/${row.medication_request_id}`,
      subtotalFen: row.price_fen * row.quantity,
      unitPriceFen: row.price_fen,
    }))
  }

  #patientAllergies(context: ActorContext, patientId: string): FhirResource[] {
    const parameters = new URLSearchParams({
      _count: '100',
      patient: `Patient/${patientId}`,
    })
    return this.fhir.search(context, 'AllergyIntolerance', parameters).resources.filter(allergy => {
      const category = Array.isArray(allergy.category) ? allergy.category : []
      const clinicalStatus = allergyStatusCode(allergy.clinicalStatus)
      const verificationStatus = allergyStatusCode(allergy.verificationStatus)
      return category.includes('medication')
        && clinicalStatus === 'active'
        && verificationStatus === 'confirmed'
    })
  }

  patientAllergyCodes(context: ActorContext, patientId: string): Set<string> {
    return new Set(this.#patientAllergies(context, patientId).flatMap(allergy => {
      const code = typeof allergy.code === 'object' && allergy.code !== null
        ? allergy.code as Record<string, unknown>
        : undefined
      const coding = Array.isArray(code?.coding) ? code.coding : []
      return coding.flatMap(candidate => {
        if (typeof candidate !== 'object' || candidate === null) return []
        const value = (candidate as Record<string, unknown>).code
        return typeof value === 'string' ? [value] : []
      })
    }))
  }

  patientAllergyWarnings(context: ActorContext, patientId: string): Array<{ code: string; display: string }> {
    return this.#patientAllergies(context, patientId).flatMap(allergy => {
      const concept = typeof allergy.code === 'object' && allergy.code !== null
        ? allergy.code as Record<string, unknown>
        : {}
      const coding = Array.isArray(concept.coding) ? concept.coding : []
      const firstCoding = coding.find(candidate => typeof candidate === 'object' && candidate !== null)
      const codingRecord = firstCoding as Record<string, unknown> | undefined
      const code = codingRecord?.code
      const display = concept.text ?? codingRecord?.display ?? code
      return typeof code === 'string' && typeof display === 'string' ? [{ code, display }] : []
    })
  }
}
