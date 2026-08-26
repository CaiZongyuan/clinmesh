import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import { fhirResourceSchema, type FhirResource } from '@clinmesh/contracts/fhir'
import {
  scenarioDatasetContentSchema,
  type ScenarioDatasetContent,
} from '@clinmesh/contracts/scenario'
import {
  acknowledgeLaboratoryReportResponseSchema,
  type ApiConflict,
  askConsultationQuestionResponseSchema,
  laboratoryRequestActionResponseSchema,
  type ClinicalDocumentContent,
  clinicalDocumentContentSchema,
  clinicalDocumentDraftResponseSchema,
  clinicalDocumentSignPreviewResponseSchema,
  clinicalDocumentSignResponseSchema,
  clinicalPresentationSchema,
  clinicalDocumentRevisionResponseSchema,
  clinicalSignPreviewResponseSchema,
  clinicalSignResponseSchema,
  confirmDiagnosisResponseSchema,
  confirmNoMedicationResponseSchema,
  correctLaboratoryReportResponseSchema,
  createPatientResponseSchema,
  diagnosisDraftContentSchema,
  diagnosisDraftResponseSchema,
  type DiagnosisDraftEntry,
  type DiagnosisConfirmation,
  dispenseResponseSchema,
  doctorCompletedCaseDetailSchema,
  doctorCompletedCaseListSchema,
  doctorCompletedCaseTimelineEventSchema,
  encounterCompletionPreviewSchema,
  encounterCompletionResponseSchema,
  type EncounterCompletionTarget,
  firstVisitDraftResponseSchema,
  issuedPrescriptionSchema,
  issueLaboratoryRequestResponseSchema,
  issuePrescriptionResponseSchema,
  laboratoryOrderResponseSchema,
  laboratoryReportSchema,
  laboratoryRequestDraftResponseSchema,
  laboratoryRequestSchema,
  laboratoryResultMeasurementSchema,
  type LaboratoryRequestCatalogItemId,
  paymentPreviewResponseSchema,
  paymentResponseSchema,
  type PatientSummary,
  noMedicationConclusionSchema,
  prescriptionDraftContentSchema,
  prescriptionDraftResponseSchema,
  type PrescriptionDraftItem,
  prescriptionWithdrawalSchema,
  prescriptionReviewResponseSchema,
  registrationStatusSchema,
  registrationResponseSchema,
  revisitDraftResponseSchema,
  startVirtualPatientResponseSchema,
  startVisitResponseSchema,
  triageResponseSchema,
  virtualPatientListSchema,
  withdrawPrescriptionResponseSchema,
} from '@clinmesh/contracts/his'
import { z } from 'zod'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { FhirRepository } from '../infrastructure/sqlite/fhir-repository.ts'
import type { ActorContext, CommandEffect, CommandResponse, CommandTransaction } from './command-executor.ts'
import {
  CommandExecutor,
  ExpectedVersionConflictError,
  provenanceAgents,
} from './command-executor.ts'
import {
  resolveScenarioInvestigation,
  type ScenarioInvestigationResolution,
} from './scenario-data/scenario-investigation-resolver.ts'

export class WorkflowError extends Error {
  readonly code: 'CATALOG_CONFLICT' | 'DIAGNOSIS_PRIMARY_REQUIRED' | 'DUPLICATE_PATIENT' | 'ENCOUNTER_COMPLETION_BLOCKED' | 'LABORATORY_REQUEST_DUPLICATE' | 'LABORATORY_REQUEST_NOT_CANCELLABLE' | 'LABORATORY_REQUEST_VERSION_CONFLICT' | 'ROLE_NOT_ALLOWED' | 'WORKFLOW_CONFLICT'
  readonly conflict: ApiConflict | undefined
  readonly status: 403 | 409

  constructor(
    code: 'CATALOG_CONFLICT' | 'DIAGNOSIS_PRIMARY_REQUIRED' | 'DUPLICATE_PATIENT' | 'ENCOUNTER_COMPLETION_BLOCKED' | 'LABORATORY_REQUEST_DUPLICATE' | 'LABORATORY_REQUEST_NOT_CANCELLABLE' | 'LABORATORY_REQUEST_VERSION_CONFLICT' | 'ROLE_NOT_ALLOWED' | 'WORKFLOW_CONFLICT',
    message: string,
    conflict?: ApiConflict,
  ) {
    super(message)
    this.name = 'WorkflowError'
    this.code = code
    this.conflict = conflict
    this.status = code === 'ROLE_NOT_ALLOWED' ? 403 : 409
  }
}

interface CatalogRow {
  code: string
  config_json?: string
  item_id: string
  name_en: string
  name_zh: string
  price_fen: number
  version: number
}

const diagnosisCatalogRowSchema = z.object({
  code: z.string().min(1),
  code_system: z.string().url(),
  item_id: z.string().min(1),
  name_en: z.string().min(1),
  name_zh: z.string().min(1),
  version: z.number().int().positive(),
})

const diagnosisStateRowSchema = z.object({
  draft_json: z.string().nullable(),
  status: z.enum(['draft', 'confirmed']),
  version: z.number().int().positive(),
})

const diagnosisConfirmationRowSchema = z.object({
  confirmation_id: z.string().min(1),
  confirmed_at: z.string().datetime({ offset: true }),
  provenance_id: z.string().min(1),
})

const diagnosisEntryRowSchema = z.object({
  catalog_item_id: z.string().min(1),
  condition_id: z.string().min(1),
  ordinal: z.number().int().positive(),
  role: z.enum(['primary', 'secondary']),
})

const confirmedDiagnosisCatalogItemRowSchema = z.object({
  catalog_item_id: z.string().min(1),
})

const prescriptionDraftStateRowSchema = z.object({
  draft_json: z.string().nullable(),
  version: z.number().int().positive(),
})

const noMedicationConclusionRowSchema = z.object({
  authored_at: z.string().datetime({ offset: true }),
  authored_by_actor_id: z.string().min(1),
  authored_by_practitioner_role_id: z.string().min(1),
  conclusion_id: z.string().min(1),
  version: z.number().int().positive(),
})

const prescriptionWithdrawalRowSchema = z.object({
  version: z.number().int().positive(),
  withdrawal_id: z.string().min(1),
  withdrawn_at: z.string().datetime({ offset: true }),
  withdrawn_by_actor_id: z.string().min(1),
  withdrawn_by_practitioner_role_id: z.string().min(1),
})

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

const activePrescriptionRowSchema = z.object({
  withdrawal_id: z.string().nullable(),
})

const withdrawablePrescriptionRowSchema = activePrescriptionRowSchema.extend({
  status: prescriptionStatusRowSchema,
  version: z.number().int().positive(),
})

const prescriptionWithdrawalLookupRowSchema = withdrawablePrescriptionRowSchema.extend({
  case_id: z.string().min(1),
})

const prescriptionWorkflowRowSchema = withdrawablePrescriptionRowSchema.extend({
  case_status: outpatientCaseStatusRowSchema,
  encounter_id: z.string().min(1),
})

const prescriptionDispenseWorkflowRowSchema = prescriptionWorkflowRowSchema.extend({
  case_id: z.string().min(1),
  patient_id: z.string().min(1),
  prescription_id: z.string().min(1),
  prescription_number: z.string().min(1),
  review_id: z.string().min(1).nullable(),
  scenario_run_id: z.string().min(1),
})

const prescriptionDispensingRowSchema = z.object({
  dispensed_quantity: z.number().int().nonnegative(),
  medication_request_id: z.string().min(1),
})

const issuedPrescriptionRowSchema = z.object({
  authored_at: z.string().datetime({ offset: true }),
  authored_by_practitioner_role_id: z.string().min(1).nullable(),
  prescription_id: z.string().min(1),
  prescription_number: z.string().min(1),
  status: z.enum(['dispensed', 'paid', 'signed']),
  version: z.number().int().positive(),
})

const issuedPrescriptionItemRowSchema = z.object({
  course_days: z.number().int().positive(),
  dose_text: z.string().min(1),
  frequency_code: z.string().min(1),
  medication_id: z.string().min(1),
  medication_request_id: z.string().min(1),
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

const paymentChargeRowSchema = paymentWorkflowRowSchema.extend({
  charge_id: z.string().min(1),
  charge_item_id: z.string().min(1),
  status: chargeStatusRowSchema,
  total_fen: z.number().int().nonnegative(),
  version: z.number().int().positive(),
})

const paymentPreviewRowSchema = paymentWorkflowRowSchema.extend({
  account_id: z.string().min(1),
  amount_fen: z.number().int().nonnegative(),
  case_id: z.string().min(1),
  category: z.enum(['laboratory', 'medication']),
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
  token_hash: z.string().min(1),
})

const issuedMedicationRequestSchema = z.object({
  medication: z.object({
    reference: z.object({
      display: z.string().min(1).optional(),
      reference: z.string().min(1),
    }),
  }),
  requester: z.object({ reference: z.string().regex(/^PractitionerRole\/[A-Za-z0-9._-]+$/) }),
})

interface MedicationRuleSelection {
  catalogItemId: string
  configJson: string | undefined
  doseText: string
  frequencyCode: string
}

const legacyMedicationCatalogConfigSchema = z.object({
  allowedCombinationIds: z.array(z.string().min(1)),
  allowedDoseTexts: z.array(z.string().min(1)).min(1),
  allowedFrequencyCodes: z.array(z.string().min(1)).min(1),
  dose: z.string().min(1),
  frequency: z.string().min(1),
})

const prescriptionMedicationCatalogConfigSchema = legacyMedicationCatalogConfigSchema.extend({
  allowedCourseDays: z.array(z.number().int().positive()).min(1),
  allowedDiagnosisCatalogItemIds: z.array(z.string().min(1)).min(1),
  allowedQuantities: z.array(z.number().int().positive()).min(1),
  defaultCourseDays: z.number().int().positive(),
  defaultQuantity: z.number().int().positive(),
})

const medicationCatalogConfigRowSchema = z.object({
  config_json: z.string().min(1),
})

const laboratoryCatalogConfigSchema = z.object({
  allowedIndicationCodes: z.array(z.string().min(1)).min(1),
  contraindicatedAllergyCodes: z.array(z.string().min(1)),
})

const triageRecordContentSchema = z.object({
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

const countRowSchema = z.object({ count: z.number().int().nonnegative() })

const virtualPatientRowSchema = z.object({
  available: z.union([z.literal(0), z.literal(1)]),
  clinical_summary_json: z.string(),
  patient_id: z.string().min(1),
  version: z.number().int().positive(),
  virtual_patient_id: z.string().min(1),
})

const virtualPatientListRowSchema = virtualPatientRowSchema.extend({
  patient_json: z.string(),
})

const consultationStateRowSchema = z.object({
  version: z.number().int().positive(),
  virtual_patient_id: z.string().min(1),
})

const consultationQuestionRowSchema = z.object({
  question_code: z.string().min(1),
  question_text: z.string().min(1),
})

const consultationQuestionRuleRowSchema = consultationQuestionRowSchema.extend({
  answer_text: z.string().min(1),
  fact_code: z.string().min(1).nullable(),
  revealed_answer_text: z.string().min(1).nullable(),
  rule_version: z.number().int().positive(),
}).refine(
  row => (row.fact_code === null) === (row.revealed_answer_text === null),
  { message: 'Consultation question reveal fields must be present together' },
)

const consultationRecordRowSchema = z.object({
  answer_text: z.string().min(1),
  question_code: z.string().min(1),
  question_text: z.string().min(1),
  record_id: z.string().min(1),
  recorded_at: z.string().min(1),
  sequence: z.number().int().positive(),
})

const laboratoryRequestRowSchema = z.object({
  catalog_item_id: laboratoryRequestSchema.shape.catalogItemId,
  diagnostic_report_id: z.string().min(1).nullable(),
  execution_task_id: z.string().min(1),
  indication_code: z.string().min(1),
  request_id: z.string().min(1),
  service_request_id: z.string().min(1),
  status: laboratoryRequestSchema.shape.status,
  version: z.number().int().positive(),
})

const laboratoryRequestCommandRowSchema = laboratoryRequestRowSchema.extend({
  authored_by: z.string().min(1),
  case_id: z.string().min(1),
  encounter_id: z.string().min(1),
  patient_id: z.string().min(1),
})

const laboratoryRequestSystemResponseSchema = z.object({
  requestId: z.string().min(1),
  status: z.enum(['accepted', 'cancelled', 'in-progress']),
}).strict()

const laboratoryReportSystemResponseSchema = z.object({
  diagnosticReportId: z.string().min(1),
  requestId: z.string().min(1),
  status: z.literal('reported'),
}).strict()

const laboratoryReportAcknowledgementRowSchema = z.object({
  acknowledgement_id: z.string().min(1),
  acknowledged_at: z.string().datetime({ offset: true }),
  acknowledged_by: z.string().min(1),
  diagnostic_report_id: z.string().min(1),
  request_id: z.string().min(1),
  request_version: z.number().int().positive(),
}).strict()

const laboratoryReportRevisionRowSchema = z.object({
  diagnostic_report_id: z.string().min(1),
  provenance_id: z.string().min(1),
  reason: z.string().min(1),
  request_id: z.string().min(1),
  revision_of_diagnostic_report_id: z.string().min(1),
}).strict()

const laboratoryResultsFactSchema = z.object({
  'lab-cbc': z.object({
    conclusion: z.string().min(1),
    results: z.array(laboratoryResultMeasurementSchema).min(1),
  }).strict(),
  'lab-crp': z.object({
    conclusion: z.string().min(1),
    results: z.array(laboratoryResultMeasurementSchema).min(1),
  }).strict(),
}).strict()

function ucumCode(unit: string): string {
  return unit
    .replace('10^9', '10*9')
    .replace('10^12', '10*12')
    .replace('μmol', 'umol')
}

function scenarioLaboratoryResultFact(
  content: ScenarioDatasetContent,
  resolution: ScenarioInvestigationResolution,
) {
  const results = (resolution.components ?? [resolution]).map((component) => {
    if (component.result.outcome !== 'reported') {
      throw new Error(`Investigation ${component.itemId} did not produce a laboratory result`)
    }
    const catalogItem = content.catalog.investigations.find(item => item.id === component.itemId)
    if (catalogItem === undefined) throw new Error(`Investigation ${component.itemId} was not found`)
    const referenceRange = catalogItem.referenceRanges.find(
      range => range.appliesToGender === 'any',
    ) ?? catalogItem.referenceRanges[0]
    if (referenceRange === undefined) {
      throw new Error(`Investigation ${component.itemId} has no reference range`)
    }
    return {
      code: catalogItem.code,
      display: catalogItem.name,
      interpretation: component.result.flag === 'H'
        ? 'high'
        : component.result.flag === 'L' ? 'low' : 'normal',
      referenceRange: {
        ...(referenceRange.maximum === undefined ? {} : { high: referenceRange.maximum }),
        ...(referenceRange.minimum === undefined ? {} : { low: referenceRange.minimum }),
        text: referenceRange.text,
      },
      ...(catalogItem.unit === undefined ? {} : {
        unit: {
          code: ucumCode(catalogItem.unit),
          display: catalogItem.unit,
          system: 'http://unitsofmeasure.org' as const,
        },
      }),
      value: component.result.value,
    }
  })
  return { conclusion: resolution.report, results }
}

const laboratoryRequestStateRowSchema = z.object({
  draft_catalog_item_id: laboratoryRequestSchema.shape.catalogItemId.nullable(),
  draft_indication_code: z.string().min(1).nullable(),
  version: z.number().int().positive(),
}).strict().refine(
  row => (row.draft_catalog_item_id === null) === (row.draft_indication_code === null),
  { message: 'Laboratory request draft fields must be present together' },
)

const encounterCompletionResourceSchema = fhirResourceSchema.extend({
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

const signedClinicalDocumentRowSchema = z.object({
  bundle_id: z.string().min(1),
  composition_id: z.string().min(1),
  document_id: z.string().min(1),
  provenance_id: z.string().min(1),
  revision_of_document_id: z.string().min(1).nullable(),
  signed_at: z.iso.datetime({ offset: true }),
}).strict()

const draftDeletionTraceRowSchema = z.object({
  effect_json: z.string(),
  operation: z.enum([
    'encounter.delete-prescription-draft',
    'laboratory-request.delete-draft',
  ]),
  trace_id: z.string().min(1),
  virtual_timestamp: z.iso.datetime({ offset: true }),
}).strict()

const actionTraceEffectSchema = z.object({
  kind: z.enum(['created', 'updated']),
  reference: z.string().regex(/^[A-Z][A-Za-z]+\/[A-Za-z0-9.-]+$/),
  versionId: z.string().regex(/^\d+$/),
}).strict()

const virtualPatientVersionPayloadSchema = z.object({
  epoch: z.string().min(1),
  expectedVersions: z.record(z.string(), z.string()),
  virtualPatientId: z.string().min(1),
  virtualPatientVersion: z.number().int().positive(),
  workspaceId: z.string().min(1),
}).strict()

const virtualPatientVersionTokenPrefix = 'v1'
const virtualPatientVersionPayloadBytes = 1_024
const virtualPatientVersionTokenAad = Buffer.from('clinmesh.virtual-patient-version.v1')

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

type ActiveOutpatientCaseRow = z.infer<typeof activeOutpatientCaseRowSchema>

interface VirtualPatientIntake {
  caseId: string
  effects: CommandEffect[]
  encounterId: string
  queueTaskId: string
  registrationId: string
}

const diagnosisDraftSchema = z.object({
  code: z.string(),
  display: z.string(),
})

const firstVisitDraftContentSchema = z.object({
  assessment: z.string(),
  historyOfPresentIllness: z.string(),
})

const revisitDraftContentSchema = z.object({
  conditionId: z.string().min(1),
  diagnosis: diagnosisDraftSchema,
})

const documentDraftContentSchema = z.object({
  assessment: z.string(),
  composition: fhirResourceSchema.refine(resource => resource.resourceType === 'Composition'),
  diagnosis: diagnosisDraftSchema,
  medicationRequestIds: z.array(z.string().min(1)),
  plan: z.string(),
})

const clinicalSignExpectedVersionsSchema = z.object({
  documentDraft: z.number().int().positive(),
  prescription: z.number().int().positive(),
  revisitDraft: z.number().int().positive(),
})

const respiratoryPathogenFactSchema = z.object({
  code: z.string().min(1),
  detected: z.boolean(),
})

const priorConditionSchema = z.object({
  clinicalStatus: z.object({
    coding: z.array(z.object({ code: z.string().optional() }).loose()).optional(),
  }).loose().optional(),
  code: z.object({
    coding: z.array(z.object({
      code: z.string().optional(),
      display: z.string().optional(),
    }).loose()).optional(),
    text: z.string().optional(),
  }).loose().optional(),
  encounter: z.object({ reference: z.string().optional() }).loose().optional(),
  recordedDate: z.string().optional(),
}).loose()

const confirmedDiagnosisConditionSchema = z.object({
  code: z.object({
    coding: z.array(z.object({
      code: z.string().min(1),
      display: z.string().min(1),
      system: z.string().url(),
    }).loose()).min(1),
  }).loose(),
  note: z.array(z.object({ text: z.string().min(1) }).loose()).optional(),
}).loose()

const diagnosticReportContentSchema = z.object({
  result: z.array(z.object({ reference: z.string().min(1) }).loose()).optional(),
  status: z.string().min(1),
}).loose()

const observationResultContentSchema = z.object({
  code: z.object({
    coding: z.array(z.object({ code: z.string().optional() }).loose()).optional(),
  }).loose().optional(),
  interpretation: z.array(z.object({
    coding: z.array(z.object({ code: z.string().optional() }).loose()).optional(),
  }).loose()).optional(),
  referenceRange: z.array(z.object({ text: z.string().optional() }).loose()).optional(),
  valueBoolean: z.boolean().optional(),
  valueQuantity: z.object({
    unit: z.string().optional(),
    value: z.number().optional(),
  }).loose().optional(),
  valueString: z.string().optional(),
}).loose()

const laboratoryDiagnosticReportContentSchema = z.object({
  basedOn: z.array(z.object({ reference: z.string().min(1) }).loose()).min(1),
  conclusion: z.string().min(1),
  issued: z.string().datetime({ offset: true }),
  result: z.array(z.object({ reference: z.string().min(1) }).loose()).min(1),
  specimen: z.array(z.object({ reference: z.string().min(1) }).loose()).min(1),
  status: z.literal('final'),
}).loose()

const laboratoryObservationContentSchema = z.object({
  basedOn: z.array(z.object({ reference: z.string().min(1) }).loose()).min(1),
  code: z.object({
    coding: z.array(z.object({
      code: z.string().min(1),
      display: z.string().min(1),
    }).loose()).min(1),
  }).loose(),
  interpretation: z.array(z.object({
    coding: z.array(z.object({ code: z.enum(['N', 'H', 'L']) }).loose()).min(1),
  }).loose()).min(1),
  referenceRange: z.array(z.object({
    high: z.object({ value: z.number().finite() }).loose().optional(),
    low: z.object({ value: z.number().finite() }).loose().optional(),
    text: z.string().min(1),
  }).loose()).min(1),
  specimen: z.object({ reference: z.string().min(1) }).loose(),
  valueBoolean: z.boolean().optional(),
  valueQuantity: z.object({
    code: z.string().min(1),
    system: z.literal('http://unitsofmeasure.org'),
    unit: z.string().min(1),
    value: z.number().finite(),
  }).loose().optional(),
  valueString: z.string().min(1).optional(),
}).loose().refine(value => (
  Number(value.valueBoolean !== undefined)
  + Number(value.valueQuantity !== undefined)
  + Number(value.valueString !== undefined)
) === 1, { message: 'Laboratory Observation must contain exactly one supported value' })

const lisOrderDataSchema = z.object({
  diagnosticReportId: z.string().min(1),
  encounterVersion: z.string().min(1),
  status: z.literal('awaiting-revisit'),
})

function parseStoredFhirResource(content: string): FhirResource {
  return fhirResourceSchema.parse(JSON.parse(content))
}

function patientSummary(resource: FhirResource): PatientSummary {
  const identifier = Array.isArray(resource.identifier)
    ? (resource.identifier[0] as { value?: unknown } | undefined)?.value
    : undefined
  const name = Array.isArray(resource.name)
    ? (resource.name[0] as { text?: unknown } | undefined)?.text
    : undefined
  const clinicalName = typeof name === 'string'
    ? name.replace(/^合成(?:候选|密度)?患者/, '').replace(/^Synthetic\s+(?:candidate\s+)?patient\s+/i, '')
    : ''
  return {
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

function casePresentation(
  triage: z.infer<typeof triageRecordContentSchema> | undefined,
  virtualPatientJson: string | null,
) {
  if (triage !== undefined) {
    return presentationFromTriage(triage)
  }
  if (virtualPatientJson !== null) {
    return clinicalPresentationSchema.parse(JSON.parse(virtualPatientJson))
  }
  throw new WorkflowError('WORKFLOW_CONFLICT', 'The outpatient case has no clinical presentation')
}

function xhtmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const clinicalDocumentSectionSystem = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/clinical-document-section'
const clinicalDocumentBundleIdentifierSystem = 'https://caizongyuan.github.io/clinmesh/fhir/identifier/clinical-document-bundle'
const fhirCanonicalBase = 'https://caizongyuan.github.io/clinmesh/fhir'

const clinicalDocumentSections = [
  { code: 'chief-complaint', field: 'chiefComplaint', title: '主诉' },
  { code: 'history-of-present-illness', field: 'historyOfPresentIllness', title: '现病史' },
  { code: 'prior-medical-history', field: 'priorMedicalHistory', title: '既往史' },
  { code: 'physical-examination', field: 'physicalExamination', title: '查体' },
  { code: 'auxiliary-examination', field: 'auxiliaryExamination', title: '辅助检查' },
  { code: 'assessment', field: 'assessment', title: '评估' },
  { code: 'disposition', field: 'disposition', title: '处置' },
  { code: 'follow-up', field: 'followUp', title: '随访' },
] as const

function structuredClinicalDocumentSections(document: ClinicalDocumentContent) {
  return clinicalDocumentSections.flatMap(section => {
    const value = document[section.field]
    if (value === undefined) return []
    return [{
    code: {
      coding: [{
        code: section.code,
        display: section.title,
        system: clinicalDocumentSectionSystem,
      }],
      text: section.title,
    },
    text: {
      div: `<div xmlns="http://www.w3.org/1999/xhtml">${xhtmlText(value)}</div>`,
      status: 'generated',
    },
      title: section.title,
    }]
  })
}

function clinicalDocumentRevisionDefinition(
  revision: { assessment: string; plan: string } | { document: ClinicalDocumentContent },
  reason: string,
) {
  const reasonSection = {
    title: '更正原因',
    text: {
      status: 'generated',
      div: `<div xmlns="http://www.w3.org/1999/xhtml">${xhtmlText(reason)}</div>`,
    },
  }
  if ('document' in revision) {
    return {
      kind: 'structured' as const,
      payload: { document: revision.document },
      sections: [reasonSection, ...structuredClinicalDocumentSections(revision.document)],
      title: '门诊结构化病历修订',
    }
  }
  return {
    kind: 'legacy' as const,
    payload: { assessment: revision.assessment, plan: revision.plan },
    sections: [
      reasonSection,
      {
        title: '评估',
        text: {
          status: 'generated',
          div: `<div xmlns="http://www.w3.org/1999/xhtml">${xhtmlText(revision.assessment)}</div>`,
        },
      },
      {
        title: '计划',
        text: {
          status: 'generated',
          div: `<div xmlns="http://www.w3.org/1999/xhtml">${xhtmlText(revision.plan)}</div>`,
        },
      },
    ],
    title: '门诊病历更正',
  }
}

function xhtmlTextValue(value: string): string | undefined {
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

const structuredCompositionSchema = z.object({
  section: z.array(z.object({
    code: z.object({
      coding: z.array(z.object({
        code: z.string(),
        system: z.string(),
      }).loose()),
    }).loose().optional(),
    entry: z.array(z.object({ reference: z.string().min(1) }).loose()).optional(),
    text: z.object({ div: z.string() }).loose(),
    title: z.string().optional(),
  }).loose()),
}).loose()

const legacyCompletedCaseLaboratoryRowSchema = z.object({
  diagnostic_report_id: z.string().min(1).nullable(),
  laboratory_task_id: z.string().min(1).nullable(),
  service_request_id: z.string().min(1).nullable(),
}).strict()

const completedCaseListRowSchema = z.object({
  case_id: z.string().min(1),
  encounter_json: z.string().min(1),
  patient_json: z.string().min(1),
}).strict()

const completedCaseDetailRowSchema = completedCaseListRowSchema.omit({ case_id: true }).strict()

const practitionerRoleIdRowSchema = z.object({
  practitioner_role_id: z.string().min(1),
}).strict()

const clinicalDocumentIdRowSchema = z.object({
  document_id: z.string().min(1),
}).strict()

const clinicalDocumentRevisionSourceRowSchema = practitionerRoleIdRowSchema.extend({
  bundle_id: z.string().min(1),
  document_id: z.string().min(1),
  encounter_id: z.string().min(1),
  patient_id: z.string().min(1),
}).strict()

const completedCaseSelectionSql = `
  FROM outpatient_case
  JOIN outpatient_case_responsibility AS responsibility
    ON responsibility.workspace_id = outpatient_case.workspace_id
   AND responsibility.epoch = outpatient_case.epoch
   AND responsibility.case_id = outpatient_case.case_id
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
  WHERE outpatient_case.workspace_id = ? AND outpatient_case.epoch = ?
    AND responsibility.practitioner_role_id = ?
    AND json_extract(encounter.content_json, '$.status') = 'completed'
    AND json_extract(encounter.content_json, '$.actualPeriod.end') IS NOT NULL
    AND (? IS NULL OR outpatient_case.patient_id = ?)
    AND (
      ? IS NULL
      OR substr(json_extract(encounter.content_json, '$.actualPeriod.end'), 1, 10) >= ?
    )
    AND (
      ? IS NULL
      OR substr(json_extract(encounter.content_json, '$.actualPeriod.end'), 1, 10) <= ?
    )
    AND (
      ? IS NULL
      OR EXISTS (
        SELECT 1
        FROM diagnosis_confirmation
        JOIN diagnosis_entry
          ON diagnosis_entry.workspace_id = diagnosis_confirmation.workspace_id
         AND diagnosis_entry.epoch = diagnosis_confirmation.epoch
         AND diagnosis_entry.confirmation_id = diagnosis_confirmation.confirmation_id
        WHERE diagnosis_confirmation.workspace_id = outpatient_case.workspace_id
          AND diagnosis_confirmation.epoch = outpatient_case.epoch
          AND diagnosis_confirmation.case_id = outpatient_case.case_id
          AND diagnosis_entry.catalog_item_id = ?
      )
      OR EXISTS (
        SELECT 1
        FROM signed_clinical_document AS legacy_document
        JOIN fhir_resource AS legacy_composition
          ON legacy_composition.workspace_id = legacy_document.workspace_id
         AND legacy_composition.epoch = legacy_document.epoch
         AND legacy_composition.resource_type = 'Composition'
         AND legacy_composition.resource_id = legacy_document.composition_id
        JOIN diagnosis_catalog AS legacy_catalog
          ON legacy_catalog.workspace_id = legacy_document.workspace_id
         AND legacy_catalog.epoch = legacy_document.epoch
         AND legacy_catalog.item_id = ?
        JOIN fhir_resource AS legacy_condition
          ON legacy_condition.workspace_id = legacy_document.workspace_id
         AND legacy_condition.epoch = legacy_document.epoch
         AND legacy_condition.resource_type = 'Condition'
         AND legacy_condition.resource_id = substr(
           (
             SELECT json_extract(legacy_entry.value, '$.reference')
             FROM json_each(legacy_composition.content_json, '$.section') AS legacy_section
             JOIN json_each(legacy_section.value, '$.entry') AS legacy_entry
             WHERE json_extract(legacy_section.value, '$.title') = '诊断'
               AND json_extract(legacy_entry.value, '$.reference') LIKE 'Condition/%'
             LIMIT 1
           ),
           length('Condition/') + 1
         )
        WHERE legacy_document.workspace_id = outpatient_case.workspace_id
          AND legacy_document.epoch = outpatient_case.epoch
          AND legacy_document.case_id = outpatient_case.case_id
          AND json_extract(legacy_condition.content_json, '$.code.coding[0].system')
            = legacy_catalog.code_system
          AND json_extract(legacy_condition.content_json, '$.code.coding[0].code')
            = legacy_catalog.code
      )
    )
`

const completedCaseServiceRequestSchema = z.object({
  authoredOn: z.iso.datetime({ offset: true }),
  code: z.object({
    concept: z.object({ text: z.string().min(1) }).loose(),
  }).loose(),
  meta: z.object({ versionId: z.string().regex(/^\d+$/) }).loose(),
  reason: z.array(z.object({
    concept: z.object({
      coding: z.array(z.object({ code: z.string().min(1) }).loose()).min(1),
    }).loose(),
  }).loose()).min(1),
  resourceType: z.literal('ServiceRequest'),
}).loose()

const completedCaseDiagnosticReportSchema = z.object({
  conclusion: z.string().min(1),
  issued: z.iso.datetime({ offset: true }),
  meta: z.object({ versionId: z.string().regex(/^\d+$/) }).loose(),
  resourceType: z.literal('DiagnosticReport'),
  result: z.array(z.object({ reference: z.string().min(1) }).loose()).min(1),
  specimen: z.array(z.object({ reference: z.string().min(1) }).loose()).min(1),
  status: z.literal('final'),
}).loose()

const completedCaseObservationSchema = z.object({
  code: z.object({
    coding: z.array(z.object({
      code: z.string().min(1),
      display: z.string().min(1).optional(),
    }).loose()).min(1),
  }).loose(),
  interpretation: z.array(z.object({
    coding: z.array(z.object({ code: z.string().min(1) }).loose()).min(1),
  }).loose()).optional(),
  referenceRange: z.array(z.object({
    high: z.object({ value: z.number().finite() }).loose().optional(),
    low: z.object({ value: z.number().finite() }).loose().optional(),
    text: z.string().min(1).optional(),
  }).loose()).optional(),
  resourceType: z.literal('Observation'),
  valueBoolean: z.boolean().optional(),
  valueQuantity: z.object({
    code: z.string().min(1).optional(),
    system: z.string().url().optional(),
    unit: z.string().min(1).optional(),
    value: z.number().finite(),
  }).loose().optional(),
  valueString: z.string().optional(),
}).loose()

const provenanceReasonSchema = z.object({
  reason: z.array(z.object({
    concept: z.object({ text: z.string().optional() }).loose(),
  }).loose()).optional(),
}).loose()

const documentBundleEntrySchema = z.object({
  fullUrl: z.string().optional(),
  resource: fhirResourceSchema,
}).loose()

function localFhirReferences(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(localFhirReferences)
  if (typeof value !== 'object' || value === null) return []
  const record = value as Record<string, unknown>
  const reference = typeof record.reference === 'string'
    && /^[A-Z][A-Za-z]+\/[A-Za-z0-9.-]{1,64}$/.test(record.reference)
    ? [record.reference]
    : []
  return [...reference, ...Object.values(record).flatMap(localFhirReferences)]
}

function structuredClinicalDocumentFromComposition(resource: FhirResource): ClinicalDocumentContent | undefined {
  const composition = structuredCompositionSchema.safeParse(resource)
  if (!composition.success) return undefined
  const sections = new Map(composition.data.section.flatMap(section => {
    const coding = section.code?.coding.find(candidate => candidate.system === clinicalDocumentSectionSystem)
    const value = xhtmlTextValue(section.text.div)
    return coding === undefined || value === undefined ? [] : [[coding.code, value] as const]
  }))
  const content = Object.fromEntries(clinicalDocumentSections.flatMap(section => {
    const value = sections.get(section.code)
    return value === undefined ? [] : [[section.field, value]]
  }))
  const parsed = clinicalDocumentContentSchema.safeParse(content)
  return parsed.success ? parsed.data : undefined
}

function legacyClinicalDocumentFromComposition(resource: FhirResource) {
  const composition = structuredCompositionSchema.safeParse(resource)
  if (!composition.success) return undefined
  const sections = new Map(composition.data.section.flatMap(section => {
    const value = xhtmlTextValue(section.text.div)
    return section.title === undefined || value === undefined ? [] : [[section.title, value] as const]
  }))
  const parsed = z.object({
    assessment: z.string().trim().min(2).max(4_000),
    plan: z.string().trim().min(2).max(4_000),
  }).strict().safeParse({
    assessment: sections.get('评估'),
    plan: sections.get('计划'),
  })
  return parsed.success ? parsed.data : undefined
}

function legacyDiagnosisReferenceFromComposition(resource: FhirResource): string | undefined {
  const composition = structuredCompositionSchema.safeParse(resource)
  if (!composition.success) return undefined
  return composition.data.section
    .find(section => section.title === '诊断')
    ?.entry?.find(entry => entry.reference.startsWith('Condition/'))
    ?.reference
}

function completedCaseInterpretation(code: string | undefined): string | undefined {
  if (code === undefined) return undefined
  return ({ H: 'high', L: 'low', N: 'normal', NEG: 'negative', POS: 'positive' } as const)[
    code as 'H' | 'L' | 'N' | 'NEG' | 'POS'
  ] ?? code
}

export class WorkflowService {
  readonly #commands: CommandExecutor
  readonly #database: ClinMeshDatabase
  readonly #fhir: FhirRepository
  readonly #now: () => Date
  readonly #tokenSecret: string
  readonly #virtualPatientVersionTokenKey: Buffer

  constructor(
    database: ClinMeshDatabase,
    fhir: FhirRepository,
    commands: CommandExecutor,
    options: { now?: () => Date; tokenSecret: string },
  ) {
    this.#commands = commands
    this.#database = database
    this.#fhir = fhir
    this.#now = options.now ?? (() => new Date())
    this.#tokenSecret = options.tokenSecret
    this.#virtualPatientVersionTokenKey = createHash('sha256')
      .update('clinmesh.virtual-patient-version.v1\0')
      .update(options.tokenSecret)
      .digest()
  }

  registrationCatalog(context: ActorContext) {
    this.#assertRole(context, ['registrar'])
    const rows = this.#database.driver.prepare(`
      SELECT item_id, name_zh, name_en, price_fen, version, kind
      FROM outpatient_catalog
      WHERE workspace_id = ? AND epoch = ?
        AND kind IN ('department', 'visit-type') AND active = 1
      ORDER BY kind, item_id
    `).all(context.workspaceId, context.epoch) as Array<CatalogRow & { kind: string }>
    const virtualTime = this.#virtualTime(context)
    const locations = this.#fhir.search(
      context,
      'Location',
      new URLSearchParams({ _count: '100' }),
    ).resources.filter(location => this.#isRegistrationLocation(location))
    return {
      departments: rows.filter(row => row.kind === 'department').map(row => ({
        id: row.item_id,
        nameEn: row.name_en,
        nameZh: row.name_zh,
        version: row.version,
      })),
      locations: locations.map(location => ({
        id: location.id,
        nameEn: Array.isArray(location.alias) && typeof location.alias[0] === 'string'
          ? location.alias[0]
          : String(location.name ?? ''),
        nameZh: String(location.name ?? ''),
        version: Number(location.meta?.versionId ?? '1'),
      })),
      virtualDate: virtualTime.slice(0, 10),
      visitTypes: rows.filter(row => row.kind === 'visit-type').map(row => ({
        id: row.item_id,
        nameEn: row.name_en,
        nameZh: row.name_zh,
        priceFen: row.price_fen,
        version: row.version,
      })),
    }
  }

  clinicalCatalog(context: ActorContext) {
    this.#assertRole(context, ['outpatient-doctor'])
    const rows = this.#database.driver.prepare(`
      SELECT item_id, name_zh, name_en, price_fen, version, kind, config_json
      FROM outpatient_catalog
      WHERE workspace_id = ? AND epoch = ?
        AND kind IN ('laboratory', 'medication') AND active = 1
      ORDER BY kind, item_id
    `).all(context.workspaceId, context.epoch) as Array<
      CatalogRow & { config_json: string; kind: 'laboratory' | 'medication' }
    >
    const summary = (row: CatalogRow) => ({
      id: row.item_id,
      nameEn: row.name_en,
      nameZh: row.name_zh,
      priceFen: row.price_fen,
      version: row.version,
    })
    const diagnoses = z.array(diagnosisCatalogRowSchema).parse(
      this.#database.driver.prepare(`
        SELECT item_id, code_system, code, name_zh, name_en, version
        FROM diagnosis_catalog
        WHERE workspace_id = ? AND epoch = ? AND active = 1
        ORDER BY item_id
      `).all(context.workspaceId, context.epoch),
    )
    const catalog = {
      diagnoses: diagnoses.map(diagnosis => ({
        code: diagnosis.code,
        id: diagnosis.item_id,
        nameEn: diagnosis.name_en,
        nameZh: diagnosis.name_zh,
        system: diagnosis.code_system,
        version: diagnosis.version,
      })),
      laboratory: rows.filter(row => row.kind === 'laboratory').map(row => {
        const config = laboratoryCatalogConfigSchema.parse(JSON.parse(row.config_json) as unknown)
        return { ...summary(row), ...config }
      }),
    }
    const medications = rows.filter(row => row.kind === 'medication').map(row => {
      const rawConfig = JSON.parse(row.config_json) as unknown
      return {
        config: legacyMedicationCatalogConfigSchema.parse(rawConfig),
        rawConfig,
        row,
      }
    })
    const prescriptionConclusionSupported = this.#prescriptionConclusionSupported(
      medications.map(({ rawConfig }) => rawConfig),
    )
    if (!prescriptionConclusionSupported) {
      return {
        ...catalog,
        medications: medications.map(({ config, row }) => ({
          ...summary(row),
          allowedCombinationIds: config.allowedCombinationIds,
          allowedDoseTexts: config.allowedDoseTexts,
          allowedFrequencyCodes: config.allowedFrequencyCodes,
          defaultDoseText: config.dose,
          defaultFrequencyCode: config.frequency,
        })),
        prescriptionConclusionSupported: false as const,
      }
    }
    return {
      ...catalog,
      medications: medications.map(({ rawConfig, row }) => {
        const config = prescriptionMedicationCatalogConfigSchema.parse(rawConfig)
        return {
          ...summary(row),
          allowedCombinationIds: config.allowedCombinationIds,
          allowedCourseDays: config.allowedCourseDays,
          allowedDoseTexts: config.allowedDoseTexts,
          allowedFrequencyCodes: config.allowedFrequencyCodes,
          allowedQuantities: config.allowedQuantities,
          defaultCourseDays: config.defaultCourseDays,
          defaultDoseText: config.dose,
          defaultFrequencyCode: config.frequency,
          defaultQuantity: config.defaultQuantity,
        }
      }),
      prescriptionConclusionSupported: true as const,
    }
  }

  registrationQueue(context: ActorContext, pageSize: number, page = 1) {
    this.#assertRole(context, ['registrar'])
    const total = this.#database.driver.prepare(`
      SELECT COUNT(*) AS count FROM outpatient_case
      WHERE workspace_id = ? AND epoch = ?
    `).get(context.workspaceId, context.epoch) as { count: number }
    const rows = this.#database.driver.prepare(`
      SELECT outpatient_case.case_id, outpatient_case.encounter_id,
        outpatient_case.status, outpatient_case.initial_task_id,
        outpatient_case.arrived_at, registration.registration_id,
        registration.registration_number, registration.status AS registration_status,
        patient.content_json AS patient_json,
        encounter.version_id AS encounter_version, task.version_id AS task_version
      FROM outpatient_case
      JOIN registration
        ON registration.workspace_id = outpatient_case.workspace_id
       AND registration.epoch = outpatient_case.epoch
       AND registration.registration_id = outpatient_case.registration_id
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
       AND task.resource_id = outpatient_case.initial_task_id
      WHERE outpatient_case.workspace_id = ? AND outpatient_case.epoch = ?
      ORDER BY outpatient_case.arrived_at DESC, outpatient_case.case_id
      LIMIT ? OFFSET ?
    `).all(context.workspaceId, context.epoch, pageSize, (page - 1) * pageSize) as Array<{
      arrived_at: string
      case_id: string
      encounter_id: string
      encounter_version: number
      patient_json: string
      registration_id: string
      registration_number: string
      registration_status: string
      status: string
      task_version: number
      initial_task_id: string
    }>
    return {
      items: rows.map(row => ({
        arrivedAt: row.arrived_at,
        caseId: row.case_id,
        encounterId: row.encounter_id,
        encounterVersion: String(row.encounter_version),
        patient: patientSummary(parseStoredFhirResource(row.patient_json)),
        registrationId: row.registration_id,
        registrationNumber: row.registration_number,
        registrationStatus: registrationStatusSchema.parse(row.registration_status),
        status: row.status,
        taskId: row.initial_task_id,
        taskVersion: String(row.task_version),
      })),
      page,
      pageSize,
      total: total.count,
    }
  }

  createPatient(input: {
    context: ActorContext
    expectedVersions: Record<string, string>
    idempotencyKey: string
    patient: {
      birthDate: string
      gender: 'female' | 'male' | 'other' | 'unknown'
      identifier: string
      name: string
    }
  }): CommandResponse<{ patient: PatientSummary }> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: createPatientResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: input.patient,
      operation: 'patient.create-synthetic',
    }, transaction => {
      this.#assertRole(input.context, ['registrar'])
      const duplicate = this.#database.driver.prepare(`
        SELECT 1 AS present
        FROM fhir_sp_string
        WHERE workspace_id = ? AND epoch = ? AND resource_type = 'Patient'
          AND param = 'identifier' AND exact_value = ?
      `).get(input.context.workspaceId, input.context.epoch, input.patient.identifier)
      if (duplicate !== undefined) {
        throw new WorkflowError('DUPLICATE_PATIENT', 'The synthetic patient identifier already exists')
      }
      const patient = transaction.fhir.create(input.context, {
        resourceType: 'Patient',
        id: uuidv7(),
        extension: [{
          url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/synthetic-data',
          valueBoolean: true,
        }],
        identifier: [{
          system: 'https://caizongyuan.github.io/clinmesh/fhir/synthetic-patient-id',
          value: input.patient.identifier,
        }],
        name: [{ text: input.patient.name }],
        gender: input.patient.gender,
        birthDate: input.patient.birthDate,
        active: true,
      })
      return {
        data: { patient: patientSummary(patient) },
        effects: [{
          kind: 'created',
          reference: `Patient/${patient.id}`,
          versionId: patient.meta?.versionId ?? '1',
        }],
      }
    })
  }

  searchPatients(input: {
    context: ActorContext
    page: number
    pageSize: number
    query: string
  }): { items: PatientSummary[]; page: number; pageSize: number; total: number } {
    this.#assertRole(input.context, ['registrar', 'triage-nurse', 'outpatient-doctor', 'cashier', 'pharmacist'])
    const normalized = input.query.normalize('NFKC').toLocaleLowerCase()
    const escaped = normalized.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
    const bindings = [input.context.workspaceId, input.context.epoch, `${escaped}%`, `${escaped}%`]
    const total = this.#database.driver.prepare(`
      SELECT COUNT(*) AS count
      FROM fhir_resource AS resource
      WHERE resource.workspace_id = ? AND resource.epoch = ?
        AND resource.resource_type = 'Patient' AND resource.deleted = 0
        AND (
          EXISTS (
            SELECT 1 FROM fhir_sp_string AS lookup
            WHERE lookup.workspace_id = resource.workspace_id
              AND lookup.epoch = resource.epoch
              AND lookup.resource_type = resource.resource_type
              AND lookup.resource_id = resource.resource_id
              AND lookup.param IN ('name', 'identifier')
              AND lookup.normalized LIKE ? ESCAPE '\\'
          )
          OR EXISTS (
            SELECT 1 FROM registration
            WHERE registration.workspace_id = resource.workspace_id
              AND registration.epoch = resource.epoch
              AND registration.patient_id = resource.resource_id
              AND LOWER(registration.registration_number) LIKE ? ESCAPE '\\'
          )
        )
    `).get(...bindings) as { count: number }
    const rows = this.#database.driver.prepare(`
      SELECT resource.content_json
      FROM fhir_resource AS resource
      WHERE resource.workspace_id = ? AND resource.epoch = ?
        AND resource.resource_type = 'Patient' AND resource.deleted = 0
        AND (
          EXISTS (
            SELECT 1 FROM fhir_sp_string AS lookup
            WHERE lookup.workspace_id = resource.workspace_id
              AND lookup.epoch = resource.epoch
              AND lookup.resource_type = resource.resource_type
              AND lookup.resource_id = resource.resource_id
              AND lookup.param IN ('name', 'identifier')
              AND lookup.normalized LIKE ? ESCAPE '\\'
          )
          OR EXISTS (
            SELECT 1 FROM registration
            WHERE registration.workspace_id = resource.workspace_id
              AND registration.epoch = resource.epoch
              AND registration.patient_id = resource.resource_id
              AND LOWER(registration.registration_number) LIKE ? ESCAPE '\\'
          )
        )
      ORDER BY resource.last_updated DESC, resource.resource_id
      LIMIT ? OFFSET ?
    `).all(...bindings, input.pageSize, (input.page - 1) * input.pageSize) as Array<{
      content_json: string
    }>
    return {
      items: rows.map(row => patientSummary(parseStoredFhirResource(row.content_json))),
      page: input.page,
      pageSize: input.pageSize,
      total: total.count,
    }
  }

  register(input: {
    context: ActorContext
    expectedVersions: Record<string, string>
    idempotencyKey: string
    registration: {
      departmentId: string
      locationId: string
      patientId: string
      visitDate: string
      visitTypeId: string
    }
  }): CommandResponse<{
    accountId: string
    chargeItemId: string
    encounterId: string
    patientId: string
    queueTaskId: string
    registrationId: string
    status: 'awaiting-triage'
    totalFen: number
  }> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: registrationResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: input.registration,
      operation: 'registration.register',
    }, transaction => {
      this.#assertRole(input.context, ['registrar'])
      this.#assertExpectedVersions(input.expectedVersions, [`Patient/${input.registration.patientId}`])
      const patient = transaction.fhir.read(input.context, 'Patient', input.registration.patientId)
      const department = this.#catalogItem(input.context, input.registration.departmentId, 'department')
      const location = transaction.fhir.read(input.context, 'Location', input.registration.locationId)
      if (!this.#isRegistrationLocation(location)) {
        throw new WorkflowError('CATALOG_CONFLICT', 'The selected registration location is unavailable')
      }
      const visitType = this.#catalogItem(input.context, input.registration.visitTypeId, 'visit-type')
      if (input.registration.visitDate !== this.#virtualTime(input.context).slice(0, 10)) {
        throw new WorkflowError('CATALOG_CONFLICT', 'The visit date is outside the active virtual date')
      }
      if (this.#activeCaseByPatient(input.context, patient.id) !== undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The patient already has an active outpatient case')
      }
      const caseId = uuidv7()
      const registrationId = uuidv7()
      const encounterId = uuidv7()
      const queueTaskId = uuidv7()
      const accountId = uuidv7()
      const chargeItemId = uuidv7()
      const chargeId = uuidv7()
      const now = this.#virtualTime(input.context)
      const count = (this.#database.driver.prepare(`
        SELECT COUNT(*) AS count FROM registration
        WHERE workspace_id = ? AND epoch = ?
      `).get(input.context.workspaceId, input.context.epoch) as { count: number }).count + 1
      const registrationNumber = `CM-OP-${input.registration.visitDate.replaceAll('-', '')}-${String(count).padStart(4, '0')}`
      const encounter = transaction.fhir.create(input.context, {
        resourceType: 'Encounter',
        id: encounterId,
        identifier: [{
          system: 'https://caizongyuan.github.io/clinmesh/fhir/outpatient-encounter',
          value: registrationNumber,
        }],
        status: 'planned',
        class: [{
          coding: [{ code: 'AMB', display: 'ambulatory', system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode' }],
        }],
        subject: { reference: `Patient/${patient.id}` },
        serviceProvider: { reference: 'Organization/organization-clinmesh' },
        location: [{ location: { reference: `Location/${location.id}` }, status: 'active' }],
        actualPeriod: { start: now },
      })
      const task = transaction.fhir.create(input.context, {
        resourceType: 'Task',
        id: queueTaskId,
        status: 'requested',
        intent: 'order',
        code: { text: 'Outpatient triage' },
        for: { reference: `Patient/${patient.id}` },
        focus: { reference: `Encounter/${encounterId}` },
        owner: { reference: 'PractitionerRole/practitioner-role-triage-nurse' },
        authoredOn: now,
      })
      const account = transaction.fhir.create(input.context, {
        resourceType: 'Account',
        id: accountId,
        status: 'active',
        subject: [{ reference: `Patient/${patient.id}` }],
        servicePeriod: { start: now },
      })
      const chargeItem = transaction.fhir.create(input.context, {
        resourceType: 'ChargeItem',
        id: chargeItemId,
        status: 'billable',
        code: { text: visitType.name_zh },
        subject: { reference: `Patient/${patient.id}` },
        encounter: { reference: `Encounter/${encounterId}` },
        account: [{ reference: `Account/${accountId}` }],
        occurrenceDateTime: now,
        quantity: { value: 1 },
        unitPriceComponent: { amount: { currency: 'CNY', value: visitType.price_fen / 100 } },
      })
      this.#database.driver.prepare(`
        INSERT INTO outpatient_case (
          workspace_id, epoch, case_id, scenario_run_id, patient_id,
          registration_id, encounter_id, account_id, department_id, location_id,
          initial_task_id, status, arrived_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting-triage', ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        caseId,
        input.context.scenarioRunId,
        patient.id,
        registrationId,
        encounterId,
        accountId,
        department.item_id,
        location.id,
        queueTaskId,
        now,
        now,
      )
      this.#database.driver.prepare(`
        INSERT INTO registration (
          workspace_id, epoch, registration_id, case_id, registration_number,
          patient_id, encounter_id, visit_type_id, visit_date, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'registered', ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        registrationId,
        caseId,
        registrationNumber,
        patient.id,
        encounterId,
        visitType.item_id,
        input.registration.visitDate,
        now,
      )
      this.#database.driver.prepare(`
        INSERT INTO charge_record (
          workspace_id, epoch, charge_id, case_id, account_id, charge_item_id,
          category, source_reference, description_zh, description_en,
          quantity, unit_price_fen, total_fen, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'registration', ?, ?, ?, 1, ?, ?, 'billable', ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        chargeId,
        caseId,
        accountId,
        chargeItemId,
        `Registration/${registrationId}`,
        visitType.name_zh,
        visitType.name_en,
        visitType.price_fen,
        visitType.price_fen,
        now,
      )
      return {
        data: {
          accountId,
          chargeItemId,
          encounterId,
          patientId: patient.id,
          queueTaskId,
          registrationId,
          status: 'awaiting-triage' as const,
          totalFen: visitType.price_fen,
        },
        effects: [encounter, task, account, chargeItem].map(resource => ({
          kind: 'created' as const,
          reference: `${resource.resourceType}/${resource.id}`,
          versionId: resource.meta?.versionId ?? '1',
        })),
      }
    })
  }

  triageQueue(
    context: ActorContext,
    pageSize: number,
    status: 'completed' | 'exception' | 'pending' = 'pending',
    page = 1,
  ) {
    this.#assertRole(context, ['triage-nurse'])
    if (status === 'exception') return { items: [], page, pageSize, total: 0 }
    const queueCondition = status === 'pending'
      ? "outpatient_case.status = 'awaiting-triage'"
      : `outpatient_case.status != 'awaiting-triage'
        AND EXISTS (
          SELECT 1 FROM triage_record
          WHERE triage_record.workspace_id = outpatient_case.workspace_id
            AND triage_record.epoch = outpatient_case.epoch
            AND triage_record.case_id = outpatient_case.case_id
        )`
    const total = this.#database.driver.prepare(`
      SELECT COUNT(*) AS count FROM outpatient_case
      WHERE workspace_id = ? AND epoch = ? AND ${queueCondition}
    `).get(context.workspaceId, context.epoch) as { count: number }
    const rows = this.#database.driver.prepare(`
      SELECT outpatient_case.*, patient.content_json AS patient_json,
        registration.registration_number, registration.visit_type_id,
        department.name_zh AS department_name_zh,
        department.name_en AS department_name_en,
        visit_type.name_zh AS visit_type_name_zh,
        visit_type.name_en AS visit_type_name_en,
        location.content_json AS location_json,
        encounter.version_id AS encounter_version,
        task.version_id AS task_version
      FROM outpatient_case
      JOIN registration
        ON registration.workspace_id = outpatient_case.workspace_id
       AND registration.epoch = outpatient_case.epoch
       AND registration.registration_id = outpatient_case.registration_id
      JOIN fhir_resource AS patient
        ON patient.workspace_id = outpatient_case.workspace_id
       AND patient.epoch = outpatient_case.epoch
       AND patient.resource_type = 'Patient'
       AND patient.resource_id = outpatient_case.patient_id
      JOIN outpatient_catalog AS department
        ON department.workspace_id = outpatient_case.workspace_id
       AND department.epoch = outpatient_case.epoch
       AND department.item_id = outpatient_case.department_id
       AND department.kind = 'department'
      JOIN outpatient_catalog AS visit_type
        ON visit_type.workspace_id = registration.workspace_id
       AND visit_type.epoch = registration.epoch
       AND visit_type.item_id = registration.visit_type_id
       AND visit_type.kind = 'visit-type'
      JOIN fhir_resource AS location
        ON location.workspace_id = outpatient_case.workspace_id
       AND location.epoch = outpatient_case.epoch
       AND location.resource_type = 'Location'
       AND location.resource_id = outpatient_case.location_id
      JOIN fhir_resource AS encounter
        ON encounter.workspace_id = outpatient_case.workspace_id
       AND encounter.epoch = outpatient_case.epoch
       AND encounter.resource_type = 'Encounter'
       AND encounter.resource_id = outpatient_case.encounter_id
      JOIN fhir_resource AS task
        ON task.workspace_id = outpatient_case.workspace_id
       AND task.epoch = outpatient_case.epoch
       AND task.resource_type = 'Task'
       AND task.resource_id = outpatient_case.initial_task_id
      WHERE outpatient_case.workspace_id = ? AND outpatient_case.epoch = ?
        AND ${queueCondition}
      ORDER BY outpatient_case.arrived_at, outpatient_case.case_id
      LIMIT ? OFFSET ?
    `).all(context.workspaceId, context.epoch, pageSize, (page - 1) * pageSize) as Array<{
      arrived_at: string
      case_id: string
      department_id: string
      department_name_en: string
      department_name_zh: string
      encounter_id: string
      encounter_version: number
      location_json: string
      patient_json: string
      registration_number: string
      location_id: string
      status: string
      task_version: number
      initial_task_id: string
      visit_type_id: string
      visit_type_name_en: string
      visit_type_name_zh: string
    }>
    return {
      items: rows.map(row => {
        const location = parseStoredFhirResource(row.location_json)
        const patient = patientSummary(parseStoredFhirResource(row.patient_json))
        const locationNameZh = typeof location.name === 'string' ? location.name : row.location_id
        const locationAliases = Array.isArray(location.alias) ? location.alias : []
        const locationNameEn = locationAliases.find((alias): alias is string => typeof alias === 'string')
          ?? locationNameZh
        return {
          arrivedAt: row.arrived_at,
          caseId: row.case_id,
          department: {
            id: row.department_id,
            nameEn: row.department_name_en,
            nameZh: row.department_name_zh,
          },
          encounterId: row.encounter_id,
          encounterVersion: String(row.encounter_version),
          location: {
            id: row.location_id,
            nameEn: locationNameEn,
            nameZh: locationNameZh,
          },
          patient,
          registrationNumber: row.registration_number,
          riskFlags: this.#patientAllergyWarnings(context, patient.id),
          status: row.status,
          taskId: row.initial_task_id,
          taskVersion: String(row.task_version),
          visitType: {
            id: row.visit_type_id,
            nameEn: row.visit_type_name_en,
            nameZh: row.visit_type_name_zh,
          },
        }
      }),
      page,
      pageSize,
      total: total.count,
    }
  }

  recordTriage(input: {
    context: ActorContext
    encounterId: string
    expectedVersions: Record<string, string>
    idempotencyKey: string
    triage: {
      acuityCode: 'level-1' | 'level-2' | 'level-3' | 'level-4'
      bloodPressure: { diastolicMmHg: number; systolicMmHg: number }
      chiefComplaint: string
      oxygenSaturationPct: number
      pulseBpm: number
      respirationBpm: number
      temperatureC: number
    }
  }): CommandResponse<{
    doctorTaskId: string
    encounterId: string
    encounterVersion: string
    observationId: string
    status: 'awaiting-doctor'
  }> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: triageResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: { encounterId: input.encounterId, ...input.triage },
      operation: 'encounter.record-triage',
    }, transaction => {
      this.#assertRole(input.context, ['triage-nurse'])
      const outpatientCase = this.#database.driver.prepare(`
        SELECT case_id, patient_id, encounter_id, initial_task_id, status
        FROM outpatient_case
        WHERE workspace_id = ? AND epoch = ? AND encounter_id = ?
      `).get(input.context.workspaceId, input.context.epoch, input.encounterId) as {
        case_id: string
        encounter_id: string
        patient_id: string
        status: string
        initial_task_id: string
      } | undefined
      if (outpatientCase === undefined || outpatientCase.status !== 'awaiting-triage') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter is not awaiting triage')
      }
      this.#assertExpectedVersions(input.expectedVersions, [
        `Encounter/${outpatientCase.encounter_id}`,
        `Task/${outpatientCase.initial_task_id}`,
      ])
      const encounter = transaction.fhir.read(input.context, 'Encounter', outpatientCase.encounter_id)
      const triageTask = transaction.fhir.read(input.context, 'Task', outpatientCase.initial_task_id)
      const observationId = uuidv7()
      const doctorTaskId = uuidv7()
      const triageId = uuidv7()
      const now = this.#virtualTime(input.context)
      const observation = transaction.fhir.create(input.context, {
        resourceType: 'Observation',
        id: observationId,
        status: 'final',
        category: [{
          coding: [{
            code: 'vital-signs',
            display: 'Vital Signs',
            system: 'http://terminology.hl7.org/CodeSystem/observation-category',
          }],
        }],
        code: { text: 'Outpatient triage vital signs' },
        subject: { reference: `Patient/${outpatientCase.patient_id}` },
        encounter: { reference: `Encounter/${outpatientCase.encounter_id}` },
        effectiveDateTime: now,
        performer: [{ reference: `Practitioner/${input.context.practitionerId}` }],
        component: [
          { code: { coding: [{ code: '8310-5', system: 'http://loinc.org' }] }, valueQuantity: { code: 'Cel', system: 'http://unitsofmeasure.org', unit: '°C', value: input.triage.temperatureC } },
          { code: { coding: [{ code: '8867-4', system: 'http://loinc.org' }] }, valueQuantity: { code: '/min', system: 'http://unitsofmeasure.org', unit: '/min', value: input.triage.pulseBpm } },
          { code: { coding: [{ code: '9279-1', system: 'http://loinc.org' }] }, valueQuantity: { code: '/min', system: 'http://unitsofmeasure.org', unit: '/min', value: input.triage.respirationBpm } },
          { code: { coding: [{ code: '8480-6', system: 'http://loinc.org' }] }, valueQuantity: { code: 'mm[Hg]', system: 'http://unitsofmeasure.org', unit: 'mmHg', value: input.triage.bloodPressure.systolicMmHg } },
          { code: { coding: [{ code: '8462-4', system: 'http://loinc.org' }] }, valueQuantity: { code: 'mm[Hg]', system: 'http://unitsofmeasure.org', unit: 'mmHg', value: input.triage.bloodPressure.diastolicMmHg } },
          { code: { coding: [{ code: '59408-5', system: 'http://loinc.org' }] }, valueQuantity: { code: '%', system: 'http://unitsofmeasure.org', unit: '%', value: input.triage.oxygenSaturationPct } },
        ],
        note: [{ text: input.triage.chiefComplaint }],
      })
      const updatedEncounter = transaction.fhir.update(input.context, {
        ...encounter,
        status: 'in-progress',
      }, encounter.meta?.versionId ?? '1')
      const completedTriageTask = transaction.fhir.update(input.context, {
        ...triageTask,
        status: 'completed',
        executionPeriod: { end: now },
      }, triageTask.meta?.versionId ?? '1')
      const doctorTask = transaction.fhir.create(input.context, {
        resourceType: 'Task',
        id: doctorTaskId,
        status: 'requested',
        intent: 'order',
        code: { text: 'Outpatient consultation' },
        for: { reference: `Patient/${outpatientCase.patient_id}` },
        focus: { reference: `Encounter/${outpatientCase.encounter_id}` },
        owner: { reference: 'PractitionerRole/practitioner-role-outpatient-doctor' },
        authoredOn: now,
      })
      this.#database.driver.prepare(`
        INSERT INTO triage_record (
          workspace_id, epoch, triage_id, case_id, encounter_id, version,
          acuity_code, chief_complaint, vital_json, recorded_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        triageId,
        outpatientCase.case_id,
        outpatientCase.encounter_id,
        input.triage.acuityCode,
        input.triage.chiefComplaint,
        JSON.stringify(input.triage),
        now,
      )
      this.#database.driver.prepare(`
        UPDATE outpatient_case
        SET status = 'awaiting-doctor', doctor_task_id = ?, version = version + 1, updated_at = ?
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND status = 'awaiting-triage'
      `).run(
        doctorTaskId,
        now,
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
      )
      this.#database.driver.prepare(`
        UPDATE registration SET status = 'triaged'
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).run(input.context.workspaceId, input.context.epoch, outpatientCase.case_id)
      return {
        data: {
          doctorTaskId,
          encounterId: outpatientCase.encounter_id,
          encounterVersion: updatedEncounter.meta?.versionId ?? '2',
          observationId,
          status: 'awaiting-doctor' as const,
        },
        effects: [
          { kind: 'created' as const, resource: observation },
          { kind: 'updated' as const, resource: updatedEncounter },
          { kind: 'updated' as const, resource: completedTriageTask },
          { kind: 'created' as const, resource: doctorTask },
        ].map(effect => ({
          kind: effect.kind,
          reference: `${effect.resource.resourceType}/${effect.resource.id}`,
          versionId: effect.resource.meta?.versionId ?? '1',
        })),
      }
    })
  }

  doctorQueue(context: ActorContext, pageSize: number, page = 1) {
    this.#assertRole(context, ['outpatient-doctor'])
    const statuses = ['awaiting-doctor', 'first-visit', 'awaiting-report', 'awaiting-revisit', 'revisit-draft']
    const placeholders = statuses.map(() => '?').join(', ')
    const bindings = [context.workspaceId, context.epoch, ...statuses]
    const total = this.#database.driver.prepare(`
      SELECT COUNT(*) AS count FROM outpatient_case
      JOIN fhir_resource AS encounter
        ON encounter.workspace_id = outpatient_case.workspace_id
       AND encounter.epoch = outpatient_case.epoch
       AND encounter.resource_type = 'Encounter'
       AND encounter.resource_id = outpatient_case.encounter_id
      WHERE outpatient_case.workspace_id = ? AND outpatient_case.epoch = ?
        AND outpatient_case.status IN (${placeholders})
        AND json_extract(encounter.content_json, '$.status') = 'in-progress'
    `).get(...bindings) as { count: number }
    const rows = this.#database.driver.prepare(`
      SELECT outpatient_case.*, patient.content_json AS patient_json,
        triage.acuity_code, triage.chief_complaint, triage.vital_json,
        virtual_patient.clinical_summary_json AS virtual_patient_summary_json,
        encounter.version_id AS encounter_version, task.version_id AS task_version
      FROM outpatient_case
      LEFT JOIN triage_record AS triage
        ON triage.workspace_id = outpatient_case.workspace_id
       AND triage.epoch = outpatient_case.epoch
       AND triage.case_id = outpatient_case.case_id
      LEFT JOIN virtual_patient_case
        ON virtual_patient_case.workspace_id = outpatient_case.workspace_id
       AND virtual_patient_case.epoch = outpatient_case.epoch
       AND virtual_patient_case.case_id = outpatient_case.case_id
      LEFT JOIN virtual_patient
        ON virtual_patient.workspace_id = virtual_patient_case.workspace_id
       AND virtual_patient.epoch = virtual_patient_case.epoch
       AND virtual_patient.virtual_patient_id = virtual_patient_case.virtual_patient_id
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
        AND outpatient_case.status IN (${placeholders})
        AND json_extract(encounter.content_json, '$.status') = 'in-progress'
      ORDER BY outpatient_case.arrived_at, outpatient_case.case_id
      LIMIT ? OFFSET ?
    `).all(...bindings, pageSize, (page - 1) * pageSize) as Array<{
      acuity_code: string | null
      case_id: string
      chief_complaint: string | null
      diagnostic_report_id: string | null
      doctor_task_id: string
      encounter_id: string
      encounter_version: number
      patient_json: string
      status: string
      task_version: number
      virtual_patient_summary_json: string | null
      vital_json: string | null
    }>
    return {
      items: rows.map(row => {
        const triage = row.vital_json === null
          ? undefined
          : triageRecordContentSchema.parse(JSON.parse(row.vital_json))
        return {
          caseId: row.case_id,
          ...(row.diagnostic_report_id === null ? {} : { diagnosticReportId: row.diagnostic_report_id }),
          encounterId: row.encounter_id,
          encounterVersion: String(row.encounter_version),
          patient: patientSummary(parseStoredFhirResource(row.patient_json)),
          presentation: casePresentation(triage, row.virtual_patient_summary_json),
          status: row.status,
          taskId: row.doctor_task_id,
          taskVersion: String(row.task_version),
          ...(triage === undefined || row.acuity_code === null || row.chief_complaint === null
            ? {}
            : {
                triage: {
                  acuityCode: row.acuity_code,
                  chiefComplaint: row.chief_complaint,
                  temperatureC: triage.temperatureC,
                },
              }),
        }
      }),
      page,
      pageSize,
      total: total.count,
    }
  }

  doctorCompletedCases(context: ActorContext, filters: {
    completedFrom?: string | undefined
    completedTo?: string | undefined
    diagnosisCatalogItemId?: string | undefined
    page: number
    pageSize: number
    patientId?: string | undefined
  }) {
    this.#assertRole(context, ['outpatient-doctor'])
    const practitionerRoleId = this.#requiredPractitionerRoleId(context)
    const completedFrom = filters.completedFrom ?? null
    const completedTo = filters.completedTo ?? null
    const diagnosisCatalogItemId = filters.diagnosisCatalogItemId ?? null
    const patientId = filters.patientId ?? null
    const bindings = [
      context.workspaceId,
      context.epoch,
      practitionerRoleId,
      patientId,
      patientId,
      completedFrom,
      completedFrom,
      completedTo,
      completedTo,
      diagnosisCatalogItemId,
      diagnosisCatalogItemId,
      diagnosisCatalogItemId,
    ]
    const total = countRowSchema.parse(this.#database.driver.prepare(`
      SELECT COUNT(*) AS count
      ${completedCaseSelectionSql}
    `).get(...bindings))
    const rows = z.array(completedCaseListRowSchema).parse(this.#database.driver.prepare(`
      SELECT outpatient_case.case_id,
        patient.content_json AS patient_json,
        encounter.content_json AS encounter_json
      ${completedCaseSelectionSql}
      ORDER BY json_extract(encounter.content_json, '$.actualPeriod.end') DESC,
        outpatient_case.case_id
      LIMIT ? OFFSET ?
    `).all(
      ...bindings,
      filters.pageSize,
      (filters.page - 1) * filters.pageSize,
    ))
    return doctorCompletedCaseListSchema.parse({
      items: rows.map((row) => {
        const encounter = encounterCompletionResourceSchema.parse(
          parseStoredFhirResource(row.encounter_json),
        )
        const primaryDiagnosis = this.#completedCaseDiagnosis(context, row.case_id)
          ?.entries.find(entry => entry.role === 'primary')
        if (encounter.status !== 'completed' || encounter.actualPeriod.end === undefined) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'The completed Encounter is incomplete')
        }
        return {
          caseId: row.case_id,
          completedAt: encounter.actualPeriod.end,
          encounterId: encounter.id,
          encounterVersion: encounter.meta.versionId,
          patient: patientSummary(parseStoredFhirResource(row.patient_json)),
          ...(primaryDiagnosis === undefined ? {} : { primaryDiagnosis }),
        }
      }),
      page: filters.page,
      pageSize: filters.pageSize,
      total: total.count,
    })
  }

  doctorCompletedCaseDetail(context: ActorContext, caseId: string) {
    this.#assertRole(context, ['outpatient-doctor'])
    const row = completedCaseDetailRowSchema.optional().parse(this.#database.driver.prepare(`
      SELECT patient.content_json AS patient_json,
        encounter.content_json AS encounter_json
      FROM outpatient_case
      JOIN outpatient_case_responsibility AS responsibility
        ON responsibility.workspace_id = outpatient_case.workspace_id
       AND responsibility.epoch = outpatient_case.epoch
       AND responsibility.case_id = outpatient_case.case_id
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
      WHERE outpatient_case.workspace_id = ? AND outpatient_case.epoch = ?
        AND outpatient_case.case_id = ?
        AND responsibility.practitioner_role_id = ?
        AND json_extract(encounter.content_json, '$.status') = 'completed'
        AND json_extract(encounter.content_json, '$.actualPeriod.end') IS NOT NULL
    `).get(
      context.workspaceId,
      context.epoch,
      caseId,
      this.#requiredPractitionerRoleId(context),
    ))
    if (row === undefined) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The completed outpatient case was not found')
    }
    const encounter = encounterCompletionResourceSchema.parse(
      parseStoredFhirResource(row.encounter_json),
    )
    if (encounter.status !== 'completed' || encounter.actualPeriod.end === undefined) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The completed Encounter is incomplete')
    }
    const consultation = this.#consultationDetail(context, caseId)
    const diagnosis = this.#completedCaseDiagnosis(context, caseId)
    const prescription = this.#issuedPrescription(context, caseId)
    const completedPrescription = prescription === undefined
      ? undefined
      : {
          ...prescription,
          withdrawalSupported: this.#prescriptionConclusionSupportedInContext(context)
            && (
              prescription.status === 'signed' || prescription.status === 'paid'
            )
            && !this.#prescriptionHasDispensedQuantity(context, prescription.id),
        }
    const noMedication = this.#noMedicationConclusion(context, caseId)
    const clinicalDocuments = this.#completedCaseClinicalDocuments(context, caseId)
    const laboratoryRequests = this.#completedCaseLaboratoryRequests(context, caseId)
    const medicationConclusion = completedPrescription === undefined && noMedication === undefined
      ? undefined
      : {
          ...(noMedication === undefined ? {} : { noMedication }),
          ...(completedPrescription === undefined ? {} : { prescription: completedPrescription }),
        }
    const facts = doctorCompletedCaseDetailSchema.omit({ timeline: true }).parse({
      caseId,
      clinicalDocuments,
      completedAt: encounter.actualPeriod.end,
      ...(consultation === undefined ? {} : {
        consultation: {
          records: consultation.records,
          version: consultation.version,
        },
      }),
      ...(diagnosis === undefined ? {} : { diagnosis }),
      encounter: {
        id: encounter.id,
        status: encounter.status,
        versionId: encounter.meta.versionId,
      },
      laboratoryRequests,
      ...(medicationConclusion === undefined ? {} : { medicationConclusion }),
      patient: patientSummary(parseStoredFhirResource(row.patient_json)),
    })
    return doctorCompletedCaseDetailSchema.parse({
      ...facts,
      timeline: this.#completedCaseTimeline(context, {
        ...facts,
        encounterId: encounter.id,
      }),
    })
  }

  virtualPatients(context: ActorContext, pageSize: number, page = 1) {
    this.#assertRole(context, ['outpatient-doctor'])
    const total = countRowSchema.parse(
      this.#database.driver.prepare(`
        SELECT COUNT(*) AS count
        FROM virtual_patient
        JOIN fhir_resource AS patient
          ON patient.workspace_id = virtual_patient.workspace_id
         AND patient.epoch = virtual_patient.epoch
         AND patient.resource_type = 'Patient'
         AND patient.resource_id = virtual_patient.patient_id
         AND patient.deleted = 0
        WHERE virtual_patient.workspace_id = ? AND virtual_patient.epoch = ?
          AND virtual_patient.available = 1
      `).get(context.workspaceId, context.epoch),
    )
    const rows = z.array(virtualPatientListRowSchema).parse(this.#database.driver.prepare(`
      SELECT virtual_patient.virtual_patient_id, virtual_patient.version,
        virtual_patient.patient_id, virtual_patient.clinical_summary_json,
        virtual_patient.available, patient.content_json AS patient_json
      FROM virtual_patient
      JOIN fhir_resource AS patient
        ON patient.workspace_id = virtual_patient.workspace_id
       AND patient.epoch = virtual_patient.epoch
       AND patient.resource_type = 'Patient'
       AND patient.resource_id = virtual_patient.patient_id
       AND patient.deleted = 0
      WHERE virtual_patient.workspace_id = ? AND virtual_patient.epoch = ?
        AND virtual_patient.available = 1
      ORDER BY virtual_patient.virtual_patient_id
      LIMIT ? OFFSET ?
    `).all(context.workspaceId, context.epoch, pageSize, (page - 1) * pageSize))
    return virtualPatientListSchema.parse({
      items: rows.map(row => {
        const patient = patientSummary(parseStoredFhirResource(row.patient_json))
        return {
          birthDate: patient.birthDate,
          gender: patient.gender,
          id: row.virtual_patient_id,
          name: patient.name,
          presentation: JSON.parse(row.clinical_summary_json) as unknown,
          version: this.#createVirtualPatientVersionToken({
            epoch: context.epoch,
            expectedVersions: this.#virtualPatientExpectedVersions(context, row.patient_id),
            virtualPatientId: row.virtual_patient_id,
            virtualPatientVersion: row.version,
            workspaceId: context.workspaceId,
          }),
        }
      }),
      page,
      pageSize,
      total: total.count,
    })
  }

  startVirtualPatient(input: {
    context: ActorContext
    expectedVersion: string
    idempotencyKey: string
    virtualPatientId: string
  }): CommandResponse<{
    caseId: string
    encounterId: string
    patientId: string
    queueTaskId: string
    registrationId: string
    status: 'first-visit'
    virtualPatientId: string
  }> {
    this.#assertRole(input.context, ['outpatient-doctor'])
    const candidateVersion = this.#parseVirtualPatientVersionToken(
      input.context,
      input.virtualPatientId,
      input.expectedVersion,
    )
    const execute = () => this.#commands.execute({
      context: input.context,
      dataSchema: startVirtualPatientResponseSchema.shape.data,
      expectedVersions: candidateVersion.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        expectedVersion: input.expectedVersion,
        virtualPatientId: input.virtualPatientId,
      },
      operation: 'virtual-patient.start-consultation',
    }, transaction => {
      this.#assertRole(input.context, ['outpatient-doctor'])
      const practitionerRoleId = this.#requiredPractitionerRoleId(input.context)
      const virtualPatient = virtualPatientRowSchema.optional().parse(
        this.#database.driver.prepare(`
          SELECT virtual_patient_id, version, patient_id, clinical_summary_json, available
          FROM virtual_patient
          WHERE workspace_id = ? AND epoch = ? AND virtual_patient_id = ?
        `).get(input.context.workspaceId, input.context.epoch, input.virtualPatientId),
      )
      if (virtualPatient === undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Virtual Patient is unavailable')
      }
      if (virtualPatient.version !== candidateVersion.virtualPatientVersion) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Virtual Patient version has changed')
      }
      if (virtualPatient.available !== 1) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Virtual Patient consultation has already started')
      }

      const patient = transaction.fhir.read(input.context, 'Patient', virtualPatient.patient_id)
      const now = this.#virtualTime(input.context)
      const activeCase = this.#activeCaseByPatient(input.context, patient.id)
      let intake: VirtualPatientIntake
      if (activeCase === undefined) {
        const department = this.#catalogItem(input.context, 'department-general-medicine', 'department')
        const visitType = this.#catalogItem(input.context, 'visit-general', 'visit-type')
        const location = transaction.fhir.read(input.context, 'Location', 'location-outpatient')
        if (!this.#isRegistrationLocation(location)) {
          throw new WorkflowError('CATALOG_CONFLICT', 'The outpatient location is unavailable')
        }
        const visitDate = now.slice(0, 10)
        const count = countRowSchema.parse(this.#database.driver.prepare(`
          SELECT COUNT(*) AS count FROM registration
          WHERE workspace_id = ? AND epoch = ?
        `).get(input.context.workspaceId, input.context.epoch)).count + 1
        const registrationNumber = `CM-OP-${visitDate.replaceAll('-', '')}-${String(count).padStart(4, '0')}`
        const caseId = uuidv7()
        const registrationId = uuidv7()
        const encounterId = uuidv7()
        const queueTaskId = uuidv7()
        const accountId = uuidv7()
        const encounter = transaction.fhir.create(input.context, {
          resourceType: 'Encounter',
          id: encounterId,
          identifier: [{
            system: 'https://caizongyuan.github.io/clinmesh/fhir/outpatient-encounter',
            value: registrationNumber,
          }],
          status: 'in-progress',
          class: [{
            coding: [{ code: 'AMB', display: 'ambulatory', system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode' }],
          }],
          subject: { reference: `Patient/${patient.id}` },
          serviceProvider: { reference: 'Organization/organization-clinmesh' },
          location: [{ location: { reference: `Location/${location.id}` }, status: 'active' }],
          actualPeriod: { start: now },
        })
        const task = transaction.fhir.create(input.context, {
          resourceType: 'Task',
          id: queueTaskId,
          status: 'in-progress',
          intent: 'order',
          code: { text: 'Outpatient consultation' },
          for: { reference: `Patient/${patient.id}` },
          focus: { reference: `Encounter/${encounterId}` },
          owner: { reference: `PractitionerRole/${practitionerRoleId}` },
          authoredOn: now,
          executionPeriod: { start: now },
        })
        const account = transaction.fhir.create(input.context, {
          resourceType: 'Account',
          id: accountId,
          status: 'active',
          subject: [{ reference: `Patient/${patient.id}` }],
          servicePeriod: { start: now },
        })
        this.#database.driver.prepare(`
          INSERT INTO outpatient_case (
            workspace_id, epoch, case_id, scenario_run_id, patient_id,
            registration_id, encounter_id, account_id, department_id, location_id,
            initial_task_id, doctor_task_id, status, arrived_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'first-visit', ?, ?)
        `).run(
          input.context.workspaceId,
          input.context.epoch,
          caseId,
          input.context.scenarioRunId,
          patient.id,
          registrationId,
          encounterId,
          accountId,
          department.item_id,
          location.id,
          queueTaskId,
          queueTaskId,
          now,
          now,
        )
        this.#assignCaseResponsibility(input.context, caseId, now)
        this.#database.driver.prepare(`
          INSERT INTO registration (
            workspace_id, epoch, registration_id, case_id, registration_number,
            patient_id, encounter_id, visit_type_id, visit_date, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'in-progress', ?)
        `).run(
          input.context.workspaceId,
          input.context.epoch,
          registrationId,
          caseId,
          registrationNumber,
          patient.id,
          encounterId,
          visitType.item_id,
          visitDate,
          now,
        )
        intake = {
          caseId,
          effects: [
            {
              kind: 'created',
              reference: `Registration/${registrationId}`,
              versionId: '1',
            },
            ...[encounter, task, account].map(resource => ({
              kind: 'created' as const,
              reference: `${resource.resourceType}/${resource.id}`,
              versionId: resource.meta?.versionId ?? '1',
            })),
          ],
          encounterId,
          queueTaskId,
          registrationId,
        }
      } else {
        intake = this.#reuseVirtualPatientIntake(
          input.context,
          transaction,
          activeCase,
          candidateVersion.expectedVersions,
        )
      }
      this.#database.driver.prepare(`
        INSERT INTO virtual_patient_case (
          workspace_id, epoch, virtual_patient_id, case_id
        ) VALUES (?, ?, ?, ?)
      `).run(input.context.workspaceId, input.context.epoch, virtualPatient.virtual_patient_id, intake.caseId)
      this.#database.driver.prepare(`
        INSERT INTO consultation (workspace_id, epoch, case_id, version)
        VALUES (?, ?, ?, 1)
      `).run(input.context.workspaceId, input.context.epoch, intake.caseId)
      const update = this.#database.driver.prepare(`
        UPDATE virtual_patient
        SET available = 0, version = version + 1
        WHERE workspace_id = ? AND epoch = ? AND virtual_patient_id = ?
          AND version = ? AND available = 1
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        virtualPatient.virtual_patient_id,
        candidateVersion.virtualPatientVersion,
      )
      if (update.changes !== 1) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Virtual Patient version has changed')
      }

      return {
        data: {
          caseId: intake.caseId,
          encounterId: intake.encounterId,
          patientId: patient.id,
          queueTaskId: intake.queueTaskId,
          registrationId: intake.registrationId,
          status: 'first-visit' as const,
          virtualPatientId: virtualPatient.virtual_patient_id,
        },
        effects: [
          {
            kind: 'updated' as const,
            reference: `VirtualPatient/${virtualPatient.virtual_patient_id}`,
            versionId: String(virtualPatient.version + 1),
          },
          {
            kind: 'created' as const,
            reference: `Consultation/${intake.caseId}`,
            versionId: '1',
          },
          ...intake.effects,
        ],
      }
    })

    try {
      return execute()
    } catch (error) {
      if (error instanceof ExpectedVersionConflictError) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Virtual Patient version has changed')
      }
      throw error
    }
  }

  doctorCaseDetail(context: ActorContext, caseId: string) {
    this.#assertRole(context, ['outpatient-doctor'])
    const row = this.#database.driver.prepare(`
      SELECT outpatient_case.case_id, outpatient_case.status, outpatient_case.diagnostic_report_id,
        outpatient_case.doctor_task_id,
        patient.content_json AS patient_json,
        encounter.content_json AS encounter_json,
        task.version_id AS task_version,
        triage.acuity_code, triage.chief_complaint, triage.vital_json,
        virtual_patient.clinical_summary_json AS virtual_patient_summary_json
      FROM outpatient_case
      LEFT JOIN triage_record AS triage
        ON triage.workspace_id = outpatient_case.workspace_id
       AND triage.epoch = outpatient_case.epoch
       AND triage.case_id = outpatient_case.case_id
      LEFT JOIN virtual_patient_case
        ON virtual_patient_case.workspace_id = outpatient_case.workspace_id
       AND virtual_patient_case.epoch = outpatient_case.epoch
       AND virtual_patient_case.case_id = outpatient_case.case_id
      LEFT JOIN virtual_patient
        ON virtual_patient.workspace_id = virtual_patient_case.workspace_id
       AND virtual_patient.epoch = virtual_patient_case.epoch
       AND virtual_patient.virtual_patient_id = virtual_patient_case.virtual_patient_id
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
    `).get(context.workspaceId, context.epoch, caseId) as {
      acuity_code: string | null
      case_id: string
      chief_complaint: string | null
      diagnostic_report_id: string | null
      doctor_task_id: string
      encounter_json: string
      patient_json: string
      status: string
      task_version: number
      virtual_patient_summary_json: string | null
      vital_json: string | null
    } | undefined
    if (row === undefined) throw new WorkflowError('WORKFLOW_CONFLICT', 'The outpatient case was not found')
    const encounter = parseStoredFhirResource(row.encounter_json)
    const triage = row.vital_json === null
      ? undefined
      : triageRecordContentSchema.parse(JSON.parse(row.vital_json))
    let report: undefined | {
      id: string
      results: Array<{
        code: string
        interpretation?: string
        referenceRange?: string
        unit?: string
        value: boolean | number | string
      }>
      status: string
    }
    if (row.diagnostic_report_id !== null) {
      const diagnosticReport = this.#fhir.read(
        context,
        'DiagnosticReport',
        row.diagnostic_report_id,
      )
      const parsedDiagnosticReport = diagnosticReportContentSchema.parse(diagnosticReport)
      const references = parsedDiagnosticReport.result?.map(result => result.reference) ?? []
      report = {
        id: diagnosticReport.id,
        results: references.map(reference => {
          const observation = this.#fhir.read(
            context,
            'Observation',
            reference.replace(/^Observation\//, ''),
          )
          const parsedObservation = observationResultContentSchema.parse(observation)
          const value = parsedObservation.valueBoolean
            ?? parsedObservation.valueQuantity?.value
            ?? parsedObservation.valueString
            ?? ''
          return {
            code: parsedObservation.code?.coding?.[0]?.code ?? '',
            ...(parsedObservation.interpretation?.[0]?.coding?.[0]?.code === undefined
              ? {}
              : { interpretation: parsedObservation.interpretation[0]?.coding?.[0]?.code }),
            ...(parsedObservation.referenceRange?.[0]?.text === undefined
              ? {}
              : { referenceRange: parsedObservation.referenceRange[0].text }),
            ...(parsedObservation.valueQuantity?.unit === undefined
              ? {}
              : { unit: parsedObservation.valueQuantity.unit }),
            value,
          }
        }),
        status: parsedDiagnosticReport.status,
      }
    }
    const draftRows = this.#database.driver.prepare(`
      SELECT draft_kind, version, content_json FROM clinical_draft
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
    `).all(context.workspaceId, context.epoch, caseId) as Array<{
      content_json: string
      draft_kind: 'document' | 'first-visit' | 'revisit'
      version: number
    }>
    const drafts: Record<string, unknown> = {}
    for (const draft of draftRows) {
      if (draft.draft_kind === 'first-visit') {
        drafts.firstVisit = {
          ...firstVisitDraftContentSchema.parse(JSON.parse(draft.content_json)),
          version: draft.version,
        }
      }
      else if (draft.draft_kind === 'revisit') {
        const value = revisitDraftContentSchema.parse(JSON.parse(draft.content_json))
        const conditionId = value.conditionId
        drafts.revisit = {
          ...value,
          conditionVersion: this.#fhir.read(context, 'Condition', conditionId).meta?.versionId,
          version: draft.version,
        }
      } else {
        drafts.document = {
          ...documentDraftContentSchema.parse(JSON.parse(draft.content_json)),
          version: draft.version,
        }
      }
    }
    const prescription = this.#database.driver.prepare(`
      SELECT prescription_id, prescription_number, status, version
      FROM prescription
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
    `).get(context.workspaceId, context.epoch, caseId) as {
      prescription_id: string
      prescription_number: string
      status: string
      version: number
    } | undefined
    if (prescription !== undefined) {
      const items = this.#database.driver.prepare(`
        SELECT medication_request_id, medication_id, quantity, dose_text, frequency_code
        FROM prescription_item
        WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
        ORDER BY medication_request_id
      `).all(context.workspaceId, context.epoch, prescription.prescription_id) as Array<{
        dose_text: string
        frequency_code: string
        medication_id: string
        medication_request_id: string
        quantity: number
      }>
      drafts.prescription = {
        id: prescription.prescription_id,
        items: items.map(item => ({
          doseText: item.dose_text,
          frequencyCode: item.frequency_code,
          medicationId: item.medication_id,
          medicationRequestId: item.medication_request_id,
          quantity: item.quantity,
          versionId: this.#fhir.read(context, 'MedicationRequest', item.medication_request_id).meta?.versionId,
        })),
        number: prescription.prescription_number,
        status: prescription.status,
        version: prescription.version,
      }
    }
    const patient = patientSummary(parseStoredFhirResource(row.patient_json))
    const priorFacts = this.#fhir.search(
      context,
      'Condition',
      new URLSearchParams({ _count: '100', patient: `Patient/${patient.id}` }),
    ).resources.flatMap((resource) => {
      const condition = priorConditionSchema.parse(resource)
      if (condition.encounter?.reference === `Encounter/${encounter.id}`) return []
      const coding = condition.code?.coding?.[0]
      return [{
        clinicalStatus: condition.clinicalStatus?.coding?.[0]?.code ?? '',
        code: coding?.code ?? '',
        display: condition.code?.text ?? coding?.display ?? '',
        id: resource.id,
        ...(condition.recordedDate === undefined ? {} : { recordedDate: condition.recordedDate }),
      }]
    })
    const consultation = this.#consultationDetail(context, row.case_id)
    const clinicalDocumentDraft = this.#database.driver.prepare(`
      SELECT version, content_json, updated_at
      FROM clinical_document_draft
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
    `).get(context.workspaceId, context.epoch, row.case_id) as {
      content_json: string
      updated_at: string
      version: number
    } | undefined
    const signedClinicalDocuments = this.#structuredClinicalDocuments(context, row.case_id)
    const laboratoryRequestState = this.#laboratoryRequestState(context, row.case_id)
    const laboratoryRequests = this.#laboratoryRequests(context, row.case_id)
    const diagnosisState = diagnosisStateRowSchema.optional().parse(
      this.#database.driver.prepare(`
        SELECT version, status, draft_json FROM diagnosis_state
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(context.workspaceId, context.epoch, row.case_id),
    )
    const diagnosisConfirmation = this.#diagnosisConfirmation(context, row.case_id)
    const prescriptionDraftState = prescriptionDraftStateRowSchema.optional().parse(
      this.#database.driver.prepare(`
        SELECT version, draft_json FROM prescription_draft_state
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(context.workspaceId, context.epoch, row.case_id),
    )
    const issuedPrescription = this.#issuedPrescription(context, row.case_id)
    const noMedication = this.#noMedicationConclusion(context, row.case_id)
    return {
      allergies: this.#patientAllergyWarnings(context, patient.id),
      caseId: row.case_id,
      ...(clinicalDocumentDraft === undefined && signedClinicalDocuments.length === 0 ? {} : {
        clinicalDocument: {
          ...(clinicalDocumentDraft === undefined ? {} : {
            draft: {
              ...clinicalDocumentContentSchema.parse(JSON.parse(clinicalDocumentDraft.content_json)),
              updatedAt: clinicalDocumentDraft.updated_at,
              version: clinicalDocumentDraft.version,
            },
          }),
          signed: signedClinicalDocuments,
        },
      }),
      ...(consultation === undefined ? {} : { consultation }),
      ...(diagnosisState === undefined ? {} : {
        diagnosis: {
          ...(diagnosisConfirmation === undefined ? {} : { confirmation: diagnosisConfirmation }),
          ...(diagnosisState.draft_json === null
            ? {}
            : { draft: diagnosisDraftContentSchema.parse(JSON.parse(diagnosisState.draft_json)) }),
          draftVersion: diagnosisState.version,
        },
      }),
      encounter: {
        id: encounter.id,
        status: encounter.status,
        versionId: encounter.meta?.versionId,
      },
      ...(laboratoryRequestState === undefined ? {} : {
        laboratoryRequests: {
          ...(laboratoryRequestState.draft_catalog_item_id === null
            || laboratoryRequestState.draft_indication_code === null
            ? {}
            : {
                draft: {
                  catalogItemId: laboratoryRequestState.draft_catalog_item_id,
                  indicationCode: laboratoryRequestState.draft_indication_code,
                },
              }),
          draftVersion: laboratoryRequestState.version,
          reportingSupported: this.#supportsLaboratoryReports(context),
          requests: laboratoryRequests,
        },
      }),
      ...(prescriptionDraftState === undefined ? {} : {
        medicationConclusion: {
          ...(prescriptionDraftState.draft_json === null
            ? {}
            : {
                draft: prescriptionDraftContentSchema.parse(
                  JSON.parse(prescriptionDraftState.draft_json),
                ),
              }),
          draftVersion: prescriptionDraftState.version,
          ...(noMedication === undefined ? {} : { noMedication }),
          ...(issuedPrescription === undefined ? {} : { prescription: issuedPrescription }),
        },
      }),
      patient,
      presentation: casePresentation(triage, row.virtual_patient_summary_json),
      priorFacts,
      ...(report === undefined ? {} : { report }),
      ...(Object.keys(drafts).length === 0 ? {} : { drafts }),
      status: row.status,
      taskId: row.doctor_task_id,
      taskVersion: String(row.task_version),
      ...(triage === undefined ? {} : { triage }),
    }
  }

  encounterCompletionPreview(context: ActorContext, encounterId: string) {
    this.#assertRole(context, ['outpatient-doctor'])
    return encounterCompletionPreviewSchema.parse(
      this.#encounterCompletionPolicy(context, encounterId),
    )
  }

  completeEncounter(input: {
    context: ActorContext
    encounterId: string
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }): CommandResponse<z.infer<typeof encounterCompletionResponseSchema.shape.data>> {
    this.#assertRole(input.context, ['outpatient-doctor'])
    const expectedReference = `Encounter/${input.encounterId}`
    if (
      Object.keys(input.expectedVersions).length !== 1
      || input.expectedVersions[expectedReference] === undefined
    ) {
      throw new WorkflowError(
        'WORKFLOW_CONFLICT',
        `Expected versions must contain only ${expectedReference}`,
      )
    }
    return this.#commands.execute({
      context: input.context,
      dataSchema: encounterCompletionResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: { encounterId: input.encounterId },
      operation: 'encounter.complete',
    }, transaction => {
      this.#assertExpectedVersions(input.expectedVersions, [expectedReference])
      const policy = encounterCompletionPreviewSchema.parse(
        this.#encounterCompletionPolicy(input.context, input.encounterId),
      )
      if (!policy.canComplete) {
        const missing = policy.items
          .filter(item => item.status === 'incomplete')
          .map(item => item.statusText)
        throw new WorkflowError(
          'ENCOUNTER_COMPLETION_BLOCKED',
          missing.length === 0
            ? '该就诊当前不可完诊'
            : `完诊条件未满足：${missing.join('；')}`,
        )
      }
      const encounter = encounterCompletionResourceSchema.parse(
        transaction.fhir.read(input.context, 'Encounter', input.encounterId),
      )
      const completedAt = this.#virtualTime(input.context)
      const completedEncounter = encounterCompletionResourceSchema.parse(
        transaction.fhir.update(input.context, {
          ...encounter,
          status: 'completed',
          actualPeriod: {
            ...encounter.actualPeriod,
            end: completedAt,
          },
        }, encounter.meta.versionId),
      )
      return {
        data: {
          completedAt,
          encounterId: input.encounterId,
          encounterVersion: completedEncounter.meta.versionId,
          status: 'completed' as const,
        },
        effects: [{
          kind: 'updated' as const,
          reference: `Encounter/${input.encounterId}`,
          versionId: completedEncounter.meta.versionId,
        }],
      }
    })
  }

  askConsultationQuestion(input: {
    context: ActorContext
    encounterId: string
    expectedVersions: Record<string, string>
    expectedVersion: number
    idempotencyKey: string
    questionCode: string
  }): CommandResponse<z.infer<typeof askConsultationQuestionResponseSchema.shape.data>> {
    this.#assertRole(input.context, ['outpatient-doctor'])
    return this.#commands.execute({
      context: input.context,
      dataSchema: askConsultationQuestionResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        encounterId: input.encounterId,
        expectedVersion: input.expectedVersion,
        questionCode: input.questionCode,
      },
      operation: 'consultation.ask-question',
    }, () => {
      this.#assertRole(input.context, ['outpatient-doctor'])
      const outpatientCase = this.#caseByEncounter(input.context, input.encounterId)
      if (outpatientCase.doctor_task_id === null || outpatientCase.status === 'completed') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter is not available for consultation')
      }
      const encounter = this.#fhir.read(input.context, 'Encounter', input.encounterId)
      if (encounter.status !== 'in-progress') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter is not available for consultation')
      }
      this.#assertExpectedVersions(input.expectedVersions, [
        `Encounter/${input.encounterId}`,
        `Task/${outpatientCase.doctor_task_id}`,
      ])
      const state = this.#consultationState(input.context, outpatientCase.case_id)
      if (state === undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Consultation Record is unavailable')
      }
      if (state.version !== input.expectedVersion) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Consultation Record version has changed')
      }
      const question = consultationQuestionRuleRowSchema.optional().parse(
        this.#database.driver.prepare(`
          SELECT question_code, question_text, answer_text, rule_version,
            fact_code, revealed_answer_text
          FROM virtual_patient_question_rule
          WHERE workspace_id = ? AND epoch = ? AND virtual_patient_id = ?
            AND question_code = ?
        `).get(
          input.context.workspaceId,
          input.context.epoch,
          state.virtual_patient_id,
          input.questionCode,
        ),
      )
      if (question === undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The consultation question is unavailable')
      }
      const answer = this.#consultationAnswer(input.context, question)
      const recordId = uuidv7()
      const recordedAt = this.#virtualTime(input.context)
      const sequence = state.version
      const consultationVersion = state.version + 1
      this.#database.driver.prepare(`
        INSERT INTO consultation_record (
          workspace_id, epoch, record_id, case_id, sequence,
          question_code, question_text, answer_text, rule_version,
          asked_by_actor_id, asked_by_practitioner_id, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        recordId,
        outpatientCase.case_id,
        sequence,
        question.question_code,
        question.question_text,
        answer,
        question.rule_version,
        input.context.actorId,
        input.context.practitionerId ?? null,
        recordedAt,
      )
      const update = this.#database.driver.prepare(`
        UPDATE consultation SET version = ?
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND version = ?
      `).run(
        consultationVersion,
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
        state.version,
      )
      if (update.changes !== 1) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Consultation Record version has changed')
      }
      const record = {
        answer,
        id: recordId,
        question: {
          code: question.question_code,
          text: question.question_text,
        },
        recordedAt,
        sequence,
      }
      return {
        data: {
          caseId: outpatientCase.case_id,
          consultationVersion,
          record,
        },
        effects: [{
          kind: 'created' as const,
          reference: `ConsultationRecord/${recordId}`,
          versionId: '1',
        }, {
          kind: 'updated' as const,
          reference: `Consultation/${outpatientCase.case_id}`,
          versionId: String(consultationVersion),
        }],
      }
    })
  }

  saveDiagnosisDraft(input: {
    context: ActorContext
    encounterId: string
    entries: DiagnosisDraftEntry[]
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }): CommandResponse<z.infer<typeof diagnosisDraftResponseSchema.shape.data>> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: diagnosisDraftResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        encounterId: input.encounterId,
        entries: input.entries,
        expectedDraftVersion: input.expectedDraftVersion,
      },
      operation: 'encounter.save-diagnosis-draft',
    }, () => {
      this.#assertRole(input.context, ['outpatient-doctor'])
      const outpatientCase = this.#caseByEncounter(input.context, input.encounterId)
      const encounter = this.#fhir.read(input.context, 'Encounter', input.encounterId)
      if (encounter.status !== 'in-progress' || outpatientCase.status === 'completed') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter is not available for diagnosis editing')
      }
      this.#assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
      if (new Set(input.entries.map(entry => entry.catalogItemId)).size !== input.entries.length) {
        throw new WorkflowError('CATALOG_CONFLICT', 'The diagnosis draft contains a duplicate catalog item')
      }
      for (const entry of input.entries) {
        this.#diagnosisCatalogItem(input.context, entry.catalogItemId)
      }
      this.#assertNoLegacyDiagnosisOwner(input.context, outpatientCase.case_id)
      const current = diagnosisStateRowSchema.optional().parse(
        this.#database.driver.prepare(`
          SELECT version, status, draft_json FROM diagnosis_state
          WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id),
      )
      if (current?.status === 'confirmed') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter diagnosis is already confirmed')
      }
      if ((current?.version ?? 0) !== input.expectedDraftVersion) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The diagnosis draft version has changed')
      }
      const draft = diagnosisDraftContentSchema.parse({ entries: input.entries })
      const nextVersion = input.expectedDraftVersion + 1
      const updatedAt = this.#virtualTime(input.context)
      if (current === undefined) {
        this.#database.driver.prepare(`
          INSERT INTO diagnosis_state (
            workspace_id, epoch, case_id, version, status, draft_json,
            updated_by, updated_at
          ) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)
        `).run(
          input.context.workspaceId,
          input.context.epoch,
          outpatientCase.case_id,
          nextVersion,
          JSON.stringify(draft),
          input.context.actorId,
          updatedAt,
        )
      } else {
        const update = this.#database.driver.prepare(`
          UPDATE diagnosis_state
          SET version = ?, draft_json = ?, updated_by = ?, updated_at = ?
          WHERE workspace_id = ? AND epoch = ? AND case_id = ?
            AND status = 'draft' AND version = ?
        `).run(
          nextVersion,
          JSON.stringify(draft),
          input.context.actorId,
          updatedAt,
          input.context.workspaceId,
          input.context.epoch,
          outpatientCase.case_id,
          input.expectedDraftVersion,
        )
        if (update.changes !== 1) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'The diagnosis draft version has changed')
        }
      }
      return {
        data: { draftVersion: nextVersion },
        effects: [{
          kind: current === undefined ? 'created' as const : 'updated' as const,
          reference: `DiagnosisDraft/${outpatientCase.case_id}`,
          versionId: String(nextVersion),
        }],
      }
    })
  }

  confirmDiagnosis(input: {
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }): CommandResponse<z.infer<typeof confirmDiagnosisResponseSchema.shape.data>> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: confirmDiagnosisResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        encounterId: input.encounterId,
        expectedDraftVersion: input.expectedDraftVersion,
      },
      operation: 'encounter.confirm-diagnosis',
    }, transaction => {
      this.#assertRole(input.context, ['outpatient-doctor'])
      if (input.context.practitionerRoleId === undefined) {
        throw new WorkflowError('ROLE_NOT_ALLOWED', 'A Practitioner Role is required to confirm diagnosis')
      }
      const outpatientCase = this.#caseByEncounter(input.context, input.encounterId)
      const encounter = transaction.fhir.read(input.context, 'Encounter', input.encounterId)
      if (encounter.status !== 'in-progress' || outpatientCase.status === 'completed') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter is not available for diagnosis confirmation')
      }
      this.#assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
      this.#assertNoLegacyDiagnosisOwner(input.context, outpatientCase.case_id)
      const state = diagnosisStateRowSchema.optional().parse(
        this.#database.driver.prepare(`
          SELECT version, status, draft_json FROM diagnosis_state
          WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id),
      )
      if (
        state?.status !== 'draft'
        || state.draft_json === null
        || state.version !== input.expectedDraftVersion
      ) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The diagnosis draft version has changed')
      }
      const draft = diagnosisDraftContentSchema.parse(JSON.parse(state.draft_json))
      if (draft.entries.filter(entry => entry.role === 'primary').length !== 1) {
        throw new WorkflowError(
          'DIAGNOSIS_PRIMARY_REQUIRED',
          'Exactly one primary diagnosis is required',
        )
      }
      const resolvedEntries = draft.entries.map(entry => ({
        ...entry,
        catalog: this.#diagnosisCatalogItem(input.context, entry.catalogItemId),
      }))
      const confirmedAt = this.#virtualTime(input.context)
      const confirmedEntries = resolvedEntries.map(entry => ({
        condition: transaction.fhir.create(input.context, {
          resourceType: 'Condition',
          id: uuidv7(),
          category: [{
            coding: [{
              code: 'encounter-diagnosis',
              display: 'Encounter Diagnosis',
              system: 'http://terminology.hl7.org/CodeSystem/condition-category',
            }],
          }],
          clinicalStatus: {
            coding: [{
              code: 'active',
              system: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
            }],
          },
          verificationStatus: {
            coding: [{
              code: 'confirmed',
              system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status',
            }],
          },
          code: {
            coding: [{
              code: entry.catalog.code,
              display: entry.catalog.name_zh,
              system: entry.catalog.code_system,
            }],
            text: entry.catalog.name_zh,
          },
          subject: { reference: `Patient/${outpatientCase.patient_id}` },
          encounter: { reference: `Encounter/${input.encounterId}` },
          recordedDate: confirmedAt,
          recorder: { reference: `PractitionerRole/${input.context.practitionerRoleId}` },
          ...(entry.note === undefined ? {} : { note: [{ text: entry.note }] }),
        }),
        entry,
      }))
      const updatedEncounter = transaction.fhir.update(input.context, {
        ...encounter,
        diagnosis: [
          ...(Array.isArray(encounter.diagnosis) ? encounter.diagnosis : []),
          ...confirmedEntries.map(({ condition, entry }) => ({
            condition: [{ reference: { reference: `Condition/${condition.id}` } }],
            use: [{
              coding: [{
                code: entry.role,
                display: entry.role === 'primary'
                  ? 'Primary diagnosis'
                  : 'Secondary diagnosis',
                system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/encounter-diagnosis-role',
              }],
            }],
          })),
        ],
      }, encounter.meta?.versionId ?? '1')
      const provenanceId = uuidv7()
      const provenance = transaction.fhir.createImmutable(input.context, {
        resourceType: 'Provenance',
        id: provenanceId,
        target: [
          ...confirmedEntries.map(({ condition }) => ({ reference: `Condition/${condition.id}` })),
          { reference: `Encounter/${input.encounterId}` },
        ],
        recorded: confirmedAt,
        activity: { text: 'Encounter diagnosis confirmation' },
        agent: provenanceAgents(input.context, 'Diagnosis confirmer'),
      })
      const confirmationId = uuidv7()
      this.#database.driver.prepare(`
        INSERT INTO diagnosis_confirmation (
          workspace_id, epoch, confirmation_id, case_id, provenance_id,
          confirmed_by_actor_id, confirmed_by_practitioner_role_id, confirmed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        confirmationId,
        outpatientCase.case_id,
        provenanceId,
        input.context.actorId,
        input.context.practitionerRoleId,
        confirmedAt,
      )
      const insertEntry = this.#database.driver.prepare(`
        INSERT INTO diagnosis_entry (
          workspace_id, epoch, confirmation_id, ordinal,
          condition_id, catalog_item_id, role
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      confirmedEntries.forEach(({ condition, entry }, index) => {
        insertEntry.run(
          input.context.workspaceId,
          input.context.epoch,
          confirmationId,
          index + 1,
          condition.id,
          entry.catalogItemId,
          entry.role,
        )
      })
      const diagnosisVersion = state.version + 1
      const update = this.#database.driver.prepare(`
        UPDATE diagnosis_state
        SET version = ?, status = 'confirmed', draft_json = NULL,
          updated_by = ?, updated_at = ?
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
          AND status = 'draft' AND version = ?
      `).run(
        diagnosisVersion,
        input.context.actorId,
        confirmedAt,
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
        state.version,
      )
      if (update.changes !== 1) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The diagnosis draft version has changed')
      }
      const confirmation: DiagnosisConfirmation = {
        confirmedAt,
        entries: confirmedEntries.map(({ condition, entry }) => ({
          catalogItemId: entry.catalogItemId,
          code: entry.catalog.code,
          conditionId: condition.id,
          conditionVersion: condition.meta?.versionId ?? '1',
          display: entry.catalog.name_zh,
          ...(entry.note === undefined ? {} : { note: entry.note }),
          role: entry.role,
          system: entry.catalog.code_system,
        })),
        id: confirmationId,
        provenanceId,
      }
      return {
        data: {
          confirmation,
          diagnosisVersion,
          encounterId: input.encounterId,
          encounterVersion: updatedEncounter.meta?.versionId ?? '2',
        },
        effects: [
          ...confirmedEntries.map(({ condition }) => ({
            kind: 'created' as const,
            reference: `Condition/${condition.id}`,
            versionId: condition.meta?.versionId ?? '1',
          })),
          {
            kind: 'updated' as const,
            reference: `Encounter/${input.encounterId}`,
            versionId: updatedEncounter.meta?.versionId ?? '2',
          },
          {
            kind: 'created' as const,
            reference: `Provenance/${provenance.id}`,
            versionId: provenance.meta?.versionId ?? '1',
          },
          {
            kind: 'created' as const,
            reference: `DiagnosisConfirmation/${confirmationId}`,
            versionId: '1',
          },
          {
            kind: 'updated' as const,
            reference: `DiagnosisDraft/${outpatientCase.case_id}`,
            versionId: String(diagnosisVersion),
          },
        ],
      }
    })
  }

  savePrescriptionDraft(input: {
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    items: PrescriptionDraftItem[]
  }): CommandResponse<z.infer<typeof prescriptionDraftResponseSchema.shape.data>> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: prescriptionDraftResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        encounterId: input.encounterId,
        expectedDraftVersion: input.expectedDraftVersion,
        items: input.items,
      },
      operation: 'encounter.save-prescription-draft',
    }, () => {
      this.#assertRole(input.context, ['outpatient-doctor'])
      this.#assertPrescriptionConclusionSupported(input.context)
      const outpatientCase = this.#caseByEncounter(input.context, input.encounterId)
      const encounter = this.#fhir.read(input.context, 'Encounter', input.encounterId)
      if (encounter.status !== 'in-progress' || outpatientCase.status === 'completed') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter is not available for prescription editing')
      }
      this.#assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
      this.#assertNoLegacyPrescriptionOwner(input.context, outpatientCase.case_id)
      const formalConclusion = this.#database.driver.prepare(`
        SELECT 1 AS present FROM prescription
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        UNION ALL
        SELECT 1 AS present FROM no_medication_conclusion
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        LIMIT 1
      `).get(
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
      )
      if (formalConclusion !== undefined) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The Encounter already has a formal medication conclusion',
        )
      }
      this.#validatedPrescriptionDraftMedications(input.context, input.items)
      const current = prescriptionDraftStateRowSchema.optional().parse(
        this.#database.driver.prepare(`
          SELECT version, draft_json FROM prescription_draft_state
          WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id),
      )
      if ((current?.version ?? 0) !== input.expectedDraftVersion) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription draft version has changed')
      }
      const draft = prescriptionDraftContentSchema.parse({ items: input.items })
      const nextVersion = input.expectedDraftVersion + 1
      const updatedAt = this.#virtualTime(input.context)
      if (current === undefined) {
        this.#database.driver.prepare(`
          INSERT INTO prescription_draft_state (
            workspace_id, epoch, case_id, version, draft_json, updated_by, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.context.workspaceId,
          input.context.epoch,
          outpatientCase.case_id,
          nextVersion,
          JSON.stringify(draft),
          input.context.actorId,
          updatedAt,
        )
      } else {
        const update = this.#database.driver.prepare(`
          UPDATE prescription_draft_state
          SET version = ?, draft_json = ?, updated_by = ?, updated_at = ?
          WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND version = ?
        `).run(
          nextVersion,
          JSON.stringify(draft),
          input.context.actorId,
          updatedAt,
          input.context.workspaceId,
          input.context.epoch,
          outpatientCase.case_id,
          input.expectedDraftVersion,
        )
        if (update.changes !== 1) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription draft version has changed')
        }
      }
      return {
        data: { draftVersion: nextVersion },
        effects: [{
          kind: current === undefined ? 'created' as const : 'updated' as const,
          reference: `PrescriptionDraft/${outpatientCase.case_id}`,
          versionId: String(nextVersion),
        }],
      }
    })
  }

  deletePrescriptionDraft(input: {
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }): CommandResponse<z.infer<typeof prescriptionDraftResponseSchema.shape.data>> {
    return this.#commands.execute({
      authorize: () => {
        this.#assertRole(input.context, ['outpatient-doctor'])
        const outpatientCase = this.#caseByEncounter(input.context, input.encounterId)
        this.#assertCaseResponsibility(input.context, outpatientCase.case_id)
      },
      context: input.context,
      dataSchema: prescriptionDraftResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        encounterId: input.encounterId,
        expectedDraftVersion: input.expectedDraftVersion,
      },
      mapExpectedVersionConflict: error => this.#expectedVersionWorkflowError(error, {
        code: 'WORKFLOW_CONFLICT',
        currentStatus: this.#prescriptionDraftConflictStatus(
          input.context,
          input.encounterId,
        ),
        message: 'A prescription draft resource version has changed',
        owner: 'prescription-draft',
        resource: `Encounter/${input.encounterId}`,
      }),
      operation: 'encounter.delete-prescription-draft',
    }, () => {
      this.#assertPrescriptionConclusionSupported(input.context)
      const outpatientCase = this.#caseByEncounter(input.context, input.encounterId)
      const encounter = this.#fhir.read(input.context, 'Encounter', input.encounterId)
      if (encounter.status !== 'in-progress' || outpatientCase.status === 'completed') {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The prescription draft cannot be deleted',
          {
            currentStatus: 'closed',
            owner: 'prescription-draft',
            resource: `PrescriptionDraft/${outpatientCase.case_id}`,
          },
        )
      }
      this.#assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
      const state = prescriptionDraftStateRowSchema.optional().parse(
        this.#database.driver.prepare(`
          SELECT version, draft_json FROM prescription_draft_state
          WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id),
      )
      if (state === undefined) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The prescription draft does not exist',
          {
            currentStatus: 'missing',
            expectedVersion: String(input.expectedDraftVersion),
            owner: 'prescription-draft',
            resource: `PrescriptionDraft/${outpatientCase.case_id}`,
          },
        )
      }
      if (state.draft_json === null) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          `The prescription draft is empty at version ${state.version}`,
          {
            currentStatus: 'empty',
            currentVersion: String(state.version),
            expectedVersion: String(input.expectedDraftVersion),
            owner: 'prescription-draft',
            resource: `PrescriptionDraft/${outpatientCase.case_id}`,
          },
        )
      }
      if (state.version !== input.expectedDraftVersion) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          `The prescription draft is at version ${state.version}; expected version ${input.expectedDraftVersion}`,
          {
            currentStatus: 'draft',
            currentVersion: String(state.version),
            expectedVersion: String(input.expectedDraftVersion),
            owner: 'prescription-draft',
            resource: `PrescriptionDraft/${outpatientCase.case_id}`,
          },
        )
      }
      const draftVersion = state.version + 1
      const update = this.#database.driver.prepare(`
        UPDATE prescription_draft_state
        SET version = ?, draft_json = NULL, updated_by = ?, updated_at = ?
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
          AND version = ? AND draft_json IS NOT NULL
      `).run(
        draftVersion,
        input.context.actorId,
        this.#virtualTime(input.context),
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
        state.version,
      )
      if (update.changes !== 1) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription draft version has changed')
      }
      return {
        data: { draftVersion },
        effects: [{
          kind: 'updated' as const,
          reference: `PrescriptionDraft/${outpatientCase.case_id}`,
          versionId: String(draftVersion),
        }],
      }
    })
  }

  issuePrescription(input: {
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }): CommandResponse<z.infer<typeof issuePrescriptionResponseSchema.shape.data>> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: issuePrescriptionResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        encounterId: input.encounterId,
        expectedDraftVersion: input.expectedDraftVersion,
      },
      operation: 'encounter.issue-prescription',
    }, transaction => {
      this.#assertRole(input.context, ['outpatient-doctor'])
      this.#assertPrescriptionConclusionSupported(input.context)
      if (input.context.practitionerRoleId === undefined) {
        throw new WorkflowError('ROLE_NOT_ALLOWED', 'A Practitioner Role is required to issue a prescription')
      }
      const outpatientCase = this.#caseByEncounter(input.context, input.encounterId)
      const encounter = transaction.fhir.read(input.context, 'Encounter', input.encounterId)
      if (encounter.status !== 'in-progress' || outpatientCase.status === 'completed') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter is not available for prescription issuing')
      }
      this.#assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
      this.#assertNoLegacyPrescriptionOwner(input.context, outpatientCase.case_id)
      const noMedication = this.#database.driver.prepare(`
        SELECT 1 AS present FROM no_medication_conclusion
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id)
      if (noMedication !== undefined) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The Encounter already has a no-medication conclusion',
        )
      }
      const state = prescriptionDraftStateRowSchema.optional().parse(
        this.#database.driver.prepare(`
          SELECT version, draft_json FROM prescription_draft_state
          WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id),
      )
      if (
        state === undefined
        || state.draft_json === null
        || state.version !== input.expectedDraftVersion
      ) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription draft version has changed')
      }
      const existingPrescription = this.#database.driver.prepare(`
        SELECT 1 AS present FROM prescription
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id)
      if (existingPrescription !== undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter already has a prescription')
      }
      const draft = prescriptionDraftContentSchema.parse(JSON.parse(state.draft_json))
      const medications = this.#validatedPrescriptionDraftMedications(input.context, draft.items)
      this.#assertMedicationAllergies(
        input.context,
        outpatientCase.patient_id,
        medications.map(medication => medication.catalog),
      )
      const confirmedDiagnosisIds = new Set(
        z.array(confirmedDiagnosisCatalogItemRowSchema).parse(
          this.#database.driver.prepare(`
            SELECT diagnosis_entry.catalog_item_id
            FROM diagnosis_confirmation
            JOIN diagnosis_entry
              ON diagnosis_entry.workspace_id = diagnosis_confirmation.workspace_id
             AND diagnosis_entry.epoch = diagnosis_confirmation.epoch
             AND diagnosis_entry.confirmation_id = diagnosis_confirmation.confirmation_id
            WHERE diagnosis_confirmation.workspace_id = ?
              AND diagnosis_confirmation.epoch = ? AND diagnosis_confirmation.case_id = ?
          `).all(
            input.context.workspaceId,
            input.context.epoch,
            outpatientCase.case_id,
          ),
        ).map(row => row.catalog_item_id),
      )
      if (confirmedDiagnosisIds.size === 0) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'A confirmed diagnosis is required to issue a prescription')
      }
      for (const medication of medications) {
        const config = prescriptionMedicationCatalogConfigSchema.parse(
          JSON.parse(medication.catalog.config_json ?? '{}') as unknown,
        )
        if (!config.allowedDiagnosisCatalogItemIds.some(id => confirmedDiagnosisIds.has(id))) {
          throw new WorkflowError(
            'CATALOG_CONFLICT',
            `The confirmed diagnosis does not allow ${medication.catalogItemId}`,
          )
        }
      }
      const prescriptionId = uuidv7()
      const authoredAt = this.#virtualTime(input.context)
      const prescriptionCount = countRowSchema.parse(this.#database.driver.prepare(`
        SELECT COUNT(*) AS count FROM prescription WHERE workspace_id = ? AND epoch = ?
      `).get(input.context.workspaceId, input.context.epoch)).count + 1
      const prescriptionNumber
        = `CM-RX-${authoredAt.slice(0, 10).replaceAll('-', '')}-${String(prescriptionCount).padStart(4, '0')}`
      this.#database.driver.prepare(`
        INSERT INTO prescription (
          workspace_id, epoch, prescription_id, case_id, prescription_number,
          status, version, authored_by, authored_at, signed_at
        ) VALUES (?, ?, ?, ?, ?, 'signed', 1, ?, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        prescriptionId,
        outpatientCase.case_id,
        prescriptionNumber,
        input.context.actorId,
        authoredAt,
        authoredAt,
      )
      this.#database.driver.prepare(`
        INSERT INTO prescription_authorship (
          workspace_id, epoch, prescription_id,
          authored_by_actor_id, authored_by_practitioner_role_id
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        prescriptionId,
        input.context.actorId,
        input.context.practitionerRoleId,
      )
      const insertItem = this.#database.driver.prepare(`
        INSERT INTO prescription_item (
          workspace_id, epoch, prescription_id, medication_request_id,
          medication_id, quantity, dose_text, frequency_code, course_days
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const issuedItems = medications.map((medication) => {
        const medicationRequest = transaction.fhir.create(input.context, {
          resourceType: 'MedicationRequest',
          id: uuidv7(),
          status: 'active',
          intent: 'order',
          medication: {
            reference: {
              display: medication.catalog.name_zh,
              reference: `Medication/${medication.catalogItemId}`,
            },
          },
          subject: { reference: `Patient/${outpatientCase.patient_id}` },
          encounter: { reference: `Encounter/${input.encounterId}` },
          authoredOn: authoredAt,
          requester: { reference: `PractitionerRole/${input.context.practitionerRoleId}` },
          dosageInstruction: [{
            text: `${medication.doseText} ${medication.frequencyCode} for ${medication.courseDays} days`,
            timing: {
              repeat: {
                boundsDuration: {
                  code: 'd',
                  system: 'http://unitsofmeasure.org',
                  unit: 'days',
                  value: medication.courseDays,
                },
              },
            },
          }],
          dispenseRequest: { quantity: { value: medication.quantity } },
          groupIdentifier: {
            system: 'https://caizongyuan.github.io/clinmesh/fhir/prescription-number',
            value: prescriptionNumber,
          },
        })
        insertItem.run(
          input.context.workspaceId,
          input.context.epoch,
          prescriptionId,
          medicationRequest.id,
          medication.catalogItemId,
          medication.quantity,
          medication.doseText,
          medication.frequencyCode,
          medication.courseDays,
        )
        return {
          catalogItemId: medication.catalogItemId,
          courseDays: medication.courseDays,
          display: medication.catalog.name_zh,
          doseText: medication.doseText,
          frequencyCode: medication.frequencyCode,
          medicationRequestId: medicationRequest.id,
          medicationRequestVersion: medicationRequest.meta?.versionId ?? '1',
          quantity: medication.quantity,
        }
      })
      const updateCase = this.#database.driver.prepare(`
        UPDATE outpatient_case
        SET prescription_id = ?, version = version + 1, updated_at = ?
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND prescription_id IS NULL
      `).run(
        prescriptionId,
        authoredAt,
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
      )
      if (updateCase.changes !== 1) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter already has a prescription')
      }
      const draftVersion = state.version + 1
      const updateDraft = this.#database.driver.prepare(`
        UPDATE prescription_draft_state
        SET version = ?, draft_json = NULL, updated_by = ?, updated_at = ?
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
          AND version = ? AND draft_json IS NOT NULL
      `).run(
        draftVersion,
        input.context.actorId,
        authoredAt,
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
        state.version,
      )
      if (updateDraft.changes !== 1) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription draft version has changed')
      }
      const prescription = issuedPrescriptionSchema.parse({
        authoredAt,
        authoredByPractitionerRoleId: input.context.practitionerRoleId,
        id: prescriptionId,
        items: issuedItems,
        number: prescriptionNumber,
        status: 'signed',
        version: 1,
      })
      return {
        data: { draftVersion, prescription },
        effects: [
          {
            kind: 'created' as const,
            reference: `Prescription/${prescriptionId}`,
            versionId: '1',
          },
          ...issuedItems.map(item => ({
            kind: 'created' as const,
            reference: `MedicationRequest/${item.medicationRequestId}`,
            versionId: item.medicationRequestVersion,
          })),
          {
            kind: 'updated' as const,
            reference: `PrescriptionDraft/${outpatientCase.case_id}`,
            versionId: String(draftVersion),
          },
        ],
      }
    })
  }

  confirmNoMedication(input: {
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }): CommandResponse<z.infer<typeof confirmNoMedicationResponseSchema.shape.data>> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: confirmNoMedicationResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        encounterId: input.encounterId,
        expectedDraftVersion: input.expectedDraftVersion,
      },
      operation: 'encounter.confirm-no-medication',
    }, () => {
      this.#assertRole(input.context, ['outpatient-doctor'])
      this.#assertPrescriptionConclusionSupported(input.context)
      if (input.context.practitionerRoleId === undefined) {
        throw new WorkflowError(
          'ROLE_NOT_ALLOWED',
          'A Practitioner Role is required to confirm no medication',
        )
      }
      const outpatientCase = this.#caseByEncounter(input.context, input.encounterId)
      const encounter = this.#fhir.read(input.context, 'Encounter', input.encounterId)
      if (encounter.status !== 'in-progress' || outpatientCase.status === 'completed') {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The Encounter is not available for a medication conclusion',
        )
      }
      this.#assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
      this.#assertNoLegacyPrescriptionOwner(input.context, outpatientCase.case_id)
      const prescription = activePrescriptionRowSchema.optional().parse(
        this.#database.driver.prepare(`
          SELECT withdrawal.withdrawal_id
          FROM prescription
          LEFT JOIN prescription_withdrawal AS withdrawal
            ON withdrawal.workspace_id = prescription.workspace_id
           AND withdrawal.epoch = prescription.epoch
           AND withdrawal.prescription_id = prescription.prescription_id
          WHERE prescription.workspace_id = ? AND prescription.epoch = ?
            AND prescription.case_id = ?
        `).get(
          input.context.workspaceId,
          input.context.epoch,
          outpatientCase.case_id,
        ),
      )
      if (prescription !== undefined && prescription.withdrawal_id === null) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The Encounter already has an active prescription',
        )
      }
      const existingConclusion = this.#database.driver.prepare(`
        SELECT 1 AS present FROM no_medication_conclusion
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id)
      if (existingConclusion !== undefined) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The Encounter already has a no-medication conclusion',
        )
      }
      const draftState = prescriptionDraftStateRowSchema.optional().parse(
        this.#database.driver.prepare(`
          SELECT version, draft_json FROM prescription_draft_state
          WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id),
      )
      if ((draftState?.version ?? 0) !== input.expectedDraftVersion) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription draft version has changed')
      }
      const authoredAt = this.#virtualTime(input.context)
      const conclusionId = uuidv7()
      this.#database.driver.prepare(`
        INSERT INTO no_medication_conclusion (
          workspace_id, epoch, conclusion_id, case_id, version,
          authored_by_actor_id, authored_by_practitioner_role_id, authored_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        conclusionId,
        outpatientCase.case_id,
        input.context.actorId,
        input.context.practitionerRoleId,
        authoredAt,
      )
      const draftVersion = input.expectedDraftVersion + 1
      if (draftState === undefined) {
        this.#database.driver.prepare(`
          INSERT INTO prescription_draft_state (
            workspace_id, epoch, case_id, version, draft_json, updated_by, updated_at
          ) VALUES (?, ?, ?, ?, NULL, ?, ?)
        `).run(
          input.context.workspaceId,
          input.context.epoch,
          outpatientCase.case_id,
          draftVersion,
          input.context.actorId,
          authoredAt,
        )
      } else {
        const update = this.#database.driver.prepare(`
          UPDATE prescription_draft_state
          SET version = ?, draft_json = NULL, updated_by = ?, updated_at = ?
          WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND version = ?
        `).run(
          draftVersion,
          input.context.actorId,
          authoredAt,
          input.context.workspaceId,
          input.context.epoch,
          outpatientCase.case_id,
          input.expectedDraftVersion,
        )
        if (update.changes !== 1) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription draft version has changed')
        }
      }
      const noMedication = noMedicationConclusionSchema.parse({
        authoredAt,
        authoredByActorId: input.context.actorId,
        authoredByPractitionerRoleId: input.context.practitionerRoleId,
        id: conclusionId,
        version: 1,
      })
      return {
        data: { draftVersion, noMedication },
        effects: [
          {
            kind: 'created' as const,
            reference: `NoMedicationConclusion/${conclusionId}`,
            versionId: '1',
          },
          {
            kind: draftState === undefined ? 'created' as const : 'updated' as const,
            reference: `PrescriptionDraft/${outpatientCase.case_id}`,
            versionId: String(draftVersion),
          },
        ],
      }
    })
  }

  withdrawPrescription(input: {
    context: ActorContext
    expectedPrescriptionVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    prescriptionId: string
  }): CommandResponse<z.infer<typeof withdrawPrescriptionResponseSchema.shape.data>> {
    return this.#commands.execute({
      authorize: () => {
        this.#assertRole(input.context, ['outpatient-doctor'])
        this.#assertPrescriptionConclusionSupported(input.context)
        if (input.context.practitionerRoleId === undefined) {
          throw new WorkflowError(
            'ROLE_NOT_ALLOWED',
            'A Practitioner Role is required to withdraw a prescription',
          )
        }
        const prescription = z.object({ case_id: z.string().min(1) }).optional().parse(
          this.#database.driver.prepare(`
            SELECT case_id FROM prescription
            WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
          `).get(input.context.workspaceId, input.context.epoch, input.prescriptionId),
        )
        if (prescription === undefined) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription was not found')
        }
        this.#assertCaseResponsibility(input.context, prescription.case_id)
      },
      context: input.context,
      dataSchema: withdrawPrescriptionResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        expectedPrescriptionVersion: input.expectedPrescriptionVersion,
        prescriptionId: input.prescriptionId,
      },
      mapExpectedVersionConflict: error => this.#expectedVersionWorkflowError(error, {
        code: 'WORKFLOW_CONFLICT',
        currentStatus: this.#prescriptionWithdrawalConflictStatus(
          input.context,
          input.prescriptionId,
        ),
        message: 'A prescription resource version has changed',
        owner: 'prescription',
        resource: `Prescription/${input.prescriptionId}`,
      }),
      operation: 'prescription.withdraw',
    }, transaction => {
      const prescription = prescriptionWithdrawalLookupRowSchema.optional().parse(
        this.#database.driver.prepare(`
          SELECT prescription.case_id, prescription.version, prescription.status,
            withdrawal.withdrawal_id
          FROM prescription
          LEFT JOIN prescription_withdrawal AS withdrawal
            ON withdrawal.workspace_id = prescription.workspace_id
           AND withdrawal.epoch = prescription.epoch
           AND withdrawal.prescription_id = prescription.prescription_id
          WHERE prescription.workspace_id = ? AND prescription.epoch = ?
            AND prescription.prescription_id = ?
        `).get(
          input.context.workspaceId,
          input.context.epoch,
          input.prescriptionId,
        ),
      )
      if (prescription === undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription was not found')
      }
      if (prescription.version !== input.expectedPrescriptionVersion) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          `The prescription is at version ${prescription.version}; expected version ${input.expectedPrescriptionVersion}`,
          {
            currentStatus: prescription.withdrawal_id === null
              ? prescription.status
              : 'withdrawn',
            currentVersion: String(prescription.version),
            expectedVersion: String(input.expectedPrescriptionVersion),
            owner: 'prescription',
            resource: `Prescription/${input.prescriptionId}`,
          },
        )
      }
      if (prescription.withdrawal_id !== null) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          `The prescription is already withdrawn at version ${prescription.version}`,
          {
            currentStatus: 'withdrawn',
            currentVersion: String(prescription.version),
            owner: 'prescription',
            resource: `Prescription/${input.prescriptionId}`,
          },
        )
      }
      if (!['signed', 'paid'].includes(prescription.status)) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          `The prescription cannot be withdrawn from status "${prescription.status}"`,
          {
            currentStatus: prescription.status,
            currentVersion: String(prescription.version),
            owner: 'prescription',
            resource: `Prescription/${input.prescriptionId}`,
          },
        )
      }
      const items = z.array(prescriptionDispensingRowSchema).parse(
        this.#database.driver.prepare(`
          SELECT medication_request_id, dispensed_quantity
          FROM prescription_item
          WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
          ORDER BY medication_request_id
        `).all(
          input.context.workspaceId,
          input.context.epoch,
          input.prescriptionId,
        ),
      )
      if (items.length === 0 || items.some(item => item.dispensed_quantity > 0)) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The prescription cannot be withdrawn because its current state is "dispensing-started"',
          {
            currentStatus: 'dispensing-started',
            currentVersion: String(prescription.version),
            owner: 'prescription',
            resource: `Prescription/${input.prescriptionId}`,
          },
        )
      }
      const medicationReferences = items.map(
        item => `MedicationRequest/${item.medication_request_id}`,
      )
      this.#assertExpectedVersions(input.expectedVersions, medicationReferences)
      const withdrawalId = uuidv7()
      const withdrawnAt = this.#virtualTime(input.context)
      this.#database.driver.prepare(`
        INSERT INTO prescription_withdrawal (
          workspace_id, epoch, withdrawal_id, prescription_id, version,
          withdrawn_by_actor_id, withdrawn_by_practitioner_role_id, withdrawn_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        withdrawalId,
        input.prescriptionId,
        input.context.actorId,
        input.context.practitionerRoleId,
        withdrawnAt,
      )
      const medicationRequests = items.map((item) => {
        const reference = `MedicationRequest/${item.medication_request_id}`
        const request = transaction.fhir.read(
          input.context,
          'MedicationRequest',
          item.medication_request_id,
        )
        if (request.status !== 'active') {
          throw new WorkflowError(
            'WORKFLOW_CONFLICT',
            'The prescription has a medication request that cannot be cancelled',
          )
        }
        const updated = transaction.fhir.update(input.context, {
          ...request,
          status: 'cancelled',
        }, z.string().parse(input.expectedVersions[reference]))
        return {
          id: updated.id,
          version: updated.meta?.versionId ?? '2',
        }
      })
      const update = this.#database.driver.prepare(`
        UPDATE prescription SET version = version + 1
        WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
          AND status IN ('signed', 'paid') AND version = ?
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        input.prescriptionId,
        input.expectedPrescriptionVersion,
      )
      if (update.changes !== 1) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription changed concurrently')
      }
      const withdrawal = prescriptionWithdrawalSchema.parse({
        id: withdrawalId,
        prescriptionId: input.prescriptionId,
        version: 1,
        withdrawnAt,
        withdrawnByActorId: input.context.actorId,
        withdrawnByPractitionerRoleId: input.context.practitionerRoleId,
      })
      return {
        data: {
          medicationRequests,
          prescriptionId: input.prescriptionId,
          prescriptionVersion: input.expectedPrescriptionVersion + 1,
          status: 'withdrawn' as const,
          withdrawal,
        },
        effects: [
          {
            kind: 'created' as const,
            reference: `PrescriptionWithdrawal/${withdrawalId}`,
            versionId: '1',
          },
          ...medicationRequests.map(request => ({
            kind: 'updated' as const,
            reference: `MedicationRequest/${request.id}`,
            versionId: request.version,
          })),
          {
            kind: 'updated' as const,
            reference: `Prescription/${input.prescriptionId}`,
            versionId: String(input.expectedPrescriptionVersion + 1),
          },
        ],
      }
    })
  }

  startFirstVisit(input: {
    context: ActorContext
    encounterId: string
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }): CommandResponse<{
    encounterVersion: string
    status: 'first-visit'
    taskVersion: string
  }> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: startVisitResponseSchema.shape.data.extend({ status: z.literal('first-visit') }),
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: { encounterId: input.encounterId },
      operation: 'encounter.start-first-visit',
    }, transaction => {
      this.#assertRole(input.context, ['outpatient-doctor'])
      const outpatientCase = this.#caseByEncounter(input.context, input.encounterId)
      if (outpatientCase.status !== 'awaiting-doctor' || outpatientCase.doctor_task_id === null) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter is not awaiting a first visit')
      }
      const transition = this.#transitionToFirstVisit(input.context, transaction, {
        caseId: outpatientCase.case_id,
        encounterId: input.encounterId,
        expectedVersions: input.expectedVersions,
        previousStatus: 'awaiting-doctor',
        queueTaskId: outpatientCase.doctor_task_id,
      })
      return {
        data: {
          encounterVersion: transition.encounterVersion,
          status: 'first-visit' as const,
          taskVersion: transition.taskVersion,
        },
        effects: transition.effects,
      }
    })
  }

  startRevisit(input: {
    context: ActorContext
    encounterId: string
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }): CommandResponse<{
    encounterVersion: string
    status: 'revisit-draft'
    taskVersion: string
  }> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: startVisitResponseSchema.shape.data.extend({ status: z.literal('revisit-draft') }),
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: { encounterId: input.encounterId },
      operation: 'encounter.start-revisit',
    }, transaction => {
      this.#assertRole(input.context, ['outpatient-doctor'])
      const outpatientCase = this.#caseByEncounter(input.context, input.encounterId)
      if (outpatientCase.status !== 'awaiting-revisit' || outpatientCase.doctor_task_id === null) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter is not awaiting revisit')
      }
      this.#assertExpectedVersions(input.expectedVersions, [
        `Encounter/${input.encounterId}`,
        `Task/${outpatientCase.doctor_task_id}`,
      ])
      const encounter = transaction.fhir.read(input.context, 'Encounter', input.encounterId)
      const task = transaction.fhir.read(input.context, 'Task', outpatientCase.doctor_task_id)
      const now = this.#virtualTime(input.context)
      const updatedEncounter = transaction.fhir.update(input.context, {
        ...encounter,
        status: 'in-progress',
        extension: [
          ...(Array.isArray(encounter.extension) ? encounter.extension : []),
          {
            url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/workflow-phase',
            valueCode: 'revisit-draft',
          },
        ],
      }, encounter.meta?.versionId ?? '1')
      const updatedTask = transaction.fhir.update(input.context, {
        ...task,
        status: 'in-progress',
        executionPeriod: { start: now },
        owner: { reference: `PractitionerRole/${input.context.practitionerRoleId}` },
      }, task.meta?.versionId ?? '1')
      this.#database.driver.prepare(`
        UPDATE outpatient_case
        SET status = 'revisit-draft', version = version + 1, updated_at = ?
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND status = 'awaiting-revisit'
      `).run(now, input.context.workspaceId, input.context.epoch, outpatientCase.case_id)
      return {
        data: {
          encounterVersion: updatedEncounter.meta?.versionId ?? '6',
          status: 'revisit-draft' as const,
          taskVersion: updatedTask.meta?.versionId ?? '2',
        },
        effects: [updatedEncounter, updatedTask].map(resource => ({
          kind: 'updated' as const,
          reference: `${resource.resourceType}/${resource.id}`,
          versionId: resource.meta?.versionId ?? '1',
        })),
      }
    })
  }

  saveRevisitDraft(input: {
    context: ActorContext
    draft: {
      diagnosis: { code: string; display: string }
      document: { assessment: string; plan: string }
      expectedVersions: {
        documentDraft: number
        prescription: number
        revisitDraft: number
      }
      medications: Array<{
        catalogItemId: string
        doseText: string
        frequencyCode: string
        quantity: number
      }>
    }
    encounterId: string
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }): CommandResponse<{
    conditionId: string
    documentDraftVersion: number
    medicationRequestIds: string[]
    prescriptionId: string
    prescriptionNumber: string
    prescriptionVersion: number
    revisitDraftVersion: number
  }> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: revisitDraftResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: { encounterId: input.encounterId, ...input.draft },
      operation: 'encounter.save-revisit-draft',
    }, transaction => {
      this.#assertRole(input.context, ['outpatient-doctor'])
      const outpatientCase = this.#caseByEncounter(input.context, input.encounterId)
      if (outpatientCase.status !== 'revisit-draft') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter is not in revisit drafting')
      }
      this.#assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
      this.#assertNoIndependentDiagnosisOwner(input.context, outpatientCase.case_id)
      this.#assertNoIndependentPrescriptionOwner(input.context, outpatientCase.case_id)
      const currentDrafts = this.#database.driver.prepare(`
        SELECT draft_kind, version, content_json FROM clinical_draft
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
          AND draft_kind IN ('revisit', 'document')
      `).all(input.context.workspaceId, input.context.epoch, outpatientCase.case_id) as Array<{
        content_json: string
        draft_kind: 'document' | 'revisit'
        version: number
      }>
      const draftVersions = new Map(currentDrafts.map(draft => [draft.draft_kind, draft.version]))
      const existingPrescription = this.#database.driver.prepare(`
        SELECT prescription_id, prescription_number, status, version FROM prescription
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id) as {
        prescription_id: string
        prescription_number: string
        status: string
        version: number
      } | undefined
      if (
        (draftVersions.get('revisit') ?? 0) !== input.draft.expectedVersions.revisitDraft
        || (draftVersions.get('document') ?? 0) !== input.draft.expectedVersions.documentDraft
        || (existingPrescription?.version ?? 0) !== input.draft.expectedVersions.prescription
      ) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'One or more revisit draft versions are stale')
      }
      if (existingPrescription !== undefined && existingPrescription.status !== 'draft') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription is no longer editable')
      }
      const medicationCatalog = input.draft.medications.map(medication => ({
        ...medication,
        catalog: this.#catalogItem(input.context, medication.catalogItemId, 'medication'),
      }))
      this.#assertMedicationCatalogRules(medicationCatalog.map(medication => ({
        catalogItemId: medication.catalogItemId,
        configJson: medication.catalog.config_json,
        doseText: medication.doseText,
        frequencyCode: medication.frequencyCode,
      })))
      this.#assertMedicationAllergies(
        input.context,
        outpatientCase.patient_id,
        medicationCatalog.map(medication => medication.catalog),
      )
      const revisitContent = currentDrafts.find(draft => draft.draft_kind === 'revisit')
      const existingConditionId = revisitContent === undefined
        ? undefined
        : revisitDraftContentSchema.parse(JSON.parse(revisitContent.content_json)).conditionId
      if (existingPrescription !== undefined && existingConditionId === undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The revisit draft dependencies are incomplete')
      }
      const conditionId = existingConditionId ?? uuidv7()
      const prescriptionId = existingPrescription?.prescription_id ?? uuidv7()
      const now = this.#virtualTime(input.context)
      const prescriptionCount = (this.#database.driver.prepare(`
        SELECT COUNT(*) AS count FROM prescription WHERE workspace_id = ? AND epoch = ?
      `).get(input.context.workspaceId, input.context.epoch) as { count: number }).count + 1
      const prescriptionNumber = existingPrescription?.prescription_number
        ?? `CM-RX-${now.slice(0, 10).replaceAll('-', '')}-${String(prescriptionCount).padStart(4, '0')}`
      let condition: FhirResource
      let conditionEffectKind: 'created' | 'updated'
      if (existingConditionId === undefined) {
        condition = transaction.fhir.create(input.context, {
          resourceType: 'Condition',
          id: conditionId,
          clinicalStatus: { coding: [{ code: 'active', system: 'http://terminology.hl7.org/CodeSystem/condition-clinical' }] },
          verificationStatus: { coding: [{ code: 'provisional', system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status' }] },
          code: { coding: [{ code: input.draft.diagnosis.code, display: input.draft.diagnosis.display, system: 'http://hl7.org/fhir/sid/icd-10' }] },
          subject: { reference: `Patient/${outpatientCase.patient_id}` },
          encounter: { reference: `Encounter/${input.encounterId}` },
          recordedDate: now,
          recorder: { reference: `PractitionerRole/${input.context.practitionerRoleId}` },
        })
        conditionEffectKind = 'created'
      } else {
        const currentCondition = transaction.fhir.read(input.context, 'Condition', conditionId)
        if (input.expectedVersions[`Condition/${conditionId}`] !== currentCondition.meta?.versionId) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'The diagnosis draft version is stale')
        }
        condition = transaction.fhir.update(input.context, {
          ...currentCondition,
          code: { coding: [{ code: input.draft.diagnosis.code, display: input.draft.diagnosis.display, system: 'http://hl7.org/fhir/sid/icd-10' }] },
          recorder: { reference: `PractitionerRole/${input.context.practitionerRoleId}` },
        }, currentCondition.meta?.versionId ?? '1')
        conditionEffectKind = 'updated'
      }
      if (existingPrescription === undefined) {
        this.#database.driver.prepare(`
          INSERT INTO prescription (
            workspace_id, epoch, prescription_id, case_id, prescription_number,
            status, version, authored_by, authored_at
          ) VALUES (?, ?, ?, ?, ?, 'draft', 1, ?, ?)
        `).run(
          input.context.workspaceId,
          input.context.epoch,
          prescriptionId,
          outpatientCase.case_id,
          prescriptionNumber,
          input.context.actorId,
          now,
        )
      } else {
        const update = this.#database.driver.prepare(`
          UPDATE prescription SET version = version + 1
          WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
            AND status = 'draft' AND version = ?
        `).run(
          input.context.workspaceId,
          input.context.epoch,
          prescriptionId,
          existingPrescription.version,
        )
        if (update.changes !== 1) throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription draft version is stale')
      }
      const existingItems = existingPrescription === undefined ? [] : this.#database.driver.prepare(`
        SELECT medication_request_id FROM prescription_item
        WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
        ORDER BY medication_request_id
      `).all(input.context.workspaceId, input.context.epoch, prescriptionId) as Array<{
        medication_request_id: string
      }>
      const medicationEffects: Array<{
        kind: 'created' | 'updated'
        resource: FhirResource
      }> = []
      const medicationRequests = medicationCatalog.map((medication, index) => {
        const existingItem = existingItems[index]
        const medicationRequestId = existingItem?.medication_request_id ?? uuidv7()
        const requestContent = {
          status: 'draft',
          intent: 'order',
          medication: { reference: { reference: `Medication/${medication.catalogItemId}` } },
          subject: { reference: `Patient/${outpatientCase.patient_id}` },
          encounter: { reference: `Encounter/${input.encounterId}` },
          authoredOn: now,
          requester: { reference: `PractitionerRole/${input.context.practitionerRoleId}` },
          dosageInstruction: [{ text: `${medication.doseText} ${medication.frequencyCode}` }],
          dispenseRequest: { quantity: { value: medication.quantity } },
          groupIdentifier: {
            system: 'https://caizongyuan.github.io/clinmesh/fhir/prescription-number',
            value: prescriptionNumber,
          },
        }
        let resource: FhirResource
        if (existingItem === undefined) {
          resource = transaction.fhir.create(input.context, {
            resourceType: 'MedicationRequest',
            id: medicationRequestId,
            ...requestContent,
          })
          this.#database.driver.prepare(`
            INSERT INTO prescription_item (
              workspace_id, epoch, prescription_id, medication_request_id,
              medication_id, quantity, dose_text, frequency_code
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            input.context.workspaceId,
            input.context.epoch,
            prescriptionId,
            medicationRequestId,
            medication.catalogItemId,
            medication.quantity,
            medication.doseText,
            medication.frequencyCode,
          )
          medicationEffects.push({ kind: 'created', resource })
        } else {
          const currentRequest = transaction.fhir.read(input.context, 'MedicationRequest', medicationRequestId)
          if (input.expectedVersions[`MedicationRequest/${medicationRequestId}`] !== currentRequest.meta?.versionId) {
            throw new WorkflowError('WORKFLOW_CONFLICT', 'A medication request draft version is stale')
          }
          resource = transaction.fhir.update(input.context, {
            ...currentRequest,
            ...requestContent,
          }, currentRequest.meta?.versionId ?? '1')
          this.#database.driver.prepare(`
            UPDATE prescription_item
            SET medication_id = ?, quantity = ?, dose_text = ?, frequency_code = ?
            WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
              AND medication_request_id = ?
          `).run(
            medication.catalogItemId,
            medication.quantity,
            medication.doseText,
            medication.frequencyCode,
            input.context.workspaceId,
            input.context.epoch,
            prescriptionId,
            medicationRequestId,
          )
          medicationEffects.push({ kind: 'updated', resource })
        }
        return resource
      })
      for (const removedItem of existingItems.slice(medicationCatalog.length)) {
        const currentRequest = transaction.fhir.read(
          input.context,
          'MedicationRequest',
          removedItem.medication_request_id,
        )
        if (
          input.expectedVersions[`MedicationRequest/${removedItem.medication_request_id}`]
          !== currentRequest.meta?.versionId
        ) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'A removed medication request draft version is stale')
        }
        const cancelled = transaction.fhir.update(input.context, {
          ...currentRequest,
          status: 'cancelled',
        }, currentRequest.meta?.versionId ?? '1')
        this.#database.driver.prepare(`
          DELETE FROM prescription_item
          WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
            AND medication_request_id = ?
        `).run(
          input.context.workspaceId,
          input.context.epoch,
          prescriptionId,
          removedItem.medication_request_id,
        )
        medicationEffects.push({ kind: 'updated', resource: cancelled })
      }
      const nextRevisitDraftVersion = input.draft.expectedVersions.revisitDraft + 1
      const nextDocumentDraftVersion = input.draft.expectedVersions.documentDraft + 1
      const saveDraft = this.#database.driver.prepare(`
        INSERT INTO clinical_draft (
          workspace_id, epoch, case_id, draft_kind, version,
          content_json, updated_by, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (workspace_id, epoch, case_id, draft_kind) DO UPDATE SET
          version = excluded.version,
          content_json = excluded.content_json,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `)
      const compositionDraft = fhirResourceSchema.parse({
        resourceType: 'Composition',
        id: `draft-composition-${outpatientCase.case_id}`,
        status: 'preliminary',
        type: { text: 'Synthetic outpatient clinical note draft' },
        subject: [{ reference: `Patient/${outpatientCase.patient_id}` }],
        encounter: { reference: `Encounter/${input.encounterId}` },
        date: now,
        author: [{ reference: `PractitionerRole/${input.context.practitionerRoleId}` }],
        title: '门诊病历草稿',
        section: [
          {
            title: '评估',
            text: {
              status: 'generated',
              div: `<div xmlns="http://www.w3.org/1999/xhtml">${xhtmlText(input.draft.document.assessment)}</div>`,
            },
          },
          {
            title: '计划',
            text: {
              status: 'generated',
              div: `<div xmlns="http://www.w3.org/1999/xhtml">${xhtmlText(input.draft.document.plan)}</div>`,
            },
          },
        ],
      })
      saveDraft.run(
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
        'revisit',
        nextRevisitDraftVersion,
        JSON.stringify({ diagnosis: input.draft.diagnosis, conditionId }),
        input.context.actorId,
        now,
      )
      saveDraft.run(
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
        'document',
        nextDocumentDraftVersion,
        JSON.stringify({
          ...input.draft.document,
          composition: compositionDraft,
          diagnosis: input.draft.diagnosis,
          medicationRequestIds: medicationRequests.map(resource => resource.id),
        }),
        input.context.actorId,
        now,
      )
      this.#database.driver.prepare(`
        UPDATE outpatient_case
        SET prescription_id = ?, version = version + 1, updated_at = ?
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND status = 'revisit-draft'
      `).run(
        prescriptionId,
        now,
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
      )
      return {
        data: {
          conditionId,
          documentDraftVersion: nextDocumentDraftVersion,
          medicationRequestIds: medicationRequests.map(resource => resource.id),
          prescriptionId,
          prescriptionNumber,
          prescriptionVersion: (existingPrescription?.version ?? 0) + 1,
          revisitDraftVersion: nextRevisitDraftVersion,
        },
        effects: [
          { kind: conditionEffectKind, resource: condition },
          ...medicationEffects,
        ].map(effect => ({
          kind: effect.kind,
          reference: `${effect.resource.resourceType}/${effect.resource.id}`,
          versionId: effect.resource.meta?.versionId ?? '1',
        })),
      }
    })
  }

  previewClinicalSign(input: {
    context: ActorContext
    encounterId: string
    expectedDraftVersions: {
      documentDraft: number
      prescription: number
      revisitDraft: number
    }
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }): CommandResponse<{
    commitToken: string
    expiresAt: string
    medicationTotalFen: number
    previewId: string
    summary: {
      diagnosis: { code: string; display: string }
      document: { assessment: string; plan: string }
      medications: Array<{
        medicationId: string
        medicationRequestId: string
        nameEn: string
        nameZh: string
        quantity: number
        subtotalFen: number
        unitPriceFen: number
      }>
    }
  }> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: clinicalSignPreviewResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        encounterId: input.encounterId,
        expectedDraftVersions: input.expectedDraftVersions,
      },
      operation: 'encounter.preview-clinical-sign',
    }, () => {
      this.#assertRole(input.context, ['outpatient-doctor'])
      const outpatientCase = this.#caseByEncounter(input.context, input.encounterId)
      if (outpatientCase.status !== 'revisit-draft') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter is not ready for signing')
      }
      if (this.#signedClinicalDocumentRoot(input.context, outpatientCase.case_id) !== undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Clinical Document is already signed')
      }
      this.#assertExpectedVersions(
        input.expectedVersions,
        this.#clinicalExpectedReferences(
          input.context,
          outpatientCase.case_id,
          input.encounterId,
          outpatientCase.doctor_task_id,
        ),
      )
      const drafts = this.#database.driver.prepare(`
        SELECT draft_kind, version, content_json FROM clinical_draft
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
          AND draft_kind IN ('revisit', 'document')
      `).all(input.context.workspaceId, input.context.epoch, outpatientCase.case_id) as Array<{
        content_json: string
        draft_kind: 'document' | 'revisit'
        version: number
      }>
      const draftMap = new Map(drafts.map(draft => [draft.draft_kind, draft]))
      const prescription = this.#database.driver.prepare(`
        SELECT prescription_id, version FROM prescription
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND status = 'draft'
      `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id) as {
        prescription_id: string
        version: number
      } | undefined
      if (
        draftMap.get('revisit')?.version !== input.expectedDraftVersions.revisitDraft
        || draftMap.get('document')?.version !== input.expectedDraftVersions.documentDraft
        || prescription?.version !== input.expectedDraftVersions.prescription
      ) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The clinical signing dependency versions are stale')
      }
      const medications = this.#database.driver.prepare(`
        SELECT item.medication_request_id, item.medication_id, item.quantity,
          item.dose_text, item.frequency_code, catalog.code, catalog.config_json,
          catalog.name_zh, catalog.name_en, catalog.price_fen
        FROM prescription_item AS item
        JOIN outpatient_catalog AS catalog
          ON catalog.workspace_id = item.workspace_id
         AND catalog.epoch = item.epoch
         AND catalog.item_id = item.medication_id
         AND catalog.kind = 'medication'
         AND catalog.active = 1
        WHERE item.workspace_id = ? AND item.epoch = ? AND item.prescription_id = ?
      `).all(input.context.workspaceId, input.context.epoch, prescription?.prescription_id) as Array<{
        code: string
        config_json: string
        dose_text: string
        frequency_code: string
        medication_id: string
        medication_request_id: string
        name_en: string
        name_zh: string
        price_fen: number
        quantity: number
      }>
      if (medications.length === 0) throw new WorkflowError('CATALOG_CONFLICT', 'The prescription has no active medication')
      this.#assertMedicationCatalogRules(medications.map(medication => ({
        catalogItemId: medication.medication_id,
        configJson: medication.config_json,
        doseText: medication.dose_text,
        frequencyCode: medication.frequency_code,
      })))
      this.#assertMedicationAllergies(input.context, outpatientCase.patient_id, medications)
      const revisit = revisitDraftContentSchema.parse(draftMap.get('revisit')?.content_json === undefined
        ? undefined
        : JSON.parse(draftMap.get('revisit')?.content_json ?? ''))
      const document = documentDraftContentSchema.parse(draftMap.get('document')?.content_json === undefined
        ? undefined
        : JSON.parse(draftMap.get('document')?.content_json ?? ''))
      const medicationTotalFen = medications.reduce(
        (total, medication) => total + medication.price_fen * medication.quantity,
        0,
      )
      const previewId = uuidv7()
      const commitToken = `${previewId}.${this.#hashToken(`clinical-sign:${previewId}`)}`
      const expiresAt = new Date(Date.parse(this.#virtualTime(input.context)) + 5 * 60_000).toISOString()
      const summary = {
        diagnosis: {
          code: revisit.diagnosis.code,
          display: revisit.diagnosis.display,
        },
        document: {
          assessment: document.assessment,
          plan: document.plan,
        },
        medications: medications.map(medication => ({
          medicationId: medication.medication_id,
          medicationRequestId: medication.medication_request_id,
          nameEn: medication.name_en,
          nameZh: medication.name_zh,
          quantity: medication.quantity,
          subtotalFen: medication.price_fen * medication.quantity,
          unitPriceFen: medication.price_fen,
        })),
      }
      this.#database.driver.prepare(`
        INSERT INTO clinical_sign_preview (
          workspace_id, epoch, preview_id, case_id, expected_versions_json,
          summary_json, medication_total_fen, token_hash, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        previewId,
        outpatientCase.case_id,
        JSON.stringify(input.expectedDraftVersions),
        JSON.stringify(summary),
        medicationTotalFen,
        this.#hashToken(commitToken),
        expiresAt,
      )
      return {
        data: {
          commitToken,
          expiresAt,
          medicationTotalFen,
          previewId,
          summary,
        },
        effects: [{
          kind: 'created',
          reference: `ClinicalSignPreview/${previewId}`,
          versionId: '1',
        }],
      }
    })
  }

  signAndComplete(input: {
    commitToken: string
    context: ActorContext
    encounterId: string
    expectedVersions: Record<string, string>
    idempotencyKey: string
    previewId: string
  }): CommandResponse<{
    bundleId: string
    chargeItemId: string
    compositionId: string
    encounterId: string
    encounterVersion: string
    provenanceId: string
    status: 'awaiting-medication-payment'
  }> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: clinicalSignResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        commitToken: input.commitToken,
        encounterId: input.encounterId,
        previewId: input.previewId,
      },
      operation: 'encounter.sign-and-complete',
    }, transaction => {
      this.#assertRole(input.context, ['outpatient-doctor'])
      const preview = this.#database.driver.prepare(`
        SELECT preview.*, outpatient_case.encounter_id, outpatient_case.patient_id,
          outpatient_case.account_id, outpatient_case.doctor_task_id,
          outpatient_case.prescription_id, outpatient_case.status AS case_status
        FROM clinical_sign_preview AS preview
        JOIN outpatient_case
          ON outpatient_case.workspace_id = preview.workspace_id
         AND outpatient_case.epoch = preview.epoch
         AND outpatient_case.case_id = preview.case_id
        WHERE preview.workspace_id = ? AND preview.epoch = ? AND preview.preview_id = ?
      `).get(input.context.workspaceId, input.context.epoch, input.previewId) as {
        account_id: string
        case_id: string
        case_status: string
        consumed_at: string | null
        doctor_task_id: string | null
        encounter_id: string
        expected_versions_json: string
        expires_at: string
        medication_total_fen: number
        patient_id: string
        prescription_id: string | null
        token_hash: string
      } | undefined
      if (
        preview === undefined
        || preview.consumed_at !== null
        || preview.encounter_id !== input.encounterId
        || preview.case_status !== 'revisit-draft'
        || preview.prescription_id === null
        || preview.doctor_task_id === null
      ) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The clinical signing preview is unavailable')
      }
      if (this.#signedClinicalDocumentRoot(input.context, preview.case_id) !== undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Clinical Document is already signed')
      }
      this.#assertExpectedVersions(
        input.expectedVersions,
        this.#clinicalExpectedReferences(
          input.context,
          preview.case_id,
          preview.encounter_id,
          preview.doctor_task_id,
        ),
      )
      if (preview.token_hash !== this.#hashToken(input.commitToken)) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The clinical signing token is invalid')
      }
      if (Date.parse(preview.expires_at) < Date.parse(this.#virtualTime(input.context))) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The clinical signing preview has expired')
      }
      const expectedDrafts = clinicalSignExpectedVersionsSchema.parse(
        JSON.parse(preview.expected_versions_json),
      )
      const drafts = this.#database.driver.prepare(`
        SELECT draft_kind, version, content_json FROM clinical_draft
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
          AND draft_kind IN ('revisit', 'document')
      `).all(input.context.workspaceId, input.context.epoch, preview.case_id) as Array<{
        content_json: string
        draft_kind: 'document' | 'revisit'
        version: number
      }>
      const draftMap = new Map(drafts.map(draft => [draft.draft_kind, draft]))
      const prescription = this.#database.driver.prepare(`
        SELECT prescription_number, version FROM prescription
        WHERE workspace_id = ? AND epoch = ? AND prescription_id = ? AND status = 'draft'
      `).get(input.context.workspaceId, input.context.epoch, preview.prescription_id) as {
        prescription_number: string
        version: number
      } | undefined
      if (
        draftMap.get('revisit')?.version !== expectedDrafts.revisitDraft
        || draftMap.get('document')?.version !== expectedDrafts.documentDraft
        || prescription?.version !== expectedDrafts.prescription
      ) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The clinical signing dependencies changed after preview')
      }
      const revisitDraft = revisitDraftContentSchema.parse(
        JSON.parse(draftMap.get('revisit')?.content_json ?? '{}'),
      )
      const documentDraft = documentDraftContentSchema.parse(
        JSON.parse(draftMap.get('document')?.content_json ?? '{}'),
      )
      const medicationRows = this.#database.driver.prepare(`
        SELECT item.medication_request_id, item.medication_id, item.quantity,
          item.dose_text, item.frequency_code, catalog.name_zh, catalog.name_en,
          catalog.code, catalog.config_json, catalog.price_fen
        FROM prescription_item AS item
        JOIN outpatient_catalog AS catalog
          ON catalog.workspace_id = item.workspace_id
         AND catalog.epoch = item.epoch
         AND catalog.item_id = item.medication_id
         AND catalog.kind = 'medication'
         AND catalog.active = 1
        WHERE item.workspace_id = ? AND item.epoch = ? AND item.prescription_id = ?
        ORDER BY item.medication_request_id
      `).all(input.context.workspaceId, input.context.epoch, preview.prescription_id) as Array<{
        dose_text: string
        code: string
        config_json: string
        frequency_code: string
        medication_id: string
        medication_request_id: string
        name_en: string
        name_zh: string
        price_fen: number
        quantity: number
      }>
      this.#assertMedicationCatalogRules(medicationRows.map(medication => ({
        catalogItemId: medication.medication_id,
        configJson: medication.config_json,
        doseText: medication.dose_text,
        frequencyCode: medication.frequency_code,
      })))
      const medicationTotalFen = medicationRows.reduce(
        (total, medication) => total + medication.price_fen * medication.quantity,
        0,
      )
      if (medicationTotalFen !== preview.medication_total_fen || medicationRows.length === 0) {
        throw new WorkflowError('CATALOG_CONFLICT', 'The medication catalog changed after preview')
      }
      this.#assertMedicationAllergies(input.context, preview.patient_id, medicationRows)
      const now = this.#virtualTime(input.context)
      const condition = transaction.fhir.read(input.context, 'Condition', revisitDraft.conditionId)
      const signedCondition = transaction.fhir.update(input.context, {
        ...condition,
        verificationStatus: { coding: [{ code: 'confirmed', system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status' }] },
      }, condition.meta?.versionId ?? '1')
      const signedMedicationRequests = medicationRows.map(medication => {
        const request = transaction.fhir.read(
          input.context,
          'MedicationRequest',
          medication.medication_request_id,
        )
        return transaction.fhir.update(input.context, {
          ...request,
          status: 'active',
        }, request.meta?.versionId ?? '1')
      })
      this.#database.driver.prepare(`
        UPDATE prescription
        SET status = 'signed', version = version + 1, signed_at = ?
        WHERE workspace_id = ? AND epoch = ? AND prescription_id = ? AND status = 'draft'
      `).run(now, input.context.workspaceId, input.context.epoch, preview.prescription_id)
      const chargeItemId = uuidv7()
      const chargeId = uuidv7()
      const chargeItem = transaction.fhir.create(input.context, {
        resourceType: 'ChargeItem',
        id: chargeItemId,
        status: 'billable',
        code: { text: `Prescription ${prescription?.prescription_number}` },
        subject: { reference: `Patient/${preview.patient_id}` },
        encounter: { reference: `Encounter/${preview.encounter_id}` },
        account: [{ reference: `Account/${preview.account_id}` }],
        occurrenceDateTime: now,
        quantity: { value: medicationRows.reduce((total, medication) => total + medication.quantity, 0) },
        ...(new Set(medicationRows.map(medication => medication.price_fen)).size === 1
          ? {
              unitPriceComponent: {
                amount: { currency: 'CNY', value: (medicationRows[0]?.price_fen ?? 0) / 100 },
              },
            }
          : {}),
        totalPriceComponent: { amount: { currency: 'CNY', value: medicationTotalFen / 100 } },
      })
      const compositionId = uuidv7()
      const composition = transaction.fhir.createImmutable(input.context, {
        resourceType: 'Composition',
        id: compositionId,
        status: 'final',
        type: { text: 'Synthetic outpatient clinical note' },
        subject: [{ reference: `Patient/${preview.patient_id}` }],
        encounter: { reference: `Encounter/${preview.encounter_id}` },
        date: now,
        author: [{ reference: `PractitionerRole/${input.context.practitionerRoleId}` }],
        title: '门诊病历',
        section: [
          { title: '诊断', text: { status: 'generated', div: `<div xmlns="http://www.w3.org/1999/xhtml">${xhtmlText(revisitDraft.diagnosis.display)}</div>` }, entry: [{ reference: `Condition/${signedCondition.id}` }] },
          { title: '评估', text: { status: 'generated', div: `<div xmlns="http://www.w3.org/1999/xhtml">${xhtmlText(documentDraft.assessment)}</div>` } },
          { title: '计划', text: { status: 'generated', div: `<div xmlns="http://www.w3.org/1999/xhtml">${xhtmlText(documentDraft.plan)}</div>` }, entry: signedMedicationRequests.map(request => ({ reference: `MedicationRequest/${request.id}` })) },
        ],
      })
      const bundleId = uuidv7()
      const bundle = transaction.fhir.createImmutable(input.context, {
        resourceType: 'Bundle',
        id: bundleId,
        type: 'document',
        timestamp: now,
        entry: [composition, signedCondition, ...signedMedicationRequests].map(resource => ({
          fullUrl: `https://caizongyuan.github.io/clinmesh/fhir/${resource.resourceType}/${resource.id}`,
          resource,
        })),
      })
      const provenanceId = uuidv7()
      const provenance = transaction.fhir.createImmutable(input.context, {
        resourceType: 'Provenance',
        id: provenanceId,
        target: [
          { reference: `Composition/${compositionId}` },
          { reference: `Bundle/${bundleId}` },
        ],
        recorded: now,
        activity: { text: 'Clinical document signing and Encounter completion' },
        agent: provenanceAgents(input.context, 'Author and signer'),
      })
      const encounter = transaction.fhir.read(input.context, 'Encounter', input.encounterId)
      const completedEncounter = transaction.fhir.update(input.context, {
        ...encounter,
        status: 'completed',
        actualPeriod: {
          ...((typeof encounter.actualPeriod === 'object' && encounter.actualPeriod !== null)
            ? encounter.actualPeriod as Record<string, unknown>
            : {}),
          end: now,
        },
      }, encounter.meta?.versionId ?? '1')
      const task = transaction.fhir.read(input.context, 'Task', preview.doctor_task_id)
      const completedTask = transaction.fhir.update(input.context, {
        ...task,
        status: 'completed',
        executionPeriod: {
          ...((typeof task.executionPeriod === 'object' && task.executionPeriod !== null)
            ? task.executionPeriod as Record<string, unknown>
            : {}),
          end: now,
        },
      }, task.meta?.versionId ?? '1')
      this.#database.driver.prepare(`
        INSERT INTO charge_record (
          workspace_id, epoch, charge_id, case_id, account_id, charge_item_id,
          category, source_reference, description_zh, description_en,
          quantity, unit_price_fen, total_fen, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'medication', ?, '门诊药品', 'Outpatient medication',
          ?, ?, ?, 'billable', ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        chargeId,
        preview.case_id,
        preview.account_id,
        chargeItemId,
        `Prescription/${preview.prescription_id}`,
        medicationRows.reduce((total, medication) => total + medication.quantity, 0),
        medicationRows.length === 1 ? medicationRows[0]?.price_fen ?? 0 : medicationTotalFen,
        medicationTotalFen,
        now,
      )
      const documentId = uuidv7()
      this.#database.driver.prepare(`
        INSERT INTO signed_clinical_document (
          workspace_id, epoch, document_id, case_id, composition_id, bundle_id,
          provenance_id, signed_by, signed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        documentId,
        preview.case_id,
        compositionId,
        bundleId,
        provenanceId,
        input.context.actorId,
        now,
      )
      this.#database.driver.prepare(`
        UPDATE clinical_sign_preview SET consumed_at = ?
        WHERE workspace_id = ? AND epoch = ? AND preview_id = ? AND consumed_at IS NULL
      `).run(now, input.context.workspaceId, input.context.epoch, input.previewId)
      this.#database.driver.prepare(`
        UPDATE outpatient_case
        SET status = 'awaiting-medication-payment', version = version + 1, updated_at = ?
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND status = 'revisit-draft'
      `).run(now, input.context.workspaceId, input.context.epoch, preview.case_id)
      this.#database.driver.prepare(`
        UPDATE registration SET status = 'completed'
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).run(input.context.workspaceId, input.context.epoch, preview.case_id)
      const created = [chargeItem, composition, bundle, provenance]
      const updated = [signedCondition, ...signedMedicationRequests, completedEncounter, completedTask]
      return {
        data: {
          bundleId,
          chargeItemId,
          compositionId,
          encounterId: input.encounterId,
          encounterVersion: completedEncounter.meta?.versionId ?? '7',
          provenanceId,
          status: 'awaiting-medication-payment' as const,
        },
        effects: [
          ...created.map(resource => ({
            kind: 'created' as const,
            reference: `${resource.resourceType}/${resource.id}`,
            versionId: resource.meta?.versionId ?? '1',
          })),
          ...updated.map(resource => ({
            kind: 'updated' as const,
            reference: `${resource.resourceType}/${resource.id}`,
            versionId: resource.meta?.versionId ?? '2',
          })),
        ],
      }
    })
  }

  reviseClinicalDocument(input: {
    compositionId: string
    context: ActorContext
    expectedVersions: Record<string, string>
    idempotencyKey: string
    reason: string
    revision:
      | { assessment: string; plan: string }
      | { document: ClinicalDocumentContent }
  }): CommandResponse<{
    bundleId: string
    compositionId: string
    compositionVersion: string
    documentId: string
    provenanceId: string
    revisionNumber: number
    revisionOfCompositionId: string
  }> {
    const revision = clinicalDocumentRevisionDefinition(input.revision, input.reason)
    return this.#commands.execute({
      authorize: () => {
        this.#assertRole(input.context, ['outpatient-doctor'])
        const source = practitionerRoleIdRowSchema.optional().parse(
          this.#database.driver.prepare(`
            SELECT responsibility.practitioner_role_id
            FROM signed_clinical_document AS document
            JOIN outpatient_case_responsibility AS responsibility
              ON responsibility.workspace_id = document.workspace_id
             AND responsibility.epoch = document.epoch
             AND responsibility.case_id = document.case_id
            WHERE document.workspace_id = ? AND document.epoch = ?
              AND document.composition_id = ?
          `).get(
            input.context.workspaceId,
            input.context.epoch,
            input.compositionId,
          ),
        )
        if (source === undefined) {
          throw new WorkflowError(
            'WORKFLOW_CONFLICT',
            'The signed clinical document was not found',
            {
              currentStatus: 'missing',
              owner: 'clinical-document',
              resource: `Composition/${input.compositionId}`,
            },
          )
        }
        if (source.practitioner_role_id !== input.context.practitionerRoleId) {
          throw new WorkflowError(
            'ROLE_NOT_ALLOWED',
            'Only the doctor responsible for the outpatient case can revise its Clinical Document',
          )
        }
      },
      context: input.context,
      dataSchema: clinicalDocumentRevisionResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        compositionId: input.compositionId,
        reason: input.reason,
        ...revision.payload,
      },
      mapExpectedVersionConflict: error => this.#expectedVersionWorkflowError(error, {
        code: 'WORKFLOW_CONFLICT',
        currentStatus: this.#clinicalDocumentConflictStatus(
          input.context,
          input.compositionId,
        ),
        message: 'A Clinical Document resource version has changed',
        owner: 'clinical-document',
        resource: `Composition/${input.compositionId}`,
      }),
      operation: 'clinical-document.revise',
    }, transaction => {
      const source = clinicalDocumentRevisionSourceRowSchema.optional().parse(
        this.#database.driver.prepare(`
          SELECT document.document_id, document.bundle_id, outpatient_case.patient_id,
            outpatient_case.encounter_id, responsibility.practitioner_role_id
          FROM signed_clinical_document AS document
          JOIN outpatient_case
            ON outpatient_case.workspace_id = document.workspace_id
           AND outpatient_case.epoch = document.epoch
           AND outpatient_case.case_id = document.case_id
          JOIN outpatient_case_responsibility AS responsibility
            ON responsibility.workspace_id = outpatient_case.workspace_id
           AND responsibility.epoch = outpatient_case.epoch
           AND responsibility.case_id = outpatient_case.case_id
          WHERE document.workspace_id = ? AND document.epoch = ?
            AND document.composition_id = ?
        `).get(
          input.context.workspaceId,
          input.context.epoch,
          input.compositionId,
        ),
      )
      if (source === undefined) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The signed clinical document was not found',
          {
            currentStatus: 'missing',
            owner: 'clinical-document',
            resource: `Composition/${input.compositionId}`,
          },
        )
      }
      if (this.#clinicalDocumentHasSuccessor(input.context, source.document_id)) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The Clinical Document is superseded; only the latest version can be revised',
          {
            currentStatus: 'superseded',
            owner: 'clinical-document',
            resource: `Composition/${input.compositionId}`,
          },
        )
      }
      this.#assertExpectedVersions(input.expectedVersions, [
        `Composition/${input.compositionId}`,
        `Encounter/${source.encounter_id}`,
      ])
      const originalComposition = transaction.fhir.read(
        input.context,
        'Composition',
        input.compositionId,
      )
      const originalBundle = transaction.fhir.read(input.context, 'Bundle', source.bundle_id)
      const structuredSource = structuredClinicalDocumentFromComposition(originalComposition)
      if (revision.kind === 'structured' && structuredSource === undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The structured Clinical Document was not found')
      }
      if (revision.kind === 'legacy' && structuredSource !== undefined) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The structured Clinical Document requires structured revision content',
        )
      }
      const now = this.#virtualTime(input.context)
      const compositionId = uuidv7()
      const composition = transaction.fhir.createImmutable(input.context, {
        resourceType: 'Composition',
        id: compositionId,
        status: 'amended',
        type: originalComposition.type,
        subject: originalComposition.subject ?? [{ reference: `Patient/${source.patient_id}` }],
        encounter: originalComposition.encounter
          ?? { reference: `Encounter/${source.encounter_id}` },
        date: now,
        author: [{ reference: `PractitionerRole/${input.context.practitionerRoleId}` }],
        title: revision.title,
        relatesTo: [{
          type: 'replaces',
          resourceReference: { reference: `Composition/${input.compositionId}` },
        }],
        section: revision.sections,
      })
      const bundleId = uuidv7()
      const bundle = transaction.fhir.createImmutable(input.context, {
        resourceType: 'Bundle',
        id: bundleId,
        type: 'document',
        identifier: {
          system: clinicalDocumentBundleIdentifierSystem,
          value: bundleId,
        },
        timestamp: now,
        entry: this.#documentBundleEntries(
          input.context,
          transaction,
          composition,
          originalBundle.entry,
        ),
      })
      const provenanceId = uuidv7()
      const provenance = transaction.fhir.createImmutable(input.context, {
        resourceType: 'Provenance',
        id: provenanceId,
        target: [
          { reference: `Composition/${compositionId}` },
          { reference: `Bundle/${bundleId}` },
        ],
        recorded: now,
        activity: { text: 'Clinical document revision' },
        reason: [{ concept: { text: input.reason } }],
        agent: provenanceAgents(input.context, 'Clinical document reviser'),
        entity: [{
          role: 'revision',
          what: { reference: `Composition/${input.compositionId}` },
        }],
      })
      const documentId = uuidv7()
      const revisionNumber = this.#clinicalDocumentRevisionNumber(
        input.context,
        source.document_id,
      ) + 1
      this.#database.driver.prepare(`
        INSERT INTO signed_clinical_document (
          workspace_id, epoch, document_id, case_id, composition_id, bundle_id,
          provenance_id, revision_of_document_id, signed_by, signed_at
        )
        SELECT workspace_id, epoch, ?, case_id, ?, ?, ?, document_id, ?, ?
        FROM signed_clinical_document
        WHERE workspace_id = ? AND epoch = ? AND document_id = ?
      `).run(
        documentId,
        compositionId,
        bundleId,
        provenanceId,
        input.context.actorId,
        now,
        input.context.workspaceId,
        input.context.epoch,
        source.document_id,
      )
      return {
        data: {
          bundleId,
          compositionId,
          compositionVersion: composition.meta?.versionId ?? '1',
          documentId,
          provenanceId,
          revisionNumber,
          revisionOfCompositionId: input.compositionId,
        },
        effects: [composition, bundle, provenance].map(resource => ({
          kind: 'created' as const,
          reference: `${resource.resourceType}/${resource.id}`,
          versionId: resource.meta?.versionId ?? '1',
        })),
      }
    })
  }

  saveFirstVisitDraft(input: {
    context: ActorContext
    draft: {
      assessment: string
      expectedDraftVersion: number
      historyOfPresentIllness: string
    }
    encounterId: string
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }): CommandResponse<{ draftVersion: number }> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: firstVisitDraftResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: { encounterId: input.encounterId, ...input.draft },
      operation: 'encounter.save-first-visit-draft',
    }, () => {
      this.#assertRole(input.context, ['outpatient-doctor'])
      const outpatientCase = this.#caseByEncounter(input.context, input.encounterId)
      if (outpatientCase.status !== 'first-visit') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter is not in the first visit')
      }
      this.#assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
      const current = this.#database.driver.prepare(`
        SELECT version FROM clinical_draft
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND draft_kind = 'first-visit'
      `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id) as {
        version: number
      } | undefined
      const currentVersion = current?.version ?? 0
      if (currentVersion !== input.draft.expectedDraftVersion) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The first-visit draft version is stale')
      }
      const version = currentVersion + 1
      const now = this.#virtualTime(input.context)
      this.#database.driver.prepare(`
        INSERT INTO clinical_draft (
          workspace_id, epoch, case_id, draft_kind, version,
          content_json, updated_by, updated_at
        ) VALUES (?, ?, ?, 'first-visit', ?, ?, ?, ?)
        ON CONFLICT (workspace_id, epoch, case_id, draft_kind) DO UPDATE SET
          version = excluded.version,
          content_json = excluded.content_json,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
        version,
        JSON.stringify({
          assessment: input.draft.assessment,
          historyOfPresentIllness: input.draft.historyOfPresentIllness,
        }),
        input.context.actorId,
        now,
      )
      return {
        data: { draftVersion: version },
        effects: [{
          kind: current === undefined ? 'created' as const : 'updated' as const,
          reference: `ClinicalDraft/${outpatientCase.case_id}.first-visit`,
          versionId: String(version),
        }],
      }
    })
  }

  saveClinicalDocumentDraft(input: {
    context: ActorContext
    document: ClinicalDocumentContent
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }): CommandResponse<{ caseId: string; draftVersion: number }> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: clinicalDocumentDraftResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        document: input.document,
        encounterId: input.encounterId,
        expectedDraftVersion: input.expectedDraftVersion,
      },
      operation: 'clinical-document.save-draft',
    }, transaction => {
      this.#assertRole(input.context, ['outpatient-doctor'])
      const outpatientCase = this.#caseByEncounter(input.context, input.encounterId)
      this.#assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
      const encounter = transaction.fhir.read(input.context, 'Encounter', input.encounterId)
      if (outpatientCase.status === 'completed' || encounter.status !== 'in-progress') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Clinical Document is not editable')
      }
      if (this.#signedClinicalDocumentRoot(input.context, outpatientCase.case_id) !== undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The signed Clinical Document requires a revision')
      }
      const current = this.#database.driver.prepare(`
        SELECT version FROM clinical_document_draft
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id) as {
        version: number
      } | undefined
      const currentVersion = current?.version ?? 0
      if (currentVersion !== input.expectedDraftVersion) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The Clinical Document draft version has changed',
        )
      }
      const draftVersion = currentVersion + 1
      const now = this.#virtualTime(input.context)
      this.#database.driver.prepare(`
        INSERT INTO clinical_document_draft (
          workspace_id, epoch, case_id, version, content_json, updated_by, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (workspace_id, epoch, case_id) DO UPDATE SET
          version = excluded.version,
          content_json = excluded.content_json,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
        draftVersion,
        JSON.stringify(input.document),
        input.context.actorId,
        now,
      )
      return {
        data: { caseId: outpatientCase.case_id, draftVersion },
        effects: [{
          kind: current === undefined ? 'created' : 'updated',
          reference: `ClinicalDocumentDraft/${outpatientCase.case_id}`,
          versionId: String(draftVersion),
        }],
      }
    })
  }

  previewStructuredClinicalDocumentSign(input: {
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }): CommandResponse<{
    commitToken: string
    document: { content: ClinicalDocumentContent; version: number }
    expiresAt: string
    previewId: string
  }> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: clinicalDocumentSignPreviewResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        encounterId: input.encounterId,
        expectedDraftVersion: input.expectedDraftVersion,
      },
      operation: 'clinical-document.preview-sign',
    }, transaction => {
      this.#assertRole(input.context, ['outpatient-doctor'])
      const outpatientCase = this.#caseByEncounter(input.context, input.encounterId)
      this.#assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
      const encounter = transaction.fhir.read(input.context, 'Encounter', input.encounterId)
      if (outpatientCase.status === 'completed' || encounter.status !== 'in-progress') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Clinical Document is not available for signing')
      }
      if (this.#signedClinicalDocumentRoot(input.context, outpatientCase.case_id) !== undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Clinical Document is already signed')
      }
      const draft = this.#database.driver.prepare(`
        SELECT version, content_json FROM clinical_document_draft
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id) as {
        content_json: string
        version: number
      } | undefined
      if (draft?.version !== input.expectedDraftVersion) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Clinical Document draft version has changed')
      }
      const document = clinicalDocumentContentSchema.parse(JSON.parse(draft.content_json))
      const previewId = uuidv7()
      const commitToken = `${previewId}.${this.#hashToken(`clinical-document-sign:${previewId}`)}`
      const expiresAt = new Date(this.#now().getTime() + 5 * 60_000).toISOString()
      const encounterVersion = z.string().parse(
        input.expectedVersions[`Encounter/${input.encounterId}`],
      )
      this.#database.driver.prepare(`
        INSERT INTO clinical_document_sign_preview (
          workspace_id, epoch, preview_id, case_id, draft_version,
          summary_json, token_hash, expires_at, encounter_version, actor_context_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        previewId,
        outpatientCase.case_id,
        draft.version,
        JSON.stringify(document),
        this.#hashToken(commitToken),
        expiresAt,
        encounterVersion,
        this.#actorContextHash(input.context),
      )
      return {
        data: {
          commitToken,
          document: { content: document, version: draft.version },
          expiresAt,
          previewId,
        },
        effects: [{
          kind: 'created',
          reference: `ClinicalDocumentSignPreview/${previewId}`,
          versionId: '1',
        }],
      }
    })
  }

  signStructuredClinicalDocument(input: {
    commitToken: string
    context: ActorContext
    encounterId: string
    expectedVersions: Record<string, string>
    idempotencyKey: string
    previewId: string
  }): CommandResponse<{
    bundleId: string
    compositionId: string
    compositionVersion: string
    documentId: string
    provenanceId: string
    revisionNumber: 1
  }> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: clinicalDocumentSignResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        commitToken: input.commitToken,
        encounterId: input.encounterId,
        previewId: input.previewId,
      },
      operation: 'clinical-document.sign',
    }, transaction => {
      this.#assertRole(input.context, ['outpatient-doctor'])
      const outpatientCase = this.#caseByEncounter(input.context, input.encounterId)
      this.#assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
      const encounter = transaction.fhir.read(input.context, 'Encounter', input.encounterId)
      if (outpatientCase.status === 'completed' || encounter.status !== 'in-progress') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Clinical Document is not available for signing')
      }
      const preview = this.#database.driver.prepare(`
        SELECT case_id, draft_version, summary_json, token_hash, expires_at, consumed_at,
          encounter_version, actor_context_hash
        FROM clinical_document_sign_preview
        WHERE workspace_id = ? AND epoch = ? AND preview_id = ?
      `).get(input.context.workspaceId, input.context.epoch, input.previewId) as {
        actor_context_hash: string
        case_id: string
        consumed_at: string | null
        draft_version: number
        encounter_version: string
        expires_at: string
        summary_json: string
        token_hash: string
      } | undefined
      if (
        preview === undefined
        || preview.case_id !== outpatientCase.case_id
        || preview.consumed_at !== null
        || preview.token_hash !== this.#hashToken(input.commitToken)
        || Date.parse(preview.expires_at) < this.#now().getTime()
      ) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Clinical Document signing preview is unavailable')
      }
      if (
        preview.encounter_version !== input.expectedVersions[`Encounter/${input.encounterId}`]
        || preview.actor_context_hash !== this.#actorContextHash(input.context)
      ) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The Clinical Document signing preview context has changed',
        )
      }
      const draft = this.#database.driver.prepare(`
        SELECT version, content_json FROM clinical_document_draft
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id) as {
        content_json: string
        version: number
      } | undefined
      if (draft?.version !== preview.draft_version) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Clinical Document draft version has changed')
      }
      const document = clinicalDocumentContentSchema.parse(JSON.parse(draft.content_json))
      const previewDocument = clinicalDocumentContentSchema.parse(JSON.parse(preview.summary_json))
      if (JSON.stringify(previewDocument) !== JSON.stringify(document)) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Clinical Document draft version has changed')
      }
      if (this.#signedClinicalDocumentRoot(input.context, outpatientCase.case_id) !== undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Clinical Document is already signed')
      }
      const now = this.#virtualTime(input.context)
      const compositionId = uuidv7()
      const composition = transaction.fhir.createImmutable(input.context, {
        resourceType: 'Composition',
        id: compositionId,
        status: 'final',
        type: { text: 'Synthetic outpatient structured clinical document' },
        subject: [{ reference: `Patient/${outpatientCase.patient_id}` }],
        encounter: { reference: `Encounter/${input.encounterId}` },
        date: now,
        author: [{ reference: `PractitionerRole/${input.context.practitionerRoleId}` }],
        title: '门诊结构化病历',
        section: structuredClinicalDocumentSections(document),
      })
      const bundleId = uuidv7()
      const bundle = transaction.fhir.createImmutable(input.context, {
        resourceType: 'Bundle',
        id: bundleId,
        type: 'document',
        identifier: {
          system: clinicalDocumentBundleIdentifierSystem,
          value: bundleId,
        },
        timestamp: now,
        entry: this.#documentBundleEntries(input.context, transaction, composition),
      })
      const provenanceId = uuidv7()
      const provenance = transaction.fhir.createImmutable(input.context, {
        resourceType: 'Provenance',
        id: provenanceId,
        target: [
          { reference: `Composition/${compositionId}` },
          { reference: `Bundle/${bundleId}` },
        ],
        recorded: now,
        activity: { text: 'Structured Clinical Document signing' },
        agent: provenanceAgents(input.context, 'Author and signer'),
      })
      const documentId = uuidv7()
      this.#database.driver.prepare(`
        INSERT INTO signed_clinical_document (
          workspace_id, epoch, document_id, case_id, composition_id, bundle_id,
          provenance_id, signed_by, signed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        documentId,
        outpatientCase.case_id,
        compositionId,
        bundleId,
        provenanceId,
        input.context.actorId,
        now,
      )
      this.#database.driver.prepare(`
        UPDATE clinical_document_sign_preview SET consumed_at = ?
        WHERE workspace_id = ? AND epoch = ? AND preview_id = ? AND consumed_at IS NULL
      `).run(now, input.context.workspaceId, input.context.epoch, input.previewId)
      return {
        data: {
          bundleId,
          compositionId,
          compositionVersion: composition.meta?.versionId ?? '1',
          documentId,
          provenanceId,
          revisionNumber: 1,
        },
        effects: [composition, bundle, provenance].map(resource => ({
          kind: 'created' as const,
          reference: `${resource.resourceType}/${resource.id}`,
          versionId: resource.meta?.versionId ?? '1',
        })),
      }
    })
  }

  saveLaboratoryRequestDraft(input: {
    catalogItemId: LaboratoryRequestCatalogItemId
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    indicationCode: string
  }): CommandResponse<{
    caseId: string
    draftVersion: number
  }> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: laboratoryRequestDraftResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        catalogItemId: input.catalogItemId,
        encounterId: input.encounterId,
        expectedDraftVersion: input.expectedDraftVersion,
        indicationCode: input.indicationCode,
      },
      operation: 'laboratory-request.save-draft',
    }, () => {
      const outpatientCase = this.#laboratoryRequestCaseForAction(
        input.context,
        input.encounterId,
        'edit-draft',
      )
      this.#assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
      const catalog = this.#catalogItem(input.context, input.catalogItemId, 'laboratory')
      const catalogConfig = laboratoryCatalogConfigSchema.parse(
        JSON.parse(catalog.config_json ?? '{}') as unknown,
      )
      if (!catalogConfig.allowedIndicationCodes.includes(input.indicationCode)) {
        throw new WorkflowError('CATALOG_CONFLICT', 'The indication is not allowed for this laboratory request')
      }
      const current = this.#laboratoryRequestState(input.context, outpatientCase.case_id)
      const currentVersion = current?.version ?? 0
      if (currentVersion !== input.expectedDraftVersion) {
        throw new WorkflowError(
          'LABORATORY_REQUEST_VERSION_CONFLICT',
          'The laboratory request draft version has changed',
        )
      }
      const nextVersion = currentVersion + 1
      const now = this.#virtualTime(input.context)
      if (current === undefined) {
        this.#database.driver.prepare(`
          INSERT INTO laboratory_request_state (
            workspace_id, epoch, case_id, version, draft_catalog_item_id,
            draft_indication_code, updated_by, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.context.workspaceId,
          input.context.epoch,
          outpatientCase.case_id,
          nextVersion,
          input.catalogItemId,
          input.indicationCode,
          input.context.actorId,
          now,
        )
      } else {
        const update = this.#database.driver.prepare(`
          UPDATE laboratory_request_state
          SET version = ?, draft_catalog_item_id = ?, draft_indication_code = ?,
            updated_by = ?, updated_at = ?
          WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND version = ?
        `).run(
          nextVersion,
          input.catalogItemId,
          input.indicationCode,
          input.context.actorId,
          now,
          input.context.workspaceId,
          input.context.epoch,
          outpatientCase.case_id,
          currentVersion,
        )
        if (update.changes !== 1) {
          throw new WorkflowError(
            'LABORATORY_REQUEST_VERSION_CONFLICT',
            'The laboratory request draft version has changed',
          )
        }
      }
      return {
        data: { caseId: outpatientCase.case_id, draftVersion: nextVersion },
        effects: [],
      }
    })
  }

  deleteLaboratoryRequestDraft(input: {
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }): CommandResponse<{
    caseId: string
    draftVersion: number
  }> {
    return this.#commands.execute({
      authorize: () => {
        this.#assertRole(input.context, ['outpatient-doctor'])
        const outpatientCase = this.#caseByEncounter(input.context, input.encounterId)
        this.#assertCaseResponsibility(input.context, outpatientCase.case_id)
      },
      context: input.context,
      dataSchema: laboratoryRequestDraftResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        encounterId: input.encounterId,
        expectedDraftVersion: input.expectedDraftVersion,
      },
      mapExpectedVersionConflict: error => this.#expectedVersionWorkflowError(error, {
        code: 'LABORATORY_REQUEST_VERSION_CONFLICT',
        currentStatus: this.#laboratoryRequestDraftConflictStatus(
          input.context,
          input.encounterId,
        ),
        message: 'A laboratory request draft resource version has changed',
        owner: 'laboratory-request-draft',
        resource: `Encounter/${input.encounterId}`,
      }),
      operation: 'laboratory-request.delete-draft',
    }, () => {
      const outpatientCase = this.#laboratoryRequestCaseForAction(
        input.context,
        input.encounterId,
        'edit-draft',
      )
      this.#assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
      const current = this.#laboratoryRequestState(input.context, outpatientCase.case_id)
      if (current === undefined) {
        throw new WorkflowError(
          'LABORATORY_REQUEST_VERSION_CONFLICT',
          'The laboratory request draft does not exist',
          {
            currentStatus: 'missing',
            expectedVersion: String(input.expectedDraftVersion),
            owner: 'laboratory-request-draft',
            resource: `LaboratoryRequestDraft/${outpatientCase.case_id}`,
          },
        )
      }
      if (current.draft_catalog_item_id === null) {
        throw new WorkflowError(
          'LABORATORY_REQUEST_VERSION_CONFLICT',
          `The laboratory request draft is empty at version ${current.version}`,
          {
            currentStatus: 'empty',
            currentVersion: String(current.version),
            expectedVersion: String(input.expectedDraftVersion),
            owner: 'laboratory-request-draft',
            resource: `LaboratoryRequestDraft/${outpatientCase.case_id}`,
          },
        )
      }
      if (current.version !== input.expectedDraftVersion) {
        throw new WorkflowError(
          'LABORATORY_REQUEST_VERSION_CONFLICT',
          `The laboratory request draft is at version ${current.version}; expected version ${input.expectedDraftVersion}`,
          {
            currentStatus: 'draft',
            currentVersion: String(current.version),
            expectedVersion: String(input.expectedDraftVersion),
            owner: 'laboratory-request-draft',
            resource: `LaboratoryRequestDraft/${outpatientCase.case_id}`,
          },
        )
      }
      const draftVersion = current.version + 1
      const update = this.#database.driver.prepare(`
        UPDATE laboratory_request_state
        SET version = ?, draft_catalog_item_id = NULL, draft_indication_code = NULL,
          updated_by = ?, updated_at = ?
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND version = ?
          AND draft_catalog_item_id IS NOT NULL
      `).run(
        draftVersion,
        input.context.actorId,
        this.#virtualTime(input.context),
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
        current.version,
      )
      if (update.changes !== 1) {
        throw new WorkflowError(
          'LABORATORY_REQUEST_VERSION_CONFLICT',
          'The laboratory request draft version has changed',
        )
      }
      return {
        data: { caseId: outpatientCase.case_id, draftVersion },
        effects: [{
          kind: 'updated' as const,
          reference: `LaboratoryRequestDraft/${outpatientCase.case_id}`,
          versionId: String(draftVersion),
        }],
      }
    })
  }

  issueLaboratoryRequest(input: {
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
  }) {
    return this.#commands.execute({
      context: input.context,
      dataSchema: issueLaboratoryRequestResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        encounterId: input.encounterId,
        expectedDraftVersion: input.expectedDraftVersion,
      },
      operation: 'laboratory-request.issue',
    }, (transaction) => {
      const outpatientCase = this.#laboratoryRequestCaseForAction(
        input.context,
        input.encounterId,
        'issue',
      )
      this.#assertExpectedVersions(input.expectedVersions, [`Encounter/${input.encounterId}`])
      const state = this.#laboratoryRequestState(input.context, outpatientCase.case_id)
      if (state === undefined
        || state.version !== input.expectedDraftVersion
        || state.draft_catalog_item_id === null
        || state.draft_indication_code === null) {
        throw new WorkflowError(
          'LABORATORY_REQUEST_VERSION_CONFLICT',
          'The laboratory request draft version has changed',
        )
      }
      const duplicate = this.#database.driver.prepare(`
        SELECT request_id FROM laboratory_request
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
          AND catalog_item_id = ? AND status IN ('issued', 'accepted', 'in-progress')
      `).get(
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
        state.draft_catalog_item_id,
      )
      if (duplicate !== undefined) {
        throw new WorkflowError(
          'LABORATORY_REQUEST_DUPLICATE',
          'An active laboratory request already exists for this catalog item',
        )
      }
      const catalog = this.#catalogItem(input.context, state.draft_catalog_item_id, 'laboratory')
      const catalogConfig = laboratoryCatalogConfigSchema.parse(
        JSON.parse(catalog.config_json ?? '{}') as unknown,
      )
      if (!catalogConfig.allowedIndicationCodes.includes(state.draft_indication_code)) {
        throw new WorkflowError('CATALOG_CONFLICT', 'The indication is not allowed for this laboratory request')
      }
      const allergyCodes = this.#patientAllergyCodes(input.context, outpatientCase.patient_id)
      if (catalogConfig.contraindicatedAllergyCodes.some(code => allergyCodes.has(code))) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory request is contraindicated')
      }
      const requestId = uuidv7()
      const serviceRequestId = uuidv7()
      const taskId = uuidv7()
      const now = this.#virtualTime(input.context)
      const serviceRequest = transaction.fhir.create(input.context, {
        resourceType: 'ServiceRequest',
        id: serviceRequestId,
        status: 'active',
        intent: 'order',
        code: {
          concept: {
            coding: [{
              code: catalog.code,
              display: catalog.name_zh,
              system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/laboratory-service',
            }],
            text: catalog.name_zh,
          },
        },
        subject: { reference: `Patient/${outpatientCase.patient_id}` },
        encounter: { reference: `Encounter/${input.encounterId}` },
        authoredOn: now,
        requester: { reference: `PractitionerRole/${input.context.practitionerRoleId}` },
        reason: [{
          concept: {
            coding: [{
              code: state.draft_indication_code,
              system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/laboratory-indication',
            }],
          },
        }],
      })
      const task = transaction.fhir.create(input.context, {
        resourceType: 'Task',
        id: taskId,
        status: 'requested',
        intent: 'order',
        code: {
          coding: [{
            code: 'laboratory-request-execution',
            system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/task-kind',
          }],
          text: `${catalog.name_zh}执行`,
        },
        focus: { reference: `ServiceRequest/${serviceRequestId}` },
        for: { reference: `Patient/${outpatientCase.patient_id}` },
        encounter: { reference: `Encounter/${input.encounterId}` },
        authoredOn: now,
        requester: { reference: `PractitionerRole/${input.context.practitionerRoleId}` },
        owner: { reference: 'Organization/organization-clinmesh' },
      })
      this.#database.driver.prepare(`
        INSERT INTO laboratory_request (
          workspace_id, epoch, request_id, case_id, catalog_item_id,
          indication_code, service_request_id, execution_task_id, status,
          version, authored_by, authored_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'issued', 1, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        requestId,
        outpatientCase.case_id,
        state.draft_catalog_item_id,
        state.draft_indication_code,
        serviceRequestId,
        taskId,
        input.context.practitionerId ?? input.context.actorId,
        now,
      )
      const draftVersion = state.version + 1
      const update = this.#database.driver.prepare(`
        UPDATE laboratory_request_state
        SET version = ?, draft_catalog_item_id = NULL, draft_indication_code = NULL,
          updated_by = ?, updated_at = ?
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND version = ?
      `).run(
        draftVersion,
        input.context.actorId,
        now,
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
        state.version,
      )
      if (update.changes !== 1) {
        throw new WorkflowError(
          'LABORATORY_REQUEST_VERSION_CONFLICT',
          'The laboratory request draft version has changed',
        )
      }
      transaction.enqueue({
        dedupKey: `laboratory-request:${requestId}:accept`,
        kind: 'laboratory.accept-request',
        payload: { requestId },
      })
      return {
        data: {
          caseId: outpatientCase.case_id,
          draftVersion,
          request: {
            catalogItemId: state.draft_catalog_item_id,
            id: requestId,
            indicationCode: state.draft_indication_code,
            previousReports: [],
            serviceRequestId,
            serviceRequestVersion: serviceRequest.meta?.versionId ?? '1',
            status: 'issued' as const,
            taskId,
            taskVersion: task.meta?.versionId ?? '1',
            version: 1,
          },
        },
        effects: [serviceRequest, task].map(resource => ({
          kind: 'created' as const,
          reference: `${resource.resourceType}/${resource.id}`,
          versionId: resource.meta?.versionId ?? '1',
        })),
      }
    })
  }

  cancelLaboratoryRequest(input: {
    context: ActorContext
    expectedRequestVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    reasonCode: 'no-longer-needed'
    requestId: string
  }) {
    const execute = () => this.#commands.execute({
      authorize: () => {
        this.#assertRole(input.context, ['outpatient-doctor'])
        const request = this.#laboratoryRequest(input.context, input.requestId)
        if (request === undefined
          || request.authored_by !== (
            input.context.practitionerId ?? input.context.actorId
          )) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory request was not found')
        }
        this.#assertCaseResponsibility(input.context, request.case_id)
      },
      context: input.context,
      dataSchema: laboratoryRequestActionResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        expectedRequestVersion: input.expectedRequestVersion,
        reasonCode: input.reasonCode,
        requestId: input.requestId,
      },
      operation: 'laboratory-request.cancel',
    }, (transaction) => {
      const request = this.#laboratoryRequest(input.context, input.requestId)
      if (request === undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory request was not found')
      }
      this.#assertExpectedVersions(input.expectedVersions, [
        `ServiceRequest/${request.service_request_id}`,
        `Task/${request.execution_task_id}`,
      ])
      if (request.version !== input.expectedRequestVersion) {
        throw new WorkflowError(
          'LABORATORY_REQUEST_VERSION_CONFLICT',
          `The laboratory request is "${request.status}" at version ${request.version}; expected version ${input.expectedRequestVersion}`,
          {
            currentStatus: request.status,
            currentVersion: String(request.version),
            expectedVersion: String(input.expectedRequestVersion),
            owner: 'laboratory-request',
            resource: `LaboratoryRequest/${request.request_id}`,
          },
        )
      }
      if (request.status !== 'issued') {
        throw new WorkflowError(
          'LABORATORY_REQUEST_NOT_CANCELLABLE',
          `The laboratory request cannot be cancelled from status "${request.status}"`,
          {
            currentStatus: request.status,
            currentVersion: String(request.version),
            owner: 'laboratory-request',
            resource: `LaboratoryRequest/${request.request_id}`,
          },
        )
      }
      const serviceRequest = transaction.fhir.read(
        input.context,
        'ServiceRequest',
        request.service_request_id,
      )
      const task = transaction.fhir.read(input.context, 'Task', request.execution_task_id)
      const now = this.#virtualTime(input.context)
      const updatedServiceRequest = transaction.fhir.update(input.context, {
        ...serviceRequest,
        status: 'revoked',
      }, serviceRequest.meta?.versionId ?? '1')
      const updatedTask = transaction.fhir.update(input.context, {
        ...task,
        status: 'cancelled',
        lastModified: now,
        statusReason: {
          concept: {
            coding: [{
              code: input.reasonCode,
              system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/request-status-reason',
            }],
          },
        },
      }, task.meta?.versionId ?? '1')
      const version = request.version + 1
      const update = this.#database.driver.prepare(`
        UPDATE laboratory_request
        SET status = 'cancelled', version = ?, cancelled_at = ?
        WHERE workspace_id = ? AND epoch = ? AND request_id = ?
          AND status = 'issued' AND version = ?
      `).run(
        version,
        now,
        input.context.workspaceId,
        input.context.epoch,
        request.request_id,
        request.version,
      )
      if (update.changes !== 1) {
        throw new WorkflowError(
          'LABORATORY_REQUEST_VERSION_CONFLICT',
          'The laboratory request version has changed',
        )
      }
      return {
        data: {
          request: {
            catalogItemId: request.catalog_item_id,
            id: request.request_id,
            indicationCode: request.indication_code,
            previousReports: [],
            serviceRequestId: request.service_request_id,
            serviceRequestVersion: updatedServiceRequest.meta?.versionId ?? '2',
            status: 'cancelled' as const,
            taskId: request.execution_task_id,
            taskVersion: updatedTask.meta?.versionId ?? '2',
            version,
          },
        },
        effects: [updatedServiceRequest, updatedTask].map(resource => ({
          kind: 'updated' as const,
          reference: `${resource.resourceType}/${resource.id}`,
          versionId: resource.meta?.versionId ?? '2',
        })),
      }
    })

    try {
      return execute()
    } catch (error) {
      if (error instanceof ExpectedVersionConflictError) {
        const current = this.#laboratoryRequest(input.context, input.requestId)
        if (current === undefined) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory request was not found')
        }
        throw new WorkflowError(
          'LABORATORY_REQUEST_VERSION_CONFLICT',
          `The laboratory request is "${current.status}" at version ${current.version}; a related resource version has changed`,
          {
            currentStatus: current.status,
            currentVersion: String(current.version),
            expectedVersion: String(input.expectedRequestVersion),
            owner: 'laboratory-request',
            resource: `LaboratoryRequest/${current.request_id}`,
          },
        )
      }
      throw error
    }
  }

  acceptLaboratoryRequest(input: {
    context: ActorContext
    eventId: string
    requestId: string
  }) {
    return this.#commands.execute({
      context: input.context,
      dataSchema: laboratoryRequestSystemResponseSchema,
      expectedVersions: {},
      idempotencyKey: input.eventId,
      input: { requestId: input.requestId },
      operation: 'laboratory-request.accept',
    }, (transaction) => {
      this.#assertRole(input.context, ['lis-system'])
      const request = this.#laboratoryRequest(input.context, input.requestId)
      if (request === undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory request was not found')
      }
      if (request.status === 'cancelled') {
        return {
          data: { requestId: request.request_id, status: 'cancelled' as const },
          effects: [],
        }
      }
      if (request.status !== 'issued') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory request cannot be accepted')
      }
      const task = transaction.fhir.read(input.context, 'Task', request.execution_task_id)
      const now = this.#virtualTime(input.context)
      const updatedTask = transaction.fhir.update(input.context, {
        ...task,
        status: 'accepted',
        lastModified: now,
      }, task.meta?.versionId ?? '1')
      const update = this.#database.driver.prepare(`
        UPDATE laboratory_request
        SET status = 'accepted', version = version + 1, accepted_at = ?
        WHERE workspace_id = ? AND epoch = ? AND request_id = ?
          AND status = 'issued' AND version = ?
      `).run(
        now,
        input.context.workspaceId,
        input.context.epoch,
        request.request_id,
        request.version,
      )
      if (update.changes !== 1) {
        throw new WorkflowError(
          'LABORATORY_REQUEST_VERSION_CONFLICT',
          'The laboratory request version has changed',
        )
      }
      transaction.enqueue({
        dedupKey: `laboratory-request:${request.request_id}:start`,
        kind: 'laboratory.start-request',
        payload: { requestId: request.request_id },
      })
      return {
        data: { requestId: request.request_id, status: 'accepted' as const },
        effects: [{
          kind: 'updated' as const,
          reference: `Task/${updatedTask.id}`,
          versionId: updatedTask.meta?.versionId ?? '2',
        }],
      }
    })
  }

  startLaboratoryRequest(input: {
    context: ActorContext
    eventId: string
    requestId: string
  }) {
    return this.#commands.execute({
      context: input.context,
      dataSchema: laboratoryRequestSystemResponseSchema,
      expectedVersions: {},
      idempotencyKey: input.eventId,
      input: { requestId: input.requestId },
      operation: 'laboratory-request.start',
    }, (transaction) => {
      this.#assertRole(input.context, ['lis-system'])
      const request = this.#laboratoryRequest(input.context, input.requestId)
      if (request === undefined || request.status !== 'accepted') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory request cannot start execution')
      }
      const task = transaction.fhir.read(input.context, 'Task', request.execution_task_id)
      const now = this.#virtualTime(input.context)
      const updatedTask = transaction.fhir.update(input.context, {
        ...task,
        status: 'in-progress',
        lastModified: now,
        executionPeriod: {
          ...((typeof task.executionPeriod === 'object' && task.executionPeriod !== null)
            ? task.executionPeriod as Record<string, unknown>
            : {}),
          start: now,
        },
      }, task.meta?.versionId ?? '2')
      const update = this.#database.driver.prepare(`
        UPDATE laboratory_request
        SET status = 'in-progress', version = version + 1, started_at = ?
        WHERE workspace_id = ? AND epoch = ? AND request_id = ?
          AND status = 'accepted' AND version = ?
      `).run(
        now,
        input.context.workspaceId,
        input.context.epoch,
        request.request_id,
        request.version,
      )
      if (update.changes !== 1) {
        throw new WorkflowError(
          'LABORATORY_REQUEST_VERSION_CONFLICT',
          'The laboratory request version has changed',
        )
      }
      if (this.#supportsLaboratoryReports(input.context)) {
        transaction.enqueue({
          dedupKey: `laboratory-request:${request.request_id}:report`,
          kind: 'laboratory.report-request',
          payload: { requestId: request.request_id },
        })
      }
      return {
        data: { requestId: request.request_id, status: 'in-progress' as const },
        effects: [{
          kind: 'updated' as const,
          reference: `Task/${updatedTask.id}`,
          versionId: updatedTask.meta?.versionId ?? '3',
        }],
      }
    })
  }

  reportLaboratoryRequest(input: {
    context: ActorContext
    eventId: string
    requestId: string
  }) {
    return this.#commands.execute({
      context: input.context,
      dataSchema: laboratoryReportSystemResponseSchema,
      expectedVersions: {},
      idempotencyKey: input.eventId,
      input: { requestId: input.requestId },
      operation: 'laboratory-request.report',
    }, (transaction) => {
      this.#assertRole(input.context, ['lis-system'])
      const request = this.#laboratoryRequest(input.context, input.requestId)
      if (request === undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory request was not found')
      }
      if (request.status === 'reported' && request.diagnostic_report_id !== null) {
        transaction.fhir.read(input.context, 'DiagnosticReport', request.diagnostic_report_id)
        return {
          data: {
            diagnosticReportId: request.diagnostic_report_id,
            requestId: request.request_id,
            status: 'reported' as const,
          },
          effects: [],
        }
      }
      if (request.status !== 'in-progress') {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'Only an in-progress laboratory request can be reported',
        )
      }
      const scenarioContent = this.#activeScenarioDataset(input.context)
      const repeatIndex = scenarioContent === undefined
        ? 0
        : (this.#database.driver.prepare(`
          SELECT COUNT(*) AS count FROM laboratory_request
          WHERE workspace_id = ? AND epoch = ? AND case_id = ?
            AND catalog_item_id = ? AND reported_at IS NOT NULL
        `).get(
          input.context.workspaceId,
          input.context.epoch,
          request.case_id,
          request.catalog_item_id,
        ) as { count: number }).count
      const scenarioResult = scenarioContent === undefined
        ? undefined
        : {
            content: scenarioContent,
            resolution: resolveScenarioInvestigation({
              catalogItemId: request.catalog_item_id,
              content: scenarioContent,
              indicationCode: request.indication_code,
              patientId: request.patient_id,
              repeatIndex,
              scenarioRunId: input.context.scenarioRunId,
            }),
          }
      const scenarioResolution = scenarioResult?.resolution
      const laboratoryResultFact = scenarioResult === undefined
        ? this.#legacyLaboratoryResultFact(input.context, request.catalog_item_id)
        : scenarioLaboratoryResultFact(scenarioResult.content, scenarioResult.resolution)
      const serviceRequest = transaction.fhir.read(
        input.context,
        'ServiceRequest',
        request.service_request_id,
      )
      const task = transaction.fhir.read(input.context, 'Task', request.execution_task_id)
      if (serviceRequest.status !== 'active' || task.status !== 'in-progress') {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The formal laboratory request is not in progress',
        )
      }
      const specimenId = `sp-${request.service_request_id}`
      const diagnosticReportId = `dr-${request.service_request_id}`
      const provenanceId = `prov-${request.service_request_id}`
      const now = this.#virtualTime(input.context)
      const specimen = transaction.fhir.create(input.context, {
        resourceType: 'Specimen',
        id: specimenId,
        status: 'available',
        type: {
          coding: [{
            code: '119297000',
            display: 'Blood specimen',
            system: 'http://snomed.info/sct',
          }],
          text: 'Synthetic blood specimen',
        },
        subject: { reference: `Patient/${request.patient_id}` },
        request: [{ reference: `ServiceRequest/${request.service_request_id}` }],
        collection: { collectedDateTime: now },
        receivedTime: now,
      })
      const observations = laboratoryResultFact.results.map((result) => {
        const observationId = `obs-${result.code}-${request.service_request_id}`
        const interpretationCode = result.interpretation === 'normal'
          ? 'N'
          : result.interpretation === 'high' ? 'H' : 'L'
        const value = typeof result.value === 'number'
          ? result.unit === undefined
            ? { valueQuantity: { value: result.value } }
            : {
                valueQuantity: {
                  code: result.unit.code,
                  system: result.unit.system,
                  unit: result.unit.display,
                  value: result.value,
                },
              }
          : typeof result.value === 'boolean'
            ? { valueBoolean: result.value }
            : { valueString: result.value }
        return transaction.fhir.create(input.context, {
          resourceType: 'Observation',
          id: observationId,
          status: 'final',
          category: [{
            coding: [{
              code: 'laboratory',
              system: 'http://terminology.hl7.org/CodeSystem/observation-category',
            }],
          }],
          code: {
            coding: [{ code: result.code, display: result.display, system: 'http://loinc.org' }],
            text: result.display,
          },
          subject: { reference: `Patient/${request.patient_id}` },
          encounter: { reference: `Encounter/${request.encounter_id}` },
          basedOn: [{ reference: `ServiceRequest/${request.service_request_id}` }],
          specimen: { reference: `Specimen/${specimenId}` },
          effectiveDateTime: now,
          issued: now,
          ...value,
          referenceRange: [{
            ...(result.referenceRange.low === undefined ? {} : {
              low: {
                ...(result.unit === undefined ? {} : {
                  code: result.unit.code,
                  system: result.unit.system,
                  unit: result.unit.display,
                }),
                value: result.referenceRange.low,
              },
            }),
            ...(result.referenceRange.high === undefined ? {} : {
              high: {
                ...(result.unit === undefined ? {} : {
                  code: result.unit.code,
                  system: result.unit.system,
                  unit: result.unit.display,
                }),
                value: result.referenceRange.high,
              },
            }),
            text: result.referenceRange.text,
          }],
          interpretation: [{
            coding: [{
              code: interpretationCode,
              system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
            }],
          }],
        })
      })
      const reportName = scenarioResolution === undefined
        ? request.catalog_item_id === 'lab-cbc' ? '血常规报告' : 'C 反应蛋白报告'
        : `${scenarioResolution.name}报告`
      const report = transaction.fhir.create(input.context, {
        resourceType: 'DiagnosticReport',
        id: diagnosticReportId,
        status: 'final',
        ...(scenarioResolution === undefined ? {} : {
          extension: [
            {
              url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/investigation-source-level',
              valueCode: scenarioResolution.sourceLevel,
            },
            {
              url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/investigation-tat-minutes',
              valueInteger: scenarioResolution.tatMinutes,
            },
            {
              url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/investigation-fee',
              valueMoney: { currency: 'CNY', value: scenarioResolution.feeFen / 100 },
            },
            {
              url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/investigation-critical',
              valueBoolean: scenarioResolution.critical,
            },
            ...scenarioResolution.diagnostics.map(diagnostic => ({
              url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/investigation-diagnostic',
              valueCode: diagnostic,
            })),
          ],
        }),
        code: {
          coding: [{
            code: scenarioContent?.catalog.investigations.find(
              item => item.id === request.catalog_item_id,
            )?.code ?? (request.catalog_item_id === 'lab-cbc' ? 'CBC' : 'CRP'),
            display: reportName,
            system: 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/laboratory-service',
          }],
          text: reportName,
        },
        subject: { reference: `Patient/${request.patient_id}` },
        encounter: { reference: `Encounter/${request.encounter_id}` },
        basedOn: [{ reference: `ServiceRequest/${request.service_request_id}` }],
        specimen: [{ reference: `Specimen/${specimenId}` }],
        result: observations.map(observation => ({
          reference: `Observation/${observation.id}`,
        })),
        effectiveDateTime: now,
        issued: now,
        conclusion: laboratoryResultFact.conclusion,
      })
      const completedServiceRequest = transaction.fhir.update(input.context, {
        ...serviceRequest,
        status: 'completed',
      }, serviceRequest.meta?.versionId ?? '1')
      const completedTask = transaction.fhir.update(input.context, {
        ...task,
        status: 'completed',
        lastModified: now,
        executionPeriod: {
          ...((typeof task.executionPeriod === 'object' && task.executionPeriod !== null)
            ? task.executionPeriod as Record<string, unknown>
            : {}),
          end: now,
        },
      }, task.meta?.versionId ?? '3')
      const provenance = transaction.fhir.createImmutable(input.context, {
        resourceType: 'Provenance',
        id: provenanceId,
        target: [
          { reference: `Specimen/${specimenId}` },
          { reference: `DiagnosticReport/${diagnosticReportId}` },
          ...observations.map(observation => ({ reference: `Observation/${observation.id}` })),
          { reference: `ServiceRequest/${request.service_request_id}` },
          { reference: `Task/${request.execution_task_id}` },
        ],
        recorded: now,
        activity: { text: 'Laboratory result generation and report issuance' },
        agent: provenanceAgents(input.context, 'Laboratory report issuer'),
      })
      const update = this.#database.driver.prepare(`
        UPDATE laboratory_request
        SET status = 'reported', version = version + 1, reported_at = ?,
          diagnostic_report_id = ?
        WHERE workspace_id = ? AND epoch = ? AND request_id = ?
          AND status = 'in-progress' AND version = ?
      `).run(
        now,
        diagnosticReportId,
        input.context.workspaceId,
        input.context.epoch,
        request.request_id,
        request.version,
      )
      if (update.changes !== 1) {
        throw new WorkflowError(
          'LABORATORY_REQUEST_VERSION_CONFLICT',
          'The laboratory request version has changed',
        )
      }
      return {
        data: {
          diagnosticReportId,
          requestId: request.request_id,
          status: 'reported' as const,
        },
        effects: [
          specimen,
          ...observations,
          report,
          provenance,
          completedServiceRequest,
          completedTask,
        ].map(resource => ({
          kind: resource.meta?.versionId === '1' ? 'created' as const : 'updated' as const,
          reference: `${resource.resourceType}/${resource.id}`,
          versionId: resource.meta?.versionId ?? '1',
        })),
      }
    })
  }

  acknowledgeLaboratoryReport(input: {
    context: ActorContext
    diagnosticReportId: string
    expectedRequestVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    requestId: string
  }): CommandResponse<{
    acknowledgementId: string
    acknowledgedAt: string
    acknowledgedBy: string
    diagnosticReportId: string
    requestId: string
    requestVersion: number
    status: 'acknowledged'
  }> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: acknowledgeLaboratoryReportResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        diagnosticReportId: input.diagnosticReportId,
        expectedRequestVersion: input.expectedRequestVersion,
        requestId: input.requestId,
      },
      operation: 'laboratory-report.acknowledge',
    }, (transaction) => {
      this.#assertRole(input.context, ['outpatient-doctor'])
      this.#assertExpectedVersions(
        input.expectedVersions,
        [`DiagnosticReport/${input.diagnosticReportId}`],
      )
      const request = this.#laboratoryRequest(input.context, input.requestId)
      if (request === undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory request was not found')
      }
      const practitionerId = input.context.practitionerId
      if (practitionerId === undefined || request.authored_by !== practitionerId) {
        throw new WorkflowError(
          'ROLE_NOT_ALLOWED',
          'Only the doctor responsible for the laboratory request can acknowledge its report',
        )
      }
      const existing = laboratoryReportAcknowledgementRowSchema.optional().parse(
        this.#database.driver.prepare(`
          SELECT acknowledgement_id, acknowledged_at, acknowledged_by,
            diagnostic_report_id, request_id, request_version
          FROM laboratory_report_acknowledgement
          WHERE workspace_id = ? AND epoch = ? AND diagnostic_report_id = ?
        `).get(
          input.context.workspaceId,
          input.context.epoch,
          input.diagnosticReportId,
        ),
      )
      if (existing !== undefined) {
        if (existing.request_id !== request.request_id || existing.acknowledged_by !== practitionerId) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory report acknowledgement is invalid')
        }
        return {
          data: {
            acknowledgementId: existing.acknowledgement_id,
            acknowledgedAt: existing.acknowledged_at,
            acknowledgedBy: existing.acknowledged_by,
            diagnosticReportId: existing.diagnostic_report_id,
            requestId: existing.request_id,
            requestVersion: existing.request_version,
            status: 'acknowledged' as const,
          },
          effects: [],
        }
      }
      if (request.diagnostic_report_id !== input.diagnosticReportId || request.status !== 'reported') {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'Only the current signed laboratory report can be acknowledged',
        )
      }
      if (request.version !== input.expectedRequestVersion) {
        throw new WorkflowError(
          'LABORATORY_REQUEST_VERSION_CONFLICT',
          'The laboratory request version has changed',
        )
      }
      const report = transaction.fhir.read(
        input.context,
        'DiagnosticReport',
        input.diagnosticReportId,
      )
      if (report.status !== 'final') {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'Only a signed laboratory report can be acknowledged',
        )
      }
      laboratoryDiagnosticReportContentSchema.parse(report)
      const acknowledgementId = uuidv7()
      const acknowledgedAt = this.#virtualTime(input.context)
      this.#database.driver.prepare(`
        INSERT INTO laboratory_report_acknowledgement (
          workspace_id, epoch, acknowledgement_id, request_id, diagnostic_report_id,
          acknowledged_by, acknowledged_by_practitioner_role_id, acknowledged_at,
          request_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        acknowledgementId,
        request.request_id,
        input.diagnosticReportId,
        practitionerId,
        input.context.practitionerRoleId,
        acknowledgedAt,
        request.version + 1,
      )
      const update = this.#database.driver.prepare(`
        UPDATE laboratory_request
        SET status = 'acknowledged', version = version + 1, acknowledged_at = ?
        WHERE workspace_id = ? AND epoch = ? AND request_id = ?
          AND status = 'reported' AND version = ? AND diagnostic_report_id = ?
      `).run(
        acknowledgedAt,
        input.context.workspaceId,
        input.context.epoch,
        request.request_id,
        request.version,
        input.diagnosticReportId,
      )
      if (update.changes !== 1) {
        throw new WorkflowError(
          'LABORATORY_REQUEST_VERSION_CONFLICT',
          'The laboratory request version has changed',
        )
      }
      return {
        data: {
          acknowledgementId,
          acknowledgedAt,
          acknowledgedBy: practitionerId,
          diagnosticReportId: input.diagnosticReportId,
          requestId: request.request_id,
          requestVersion: request.version + 1,
          status: 'acknowledged' as const,
        },
        effects: [{
          kind: 'created' as const,
          reference: `ReportAcknowledgement/${acknowledgementId}`,
          versionId: '1',
        }],
      }
    })
  }

  correctLaboratoryReport(input: {
    conclusion: string
    context: ActorContext
    diagnosticReportId: string
    expectedRequestVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    reason: string
    requestId: string
    results: Array<{ code: string; value: number }>
  }): CommandResponse<{
    diagnosticReportId: string
    previousDiagnosticReportId: string
    provenanceId: string
    requestId: string
    requestVersion: number
    status: 'reported'
  }> {
    return this.#commands.execute({
      authorize: () => this.#assertRole(input.context, ['lis-system']),
      context: input.context,
      dataSchema: correctLaboratoryReportResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        conclusion: input.conclusion,
        diagnosticReportId: input.diagnosticReportId,
        expectedRequestVersion: input.expectedRequestVersion,
        reason: input.reason,
        requestId: input.requestId,
        results: input.results,
      },
      mapExpectedVersionConflict: error => this.#expectedVersionWorkflowError(error, {
        code: 'LABORATORY_REQUEST_VERSION_CONFLICT',
        currentStatus: this.#laboratoryReportConflictStatus(
          input.context,
          input.requestId,
          input.diagnosticReportId,
        ),
        message: 'A laboratory report resource version has changed',
        owner: 'laboratory-report',
        resource: `DiagnosticReport/${input.diagnosticReportId}`,
      }),
      operation: 'laboratory-report.correct',
    }, (transaction) => {
      this.#assertExpectedVersions(
        input.expectedVersions,
        [`DiagnosticReport/${input.diagnosticReportId}`],
      )
      const request = this.#laboratoryRequest(input.context, input.requestId)
      if (request === undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory request was not found')
      }
      if (request.version !== input.expectedRequestVersion) {
        throw new WorkflowError(
          'LABORATORY_REQUEST_VERSION_CONFLICT',
          `The laboratory request is "${request.status}" at version ${request.version}; expected version ${input.expectedRequestVersion}`,
          {
            currentStatus: request.status,
            currentVersion: String(request.version),
            expectedVersion: String(input.expectedRequestVersion),
            owner: 'laboratory-report',
            resource: `DiagnosticReport/${input.diagnosticReportId}`,
          },
        )
      }
      if (request.diagnostic_report_id !== input.diagnosticReportId) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The laboratory report is superseded; only the latest signed report can be corrected',
          {
            currentStatus: 'superseded',
            currentVersion: String(request.version),
            expectedVersion: String(input.expectedRequestVersion),
            owner: 'laboratory-report',
            resource: `DiagnosticReport/${input.diagnosticReportId}`,
          },
        )
      }
      if (request.status !== 'reported' && request.status !== 'acknowledged') {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          `The laboratory report cannot be corrected while the request status is "${request.status}"`,
          {
            currentStatus: request.status,
            currentVersion: String(request.version),
            owner: 'laboratory-report',
            resource: `DiagnosticReport/${input.diagnosticReportId}`,
          },
        )
      }
      const sourceReportResource = transaction.fhir.read(
        input.context,
        'DiagnosticReport',
        input.diagnosticReportId,
      )
      if (sourceReportResource.status !== 'final') {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'Only a signed laboratory report can be corrected',
        )
      }
      const sourceReport = laboratoryDiagnosticReportContentSchema.parse(sourceReportResource)
      const currentReport = this.#laboratoryReport(
        input.context,
        request.request_id,
        input.diagnosticReportId,
        request.service_request_id,
      )
      const corrections = new Map(input.results.map(result => [result.code, result.value]))
      if (
        corrections.size !== currentReport.results.length
        || currentReport.results.some(result => !corrections.has(result.code))
      ) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The laboratory report correction must include each existing result exactly once',
        )
      }
      const now = this.#virtualTime(input.context)
      const sourceObservations = sourceReport.result.map((reference) => {
        if (!reference.reference.startsWith('Observation/')) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory report result is invalid')
        }
        const observationId = reference.reference.slice('Observation/'.length)
        const resource = transaction.fhir.read(input.context, 'Observation', observationId)
        return {
          content: laboratoryObservationContentSchema.parse(resource),
          id: observationId,
          resource,
        }
      })
      const observations = sourceObservations.map((source) => {
        const code = source.content.code.coding[0]?.code
        const referenceRange = source.content.referenceRange[0]
        if (
          code === undefined
          || referenceRange === undefined
          || source.content.valueQuantity === undefined
          || (referenceRange.low === undefined && referenceRange.high === undefined)
        ) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory result is incomplete')
        }
        const value = corrections.get(code)
        if (value === undefined) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory result correction is incomplete')
        }
        const interpretation = referenceRange.low !== undefined && value < referenceRange.low.value
          ? 'L'
          : referenceRange.high !== undefined && value > referenceRange.high.value ? 'H' : 'N'
        const content = Object.fromEntries(Object.entries(source.resource).filter(
          ([key]) => key !== 'id' && key !== 'meta',
        ))
        return transaction.fhir.create(input.context, {
          ...content,
          resourceType: 'Observation',
          id: uuidv7(),
          status: 'final',
          effectiveDateTime: now,
          issued: now,
          valueQuantity: {
            ...source.content.valueQuantity,
            value,
          },
          interpretation: [{
            coding: [{
              ...source.content.interpretation[0]?.coding[0],
              code: interpretation,
            }],
          }],
        })
      })
      const reportContent = Object.fromEntries(Object.entries(sourceReportResource).filter(
        ([key]) => key !== 'id' && key !== 'meta',
      ))
      const diagnosticReportId = uuidv7()
      const report = transaction.fhir.create(input.context, {
        ...reportContent,
        resourceType: 'DiagnosticReport',
        id: diagnosticReportId,
        status: 'final',
        effectiveDateTime: now,
        issued: now,
        conclusion: input.conclusion,
        result: observations.map(observation => ({
          reference: `Observation/${observation.id}`,
        })),
      })
      const provenanceId = uuidv7()
      const provenance = transaction.fhir.createImmutable(input.context, {
        resourceType: 'Provenance',
        id: provenanceId,
        target: [
          { reference: `DiagnosticReport/${diagnosticReportId}` },
          ...observations.map(observation => ({ reference: `Observation/${observation.id}` })),
        ],
        recorded: now,
        activity: { text: 'Laboratory report correction' },
        reason: [{ concept: { text: input.reason } }],
        agent: provenanceAgents(input.context, 'Laboratory report corrector'),
        entity: [
          {
            role: 'revision',
            what: { reference: `DiagnosticReport/${input.diagnosticReportId}` },
          },
          ...sourceObservations.map(observation => ({
            role: 'revision',
            what: { reference: `Observation/${observation.id}` },
          })),
        ],
      })
      this.#database.driver.prepare(`
        INSERT INTO laboratory_report_revision (
          workspace_id, epoch, revision_id, request_id, diagnostic_report_id,
          revision_of_diagnostic_report_id, provenance_id, reason, corrected_by, corrected_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        uuidv7(),
        request.request_id,
        diagnosticReportId,
        input.diagnosticReportId,
        provenanceId,
        input.reason,
        input.context.actorId,
        now,
      )
      const update = this.#database.driver.prepare(`
        UPDATE laboratory_request
        SET status = 'reported', version = version + 1, reported_at = ?,
          acknowledged_at = NULL, diagnostic_report_id = ?
        WHERE workspace_id = ? AND epoch = ? AND request_id = ?
          AND version = ? AND diagnostic_report_id = ?
          AND status IN ('reported', 'acknowledged')
      `).run(
        now,
        diagnosticReportId,
        input.context.workspaceId,
        input.context.epoch,
        request.request_id,
        request.version,
        input.diagnosticReportId,
      )
      if (update.changes !== 1) {
        throw new WorkflowError(
          'LABORATORY_REQUEST_VERSION_CONFLICT',
          'The laboratory request version has changed',
        )
      }
      return {
        data: {
          diagnosticReportId,
          previousDiagnosticReportId: input.diagnosticReportId,
          provenanceId,
          requestId: request.request_id,
          requestVersion: request.version + 1,
          status: 'reported' as const,
        },
        effects: [
          ...observations,
          report,
          provenance,
        ].map(resource => ({
          kind: 'created' as const,
          reference: `${resource.resourceType}/${resource.id}`,
          versionId: resource.meta?.versionId ?? '1',
        })),
      }
    })
  }

  issueLaboratoryOrder(input: {
    catalogItemId: string
    context: ActorContext
    encounterId: string
    expectedDraftVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    indicationCode: string
  }): CommandResponse<{
    chargeItemId: string
    encounterId: string
    encounterVersion: string
    serviceRequestId: string
    status: 'awaiting-lab-payment'
    totalFen: number
  }> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: laboratoryOrderResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        catalogItemId: input.catalogItemId,
        encounterId: input.encounterId,
        expectedDraftVersion: input.expectedDraftVersion,
        indicationCode: input.indicationCode,
      },
      operation: 'encounter.issue-laboratory-order',
    }, transaction => {
      this.#assertRole(input.context, ['outpatient-doctor'])
      const outpatientCase = this.#caseByEncounter(input.context, input.encounterId)
      if (outpatientCase.status !== 'first-visit' || outpatientCase.doctor_task_id === null) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter cannot issue a laboratory request')
      }
      this.#assertExpectedVersions(input.expectedVersions, [
        `Encounter/${input.encounterId}`,
        `Task/${outpatientCase.doctor_task_id}`,
      ])
      const draft = this.#database.driver.prepare(`
        SELECT version FROM clinical_draft
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND draft_kind = 'first-visit'
      `).get(input.context.workspaceId, input.context.epoch, outpatientCase.case_id) as {
        version: number
      } | undefined
      if (draft?.version !== input.expectedDraftVersion) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The first-visit draft version is stale')
      }
      const catalog = this.#catalogItem(input.context, input.catalogItemId, 'laboratory')
      const catalogConfig = laboratoryCatalogConfigSchema.parse(
        JSON.parse(catalog.config_json ?? '{}') as unknown,
      )
      if (!catalogConfig.allowedIndicationCodes.includes(input.indicationCode)) {
        throw new WorkflowError('CATALOG_CONFLICT', 'The indication is not allowed for this laboratory request')
      }
      const allergyCodes = this.#patientAllergyCodes(input.context, outpatientCase.patient_id)
      if (catalogConfig.contraindicatedAllergyCodes.some(code => allergyCodes.has(code))) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory request is contraindicated')
      }
      const encounter = transaction.fhir.read(input.context, 'Encounter', input.encounterId)
      const task = transaction.fhir.read(input.context, 'Task', outpatientCase.doctor_task_id)
      const serviceRequestId = uuidv7()
      const chargeItemId = uuidv7()
      const chargeId = uuidv7()
      const now = this.#virtualTime(input.context)
      const serviceRequest = transaction.fhir.create(input.context, {
        resourceType: 'ServiceRequest',
        id: serviceRequestId,
        status: 'active',
        intent: 'order',
        code: { concept: { text: catalog.name_zh } },
        subject: { reference: `Patient/${outpatientCase.patient_id}` },
        encounter: { reference: `Encounter/${input.encounterId}` },
        authoredOn: now,
        requester: { reference: `PractitionerRole/${input.context.practitionerRoleId}` },
        reason: [{ concept: { coding: [{ code: input.indicationCode }] } }],
      })
      const chargeItem = transaction.fhir.create(input.context, {
        resourceType: 'ChargeItem',
        id: chargeItemId,
        status: 'billable',
        code: { text: catalog.name_zh },
        subject: { reference: `Patient/${outpatientCase.patient_id}` },
        encounter: { reference: `Encounter/${input.encounterId}` },
        account: [{ reference: `Account/${outpatientCase.account_id}` }],
        occurrenceDateTime: now,
        quantity: { value: 1 },
        unitPriceComponent: { amount: { currency: 'CNY', value: catalog.price_fen / 100 } },
      })
      const updatedEncounter = transaction.fhir.update(input.context, {
        ...encounter,
        status: 'in-progress',
        extension: [
          ...(Array.isArray(encounter.extension) ? encounter.extension : []),
          {
            url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/workflow-phase',
            valueCode: 'awaiting-lab-payment',
          },
        ],
      }, encounter.meta?.versionId ?? '1')
      const completedTask = transaction.fhir.update(input.context, {
        ...task,
        status: 'completed',
        executionPeriod: {
          ...((typeof task.executionPeriod === 'object' && task.executionPeriod !== null)
            ? task.executionPeriod as Record<string, unknown>
            : {}),
          end: now,
        },
      }, task.meta?.versionId ?? '1')
      this.#database.driver.prepare(`
        INSERT INTO charge_record (
          workspace_id, epoch, charge_id, case_id, account_id, charge_item_id,
          category, source_reference, description_zh, description_en,
          quantity, unit_price_fen, total_fen, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'laboratory', ?, ?, ?, 1, ?, ?, 'billable', ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        chargeId,
        outpatientCase.case_id,
        outpatientCase.account_id,
        chargeItemId,
        `ServiceRequest/${serviceRequestId}`,
        catalog.name_zh,
        catalog.name_en,
        catalog.price_fen,
        catalog.price_fen,
        now,
      )
      this.#database.driver.prepare(`
        UPDATE outpatient_case
        SET status = 'awaiting-lab-payment', service_request_id = ?,
          version = version + 1, updated_at = ?
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND status = 'first-visit'
      `).run(
        serviceRequestId,
        now,
        input.context.workspaceId,
        input.context.epoch,
        outpatientCase.case_id,
      )
      return {
        data: {
          chargeItemId,
          encounterId: input.encounterId,
          encounterVersion: updatedEncounter.meta?.versionId ?? '4',
          serviceRequestId,
          status: 'awaiting-lab-payment' as const,
          totalFen: catalog.price_fen,
        },
        effects: [
          { kind: 'created' as const, resource: serviceRequest },
          { kind: 'created' as const, resource: chargeItem },
          { kind: 'updated' as const, resource: updatedEncounter },
          { kind: 'updated' as const, resource: completedTask },
        ].map(effect => ({
          kind: effect.kind,
          reference: `${effect.resource.resourceType}/${effect.resource.id}`,
          versionId: effect.resource.meta?.versionId ?? '1',
        })),
      }
    })
  }

  billingQueue(input: {
    category: 'laboratory' | 'medication'
    context: ActorContext
    page: number
    pageSize: number
    status: 'ambiguous' | 'declined' | 'paid' | 'pending'
  }) {
    this.#assertRole(input.context, ['cashier'])
    const statuses = [input.status === 'pending' ? 'billable' : input.status]
    const placeholders = statuses.map(() => '?').join(', ')
    const bindings = [input.context.workspaceId, input.context.epoch, input.category, ...statuses]
    const withdrawnPrescriptionFilter
      = input.category === 'medication' && input.status === 'pending'
        ? `
          AND NOT EXISTS (
            SELECT 1 FROM prescription_withdrawal AS withdrawal
            WHERE withdrawal.workspace_id = charge.workspace_id
              AND withdrawal.epoch = charge.epoch
              AND charge.source_reference = 'Prescription/' || withdrawal.prescription_id
          )
        `
        : ''
    const total = this.#database.driver.prepare(`
      SELECT COUNT(*) AS count FROM charge_record AS charge
      WHERE charge.workspace_id = ? AND charge.epoch = ? AND charge.category = ?
        AND charge.status IN (${placeholders})
        ${withdrawnPrescriptionFilter}
    `).get(...bindings) as { count: number }
    const rows = this.#database.driver.prepare(`
      SELECT charge.*, patient.content_json AS patient_json,
        outpatient_case.encounter_id
      FROM charge_record AS charge
      JOIN outpatient_case
        ON outpatient_case.workspace_id = charge.workspace_id
       AND outpatient_case.epoch = charge.epoch
       AND outpatient_case.case_id = charge.case_id
      JOIN fhir_resource AS patient
        ON patient.workspace_id = outpatient_case.workspace_id
       AND patient.epoch = outpatient_case.epoch
       AND patient.resource_type = 'Patient'
       AND patient.resource_id = outpatient_case.patient_id
      WHERE charge.workspace_id = ? AND charge.epoch = ? AND charge.category = ?
        AND charge.status IN (${placeholders})
        ${withdrawnPrescriptionFilter}
      ORDER BY charge.created_at, charge.charge_id
      LIMIT ? OFFSET ?
    `).all(...bindings, input.pageSize, (input.page - 1) * input.pageSize) as Array<{
      account_id: string
      case_id: string
      category: string
      charge_item_id: string
      description_en: string
      description_zh: string
      encounter_id: string
      patient_json: string
      quantity: number
      source_reference: string
      status: string
      total_fen: number
      unit_price_fen: number
      version: number
    }>
    return {
      items: rows.map(row => ({
        accountId: row.account_id,
        amountFen: row.total_fen,
        caseId: row.case_id,
        category: row.category,
        chargeItemId: row.charge_item_id,
        chargeVersion: row.version,
        descriptionEn: row.description_en,
        descriptionZh: row.description_zh,
        encounterId: row.encounter_id,
        lines: row.category === 'medication'
          ? this.#prescriptionChargeLines(input.context, row.source_reference)
          : [{
              descriptionEn: row.description_en,
              descriptionZh: row.description_zh,
              quantity: row.quantity,
              sourceReference: row.source_reference,
              subtotalFen: row.total_fen,
              unitPriceFen: row.unit_price_fen,
            }],
        patient: patientSummary(parseStoredFhirResource(row.patient_json)),
        status: row.status,
      })),
      page: input.page,
      pageSize: input.pageSize,
      total: total.count,
    }
  }

  pharmacyQueue(input: {
    context: ActorContext
    page: number
    pageSize: number
    status: 'completed' | 'exception' | 'pending'
  }) {
    this.#assertRole(input.context, ['pharmacist'])
    if (input.status === 'exception') {
      return { items: [], page: input.page, pageSize: input.pageSize, total: 0 }
    }
    const caseStatus = input.status === 'pending' ? 'awaiting-dispense' : 'completed'
    const total = this.#database.driver.prepare(`
      SELECT COUNT(*) AS count
      FROM outpatient_case AS outpatient_case
      JOIN prescription
        ON prescription.workspace_id = outpatient_case.workspace_id
       AND prescription.epoch = outpatient_case.epoch
       AND prescription.prescription_id = outpatient_case.prescription_id
      WHERE outpatient_case.workspace_id = ? AND outpatient_case.epoch = ?
        AND outpatient_case.status = ?
        AND prescription.status = ?
        AND NOT EXISTS (
          SELECT 1 FROM prescription_withdrawal AS withdrawal
          WHERE withdrawal.workspace_id = prescription.workspace_id
            AND withdrawal.epoch = prescription.epoch
            AND withdrawal.prescription_id = prescription.prescription_id
        )
    `).get(
      input.context.workspaceId,
      input.context.epoch,
      caseStatus,
      input.status === 'pending' ? 'paid' : 'dispensed',
    ) as { count: number }
    const rows = this.#database.driver.prepare(`
      SELECT outpatient_case.case_id, outpatient_case.encounter_id,
        outpatient_case.patient_id, outpatient_case.status AS case_status,
        prescription.prescription_id, prescription.prescription_number,
        prescription.status AS prescription_status, prescription.version AS prescription_version,
        prescription.authored_by, patient.content_json AS patient_json,
        review.review_id, review.note AS review_note,
        review.reviewed_at, review.reviewed_by,
        encounter.content_json AS encounter_json, encounter.version_id AS encounter_version
      FROM outpatient_case
      JOIN prescription
        ON prescription.workspace_id = outpatient_case.workspace_id
       AND prescription.epoch = outpatient_case.epoch
       AND prescription.prescription_id = outpatient_case.prescription_id
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
      LEFT JOIN prescription_review AS review
        ON review.workspace_id = prescription.workspace_id
       AND review.epoch = prescription.epoch
       AND review.prescription_id = prescription.prescription_id
      WHERE outpatient_case.workspace_id = ? AND outpatient_case.epoch = ?
        AND outpatient_case.status = ?
        AND prescription.status = ?
        AND NOT EXISTS (
          SELECT 1 FROM prescription_withdrawal AS withdrawal
          WHERE withdrawal.workspace_id = prescription.workspace_id
            AND withdrawal.epoch = prescription.epoch
            AND withdrawal.prescription_id = prescription.prescription_id
        )
      ORDER BY outpatient_case.updated_at, outpatient_case.case_id
      LIMIT ? OFFSET ?
    `).all(
      input.context.workspaceId,
      input.context.epoch,
      caseStatus,
      input.status === 'pending' ? 'paid' : 'dispensed',
      input.pageSize,
      (input.page - 1) * input.pageSize,
    ) as Array<{
      authored_by: string
      case_id: string
      case_status: string
      encounter_id: string
      encounter_json: string
      encounter_version: number
      patient_id: string
      patient_json: string
      prescription_id: string
      prescription_number: string
      prescription_status: string
      prescription_version: number
      review_id: string | null
      review_note: string | null
      reviewed_at: string | null
      reviewed_by: string | null
    }>
    const selectItems = this.#database.driver.prepare(`
      SELECT item.medication_request_id, item.medication_id, item.quantity,
        item.dispensed_quantity,
        item.dose_text, item.frequency_code, catalog.name_zh, catalog.name_en,
        catalog.price_fen, medication_request.version_id AS medication_request_version
      FROM prescription_item AS item
      JOIN outpatient_catalog AS catalog
        ON catalog.workspace_id = item.workspace_id
       AND catalog.epoch = item.epoch
       AND catalog.item_id = item.medication_id
      JOIN fhir_resource AS medication_request
        ON medication_request.workspace_id = item.workspace_id
       AND medication_request.epoch = item.epoch
       AND medication_request.resource_type = 'MedicationRequest'
       AND medication_request.resource_id = item.medication_request_id
      WHERE item.workspace_id = ? AND item.epoch = ? AND item.prescription_id = ?
      ORDER BY item.medication_request_id
    `)
    const selectLots = this.#database.driver.prepare(`
      SELECT lot_id, location_id, lot_number, expires_on, quantity_on_hand, version
      FROM inventory_lot
      WHERE workspace_id = ? AND epoch = ? AND medication_id = ?
        AND location_id = ? AND expires_on >= ? AND quantity_on_hand > 0
      ORDER BY expires_on, lot_id
    `)
    return {
      items: rows.map(row => {
        const medications = (selectItems.all(
          input.context.workspaceId,
          input.context.epoch,
          row.prescription_id,
        ) as Array<{
          dose_text: string
          dispensed_quantity: number
          frequency_code: string
          medication_id: string
          medication_request_id: string
          medication_request_version: number
          name_en: string
          name_zh: string
          price_fen: number
          quantity: number
        }>).map(medication => ({
          doseText: medication.dose_text,
          frequencyCode: medication.frequency_code,
          medicationId: medication.medication_id,
          medicationRequestId: medication.medication_request_id,
          medicationRequestVersion: String(medication.medication_request_version),
          nameEn: medication.name_en,
          nameZh: medication.name_zh,
          dispensedQuantity: medication.dispensed_quantity,
          quantity: medication.quantity,
          remainingQuantity: medication.quantity - medication.dispensed_quantity,
          unitPriceFen: medication.price_fen,
          lots: (selectLots.all(
            input.context.workspaceId,
            input.context.epoch,
            medication.medication_id,
            input.context.locationId,
            this.#virtualTime(input.context).slice(0, 10),
          ) as Array<{
            expires_on: string
            location_id: string
            lot_id: string
            lot_number: string
            quantity_on_hand: number
            version: number
          }>).map(lot => ({
            expiresOn: lot.expires_on,
            id: lot.lot_id,
            locationId: lot.location_id,
            lotNumber: lot.lot_number,
            quantityOnHand: lot.quantity_on_hand,
            version: lot.version,
          })),
        }))
        const encounter = parseStoredFhirResource(row.encounter_json)
        return {
          allergyWarnings: this.#patientAllergyWarnings(input.context, row.patient_id),
          authoredBy: row.authored_by,
          caseId: row.case_id,
          encounterId: row.encounter_id,
          encounterStatus: encounter.status,
          encounterVersion: String(row.encounter_version),
          medications,
          patient: patientSummary(parseStoredFhirResource(row.patient_json)),
          prescriptionId: row.prescription_id,
          prescriptionNumber: row.prescription_number,
          prescriptionStatus: row.prescription_status,
          prescriptionVersion: row.prescription_version,
          ...(row.review_id === null
            ? {}
            : {
                review: {
                  note: row.review_note ?? '',
                  reviewId: row.review_id,
                  reviewedAt: row.reviewed_at ?? '',
                  reviewedBy: row.reviewed_by ?? '',
                },
              }),
          status: row.case_status === 'completed'
            ? 'completed'
            : medications.some(medication => medication.dispensedQuantity > 0)
              ? 'partially-dispensed'
              : row.review_id === null
                ? 'awaiting-review'
                : 'awaiting-dispense',
        }
      }),
      page: input.page,
      pageSize: input.pageSize,
      total: total.count,
    }
  }

  reviewPrescription(input: {
    context: ActorContext
    expectedPrescriptionVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    note: string
    prescriptionId: string
  }): CommandResponse<{
    prescriptionId: string
    prescriptionVersion: number
    reviewId: string
    status: 'awaiting-dispense'
  }> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: prescriptionReviewResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        expectedPrescriptionVersion: input.expectedPrescriptionVersion,
        note: input.note,
        prescriptionId: input.prescriptionId,
      },
      operation: 'prescription.review',
    }, () => {
      this.#assertRole(input.context, ['pharmacist'])
      if (input.context.locationId === undefined) {
        throw new WorkflowError('ROLE_NOT_ALLOWED', 'The pharmacist has no active pharmacy location')
      }
      const prescription = prescriptionWorkflowRowSchema.optional().parse(
        this.#database.driver.prepare(`
          SELECT prescription.version, prescription.status,
            outpatient_case.encounter_id, outpatient_case.status AS case_status,
            withdrawal.withdrawal_id
          FROM prescription
          JOIN outpatient_case
            ON outpatient_case.workspace_id = prescription.workspace_id
           AND outpatient_case.epoch = prescription.epoch
           AND outpatient_case.case_id = prescription.case_id
          LEFT JOIN prescription_withdrawal AS withdrawal
            ON withdrawal.workspace_id = prescription.workspace_id
           AND withdrawal.epoch = prescription.epoch
           AND withdrawal.prescription_id = prescription.prescription_id
          WHERE prescription.workspace_id = ? AND prescription.epoch = ?
            AND prescription.prescription_id = ?
        `).get(input.context.workspaceId, input.context.epoch, input.prescriptionId),
      )
      if (
        prescription === undefined
        || prescription.status !== 'paid'
        || prescription.case_status !== 'awaiting-dispense'
        || prescription.version !== input.expectedPrescriptionVersion
        || prescription.withdrawal_id !== null
      ) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription is not ready for review')
      }
      const medicationRequestIds = (this.#database.driver.prepare(`
        SELECT medication_request_id FROM prescription_item
        WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
        ORDER BY medication_request_id
      `).all(input.context.workspaceId, input.context.epoch, input.prescriptionId) as Array<{
        medication_request_id: string
      }>).map(row => row.medication_request_id)
      if (medicationRequestIds.length === 0) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription has no medication requests to review')
      }
      this.#assertExpectedVersions(input.expectedVersions, [
        `Encounter/${prescription.encounter_id}`,
        ...medicationRequestIds.map(id => `MedicationRequest/${id}`),
      ])
      const reviewId = uuidv7()
      const reviewedAt = this.#virtualTime(input.context)
      this.#database.driver.prepare(`
        INSERT INTO prescription_review (
          workspace_id, epoch, review_id, prescription_id, status,
          note, reviewed_by, reviewed_at
        ) VALUES (?, ?, ?, ?, 'approved', ?, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        reviewId,
        input.prescriptionId,
        input.note,
        input.context.actorId,
        reviewedAt,
      )
      const update = this.#database.driver.prepare(`
        UPDATE prescription SET version = version + 1
        WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
          AND status = 'paid' AND version = ?
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        input.prescriptionId,
        input.expectedPrescriptionVersion,
      )
      if (update.changes !== 1) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription changed during review')
      }
      return {
        data: {
          prescriptionId: input.prescriptionId,
          prescriptionVersion: input.expectedPrescriptionVersion + 1,
          reviewId,
          status: 'awaiting-dispense' as const,
        },
        effects: [{
          kind: 'created',
          reference: `PrescriptionReview/${reviewId}`,
          versionId: '1',
        }],
      }
    })
  }

  dispensePrescription(input: {
    context: ActorContext
    expectedPrescriptionVersion: number
    expectedVersions: Record<string, string>
    idempotencyKey: string
    lotSelections: Array<{
      expectedVersion: number
      lotId: string
      quantity: number
    }>
    prescriptionId: string
  }): CommandResponse<{
    medicationDispenseIds: string[]
    prescriptionId: string
    prescriptionVersion: number
    scenarioStatus: 'completed' | 'active'
    status: 'completed' | 'partial'
  }> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: dispenseResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        expectedPrescriptionVersion: input.expectedPrescriptionVersion,
        lotSelections: input.lotSelections,
        prescriptionId: input.prescriptionId,
      },
      operation: 'prescription.dispense',
    }, transaction => {
      this.#assertRole(input.context, ['pharmacist'])
      if (input.context.locationId === undefined) {
        throw new WorkflowError('ROLE_NOT_ALLOWED', 'The pharmacist has no active pharmacy location')
      }
      if (new Set(input.lotSelections.map(selection => selection.lotId)).size !== input.lotSelections.length) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'A lot can be selected only once')
      }
      const prescription = prescriptionDispenseWorkflowRowSchema.optional().parse(
        this.#database.driver.prepare(`
          SELECT prescription.prescription_id, prescription.prescription_number,
            prescription.version, prescription.status,
            outpatient_case.case_id, outpatient_case.patient_id,
            outpatient_case.encounter_id, outpatient_case.status AS case_status,
            outpatient_case.scenario_run_id,
            review.review_id, withdrawal.withdrawal_id
          FROM prescription
          JOIN outpatient_case
            ON outpatient_case.workspace_id = prescription.workspace_id
           AND outpatient_case.epoch = prescription.epoch
           AND outpatient_case.case_id = prescription.case_id
          LEFT JOIN prescription_review AS review
            ON review.workspace_id = prescription.workspace_id
           AND review.epoch = prescription.epoch
           AND review.prescription_id = prescription.prescription_id
          LEFT JOIN prescription_withdrawal AS withdrawal
            ON withdrawal.workspace_id = prescription.workspace_id
           AND withdrawal.epoch = prescription.epoch
           AND withdrawal.prescription_id = prescription.prescription_id
          WHERE prescription.workspace_id = ? AND prescription.epoch = ?
            AND prescription.prescription_id = ?
        `).get(input.context.workspaceId, input.context.epoch, input.prescriptionId),
      )
      if (
        prescription === undefined
        || prescription.status !== 'paid'
        || prescription.review_id === null
        || prescription.case_status !== 'awaiting-dispense'
        || prescription.version !== input.expectedPrescriptionVersion
        || prescription.withdrawal_id !== null
      ) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription is not ready for dispensing')
      }
      const items = this.#database.driver.prepare(`
        SELECT medication_request_id, medication_id, quantity, dispensed_quantity
        FROM prescription_item
        WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
        ORDER BY medication_request_id
      `).all(input.context.workspaceId, input.context.epoch, input.prescriptionId) as Array<{
        medication_id: string
        medication_request_id: string
        dispensed_quantity: number
        quantity: number
      }>
      if (items.length === 0 || input.lotSelections.length === 0) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription has no dispensable medication')
      }
      this.#assertExpectedVersions(input.expectedVersions, [
        `Encounter/${prescription.encounter_id}`,
        ...items.map(item => `MedicationRequest/${item.medication_request_id}`),
      ])
      const selectLot = this.#database.driver.prepare(`
        SELECT lot_id, medication_id, location_id, lot_number, expires_on,
          quantity_on_hand, version
        FROM inventory_lot
        WHERE workspace_id = ? AND epoch = ? AND lot_id = ?
      `)
      const selections = input.lotSelections.map(selection => {
        const lot = selectLot.get(
          input.context.workspaceId,
          input.context.epoch,
          selection.lotId,
        ) as {
          expires_on: string
          location_id: string
          lot_id: string
          lot_number: string
          medication_id: string
          quantity_on_hand: number
          version: number
        } | undefined
        if (
          lot === undefined
          || lot.location_id !== input.context.locationId
          || lot.version !== selection.expectedVersion
          || lot.quantity_on_hand < selection.quantity
          || lot.expires_on < this.#virtualTime(input.context).slice(0, 10)
        ) {
          throw new WorkflowError('WORKFLOW_CONFLICT', `Inventory lot ${selection.lotId} is unavailable`)
        }
        return { ...selection, lot }
      })
      if (selections.some(selection => !items.some(
        item => item.medication_id === selection.lot.medication_id,
      ))) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'A selected lot is not part of the prescription')
      }
      const selectedItems = items.map(item => ({
        ...item,
        selectedQuantity: selections
          .filter(selection => selection.lot.medication_id === item.medication_id)
          .reduce((total, selection) => total + selection.quantity, 0),
      })).filter(item => item.selectedQuantity > 0)
      for (const item of selectedItems) {
        const selectedQuantity = selections
          .filter(selection => selection.lot.medication_id === item.medication_id)
          .reduce((total, selection) => total + selection.quantity, 0)
        if (selectedQuantity > item.quantity - item.dispensed_quantity) {
          throw new WorkflowError(
            'WORKFLOW_CONFLICT',
            `Selected quantity exceeds the remainder for ${item.medication_request_id}`,
          )
        }
      }

      const now = this.#virtualTime(input.context)
      const updateLot = this.#database.driver.prepare(`
        UPDATE inventory_lot
        SET quantity_on_hand = quantity_on_hand - ?, version = version + 1
        WHERE workspace_id = ? AND epoch = ? AND lot_id = ?
          AND location_id = ? AND version = ? AND quantity_on_hand >= ?
          AND expires_on >= ?
      `)
      const insertMovement = this.#database.driver.prepare(`
        INSERT INTO inventory_movement (
          workspace_id, epoch, movement_id, prescription_id, lot_id,
          quantity, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      const movementIds: string[] = []
      for (const selection of selections) {
        const updated = updateLot.run(
          selection.quantity,
          input.context.workspaceId,
          input.context.epoch,
          selection.lotId,
          input.context.locationId,
          selection.expectedVersion,
          selection.quantity,
          now.slice(0, 10),
        )
        if (updated.changes !== 1) {
          throw new WorkflowError('WORKFLOW_CONFLICT', `Inventory lot ${selection.lotId} changed concurrently`)
        }
        const inventoryItem = transaction.fhir.read(
          input.context,
          'InventoryItem',
          selection.lotId,
        )
        const netContent = typeof inventoryItem.netContent === 'object'
          && inventoryItem.netContent !== null
          ? inventoryItem.netContent as Record<string, unknown>
          : {}
        transaction.fhir.updateProjection(input.context, {
          ...inventoryItem,
          netContent: {
            ...netContent,
            value: selection.lot.quantity_on_hand - selection.quantity,
          },
        }, String(selection.expectedVersion))
        const movementId = uuidv7()
        insertMovement.run(
          input.context.workspaceId,
          input.context.epoch,
          movementId,
          input.prescriptionId,
          selection.lotId,
          selection.quantity,
          now,
        )
        movementIds.push(movementId)
      }

      const updateItem = this.#database.driver.prepare(`
        UPDATE prescription_item
        SET dispensed_quantity = dispensed_quantity + ?
        WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
          AND medication_request_id = ?
          AND dispensed_quantity + ? <= quantity
      `)
      for (const item of selectedItems) {
        const updated = updateItem.run(
          item.selectedQuantity,
          input.context.workspaceId,
          input.context.epoch,
          input.prescriptionId,
          item.medication_request_id,
          item.selectedQuantity,
        )
        if (updated.changes !== 1) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription quantity changed concurrently')
        }
      }
      const incomplete = this.#database.driver.prepare(`
        SELECT COUNT(*) AS count
        FROM prescription_item
        WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
          AND dispensed_quantity < quantity
      `).get(
        input.context.workspaceId,
        input.context.epoch,
        input.prescriptionId,
      ) as { count: number }
      const dispenseStatus = incomplete.count === 0 ? 'completed' as const : 'partial' as const

      const insertDispense = this.#database.driver.prepare(`
        INSERT INTO dispense (
          workspace_id, epoch, dispense_id, prescription_id,
          medication_dispense_id, status, dispensed_by, dispensed_at
        ) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)
      `)
      const medicationDispenses = selectedItems.map(item => {
        const medicationDispenseId = uuidv7()
        const medicationDispense = transaction.fhir.create(input.context, {
          resourceType: 'MedicationDispense',
          id: medicationDispenseId,
          status: 'completed',
          medication: { reference: { reference: `Medication/${item.medication_id}` } },
          subject: { reference: `Patient/${prescription.patient_id}` },
          encounter: { reference: `Encounter/${prescription.encounter_id}` },
          authorizingPrescription: [{
            reference: `MedicationRequest/${item.medication_request_id}`,
          }],
          performer: [{ actor: { reference: `PractitionerRole/${input.context.practitionerRoleId}` } }],
          location: { reference: `Location/${input.context.locationId}` },
          quantity: { value: item.selectedQuantity },
          whenPrepared: now,
          whenHandedOver: now,
        })
        insertDispense.run(
          input.context.workspaceId,
          input.context.epoch,
          uuidv7(),
          input.prescriptionId,
          medicationDispenseId,
          input.context.actorId,
          now,
        )
        return medicationDispense
      })
      const prescriptionUpdate = this.#database.driver.prepare(`
        UPDATE prescription SET status = ?, version = version + 1
        WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
          AND status = 'paid' AND version = ?
      `).run(
        dispenseStatus === 'completed' ? 'dispensed' : 'paid',
        input.context.workspaceId,
        input.context.epoch,
        input.prescriptionId,
        input.expectedPrescriptionVersion,
      )
      if (prescriptionUpdate.changes !== 1) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription changed concurrently')
      }
      if (dispenseStatus === 'completed') {
        this.#database.driver.prepare(`
          UPDATE outpatient_case SET status = 'completed', version = version + 1, updated_at = ?
          WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND status = 'awaiting-dispense'
        `).run(now, input.context.workspaceId, input.context.epoch, prescription.case_id)
      }
      const remaining = this.#database.driver.prepare(`
        SELECT COUNT(*) AS count FROM outpatient_case
        WHERE workspace_id = ? AND epoch = ? AND scenario_run_id = ? AND status != 'completed'
      `).get(
        input.context.workspaceId,
        input.context.epoch,
        prescription.scenario_run_id,
      ) as { count: number }
      const scenarioStatus = remaining.count === 0 ? 'completed' as const : 'active' as const
      if (scenarioStatus === 'completed') {
        this.#database.driver.prepare(`
          UPDATE scenario_run SET status = 'completed', completed_at = ?
          WHERE workspace_id = ? AND epoch = ? AND scenario_run_id = ? AND status = 'active'
        `).run(
          now,
          input.context.workspaceId,
          input.context.epoch,
          prescription.scenario_run_id,
        )
      }
      return {
        data: {
          medicationDispenseIds: medicationDispenses.map(dispense => dispense.id),
          prescriptionId: input.prescriptionId,
          prescriptionVersion: input.expectedPrescriptionVersion + 1,
          scenarioStatus,
          status: dispenseStatus,
        },
        effects: [
          ...medicationDispenses.map(medicationDispense => ({
            kind: 'created' as const,
            reference: `MedicationDispense/${medicationDispense.id}`,
            versionId: medicationDispense.meta?.versionId ?? '1',
          })),
          ...movementIds.map(movementId => ({
            kind: 'created' as const,
            reference: `InventoryMovement/${movementId}`,
            versionId: '1',
          })),
          ...selections.map(selection => ({
            kind: 'updated' as const,
            reference: `InventoryItem/${selection.lotId}`,
            versionId: String(selection.expectedVersion + 1),
          })),
          {
            kind: 'updated' as const,
            reference: `Prescription/${input.prescriptionId}`,
            versionId: String(input.expectedPrescriptionVersion + 1),
          },
          ...(scenarioStatus === 'completed' ? [{
            kind: 'updated' as const,
            reference: `ScenarioRun/${prescription.scenario_run_id}`,
            versionId: '2',
          }] : []),
        ],
      }
    })
  }

  previewPayment(input: {
    category: 'laboratory' | 'medication'
    caseId: string
    context: ActorContext
    expectedVersions: Record<string, string>
    idempotencyKey: string
    simulatorRule: 'ambiguous' | 'decline' | 'success'
  }): CommandResponse<{
    allocations: Array<{
      amountFen: number
      chargeItemId: string
    }>
    amountFen: number
    channel: 'synthetic-payment'
    chargeItemId: string
    chargeVersion: number
    commitToken: string
    expectedOutcome: 'ambiguous' | 'declined' | 'success'
    expiresAt: string
    previewId: string
  }> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: paymentPreviewResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        caseId: input.caseId,
        category: input.category,
        simulatorRule: input.simulatorRule,
      },
      operation: 'payment.preview',
    }, () => {
      this.#assertRole(input.context, ['cashier'])
      const charge = paymentChargeRowSchema.optional().parse(
        this.#database.driver.prepare(`
          SELECT charge.charge_id, charge.charge_item_id, charge.total_fen,
            charge.version, charge.status, outpatient_case.status AS case_status,
            prescription.status AS prescription_status,
            withdrawal.withdrawal_id
          FROM charge_record AS charge
          JOIN outpatient_case
            ON outpatient_case.workspace_id = charge.workspace_id
           AND outpatient_case.epoch = charge.epoch
           AND outpatient_case.case_id = charge.case_id
          LEFT JOIN prescription
            ON prescription.workspace_id = outpatient_case.workspace_id
           AND prescription.epoch = outpatient_case.epoch
           AND prescription.prescription_id = outpatient_case.prescription_id
          LEFT JOIN prescription_withdrawal AS withdrawal
            ON withdrawal.workspace_id = prescription.workspace_id
           AND withdrawal.epoch = prescription.epoch
           AND withdrawal.prescription_id = prescription.prescription_id
          WHERE charge.workspace_id = ? AND charge.epoch = ?
            AND charge.case_id = ? AND charge.category = ?
        `).get(input.context.workspaceId, input.context.epoch, input.caseId, input.category),
      )
      if (charge === undefined || !['billable', 'declined'].includes(charge.status)) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The charge is not available for payment')
      }
      this.#assertExpectedVersions(input.expectedVersions, [`ChargeItem/${charge.charge_item_id}`])
      if (
        (input.category === 'laboratory' && charge.case_status !== 'awaiting-lab-payment')
        || (input.category === 'medication'
          && (charge.case_status !== 'awaiting-medication-payment'
            || charge.prescription_status !== 'signed'
            || charge.withdrawal_id !== null))
      ) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The clinical workflow is not ready for this payment')
      }
      const rule = this.#database.driver.prepare(`
        SELECT outcome FROM scenario_simulator_rule
        WHERE workspace_id = ? AND epoch = ? AND simulator = 'payment' AND rule_code = ?
      `).get(input.context.workspaceId, input.context.epoch, input.simulatorRule) as {
        outcome: 'ambiguous' | 'declined' | 'success'
      } | undefined
      if (rule === undefined) throw new WorkflowError('CATALOG_CONFLICT', 'The payment simulator rule is unavailable')
      const previewId = uuidv7()
      const commitToken = `${previewId}.${this.#hashToken(previewId)}`
      const expiresAt = new Date(Date.parse(this.#virtualTime(input.context)) + 5 * 60_000).toISOString()
      this.#database.driver.prepare(`
        INSERT INTO payment_preview (
          workspace_id, epoch, preview_id, case_id, category, amount_fen,
          expected_charge_version, simulator_rule, token_hash, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        previewId,
        input.caseId,
        input.category,
        charge.total_fen,
        charge.version,
        input.simulatorRule,
        this.#hashToken(commitToken),
        expiresAt,
      )
      return {
        data: {
          allocations: [{
            amountFen: charge.total_fen,
            chargeItemId: charge.charge_item_id,
          }],
          amountFen: charge.total_fen,
          channel: 'synthetic-payment',
          chargeItemId: charge.charge_item_id,
          chargeVersion: charge.version,
          commitToken,
          expectedOutcome: rule.outcome,
          expiresAt,
          previewId,
        },
        effects: [{
          kind: 'created',
          reference: `PaymentPreview/${previewId}`,
          versionId: '1',
        }],
      }
    })
  }

  confirmPayment(input: {
    commitToken: string
    context: ActorContext
    expectedVersions: Record<string, string>
    idempotencyKey: string
    previewId: string
  }): CommandResponse<{
    amountFen: number
    outcome: 'ambiguous' | 'declined' | 'success'
    paymentId: string
    status: string
  }> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: paymentResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: { commitToken: input.commitToken, previewId: input.previewId },
      operation: 'payment.confirm',
    }, transaction => {
      this.#assertRole(input.context, ['cashier'])
      const preview = paymentPreviewRowSchema.optional().parse(
        this.#database.driver.prepare(`
          SELECT preview.*, charge.charge_id, charge.charge_item_id,
            charge.status AS charge_status, charge.version AS charge_version,
            charge.total_fen AS current_amount_fen,
            outpatient_case.patient_id, outpatient_case.encounter_id,
            outpatient_case.account_id, outpatient_case.service_request_id,
            outpatient_case.prescription_id, outpatient_case.status AS case_status,
            prescription.status AS prescription_status,
            withdrawal.withdrawal_id
          FROM payment_preview AS preview
          JOIN charge_record AS charge
            ON charge.workspace_id = preview.workspace_id
           AND charge.epoch = preview.epoch
           AND charge.case_id = preview.case_id
           AND charge.category = preview.category
          JOIN outpatient_case
            ON outpatient_case.workspace_id = preview.workspace_id
           AND outpatient_case.epoch = preview.epoch
           AND outpatient_case.case_id = preview.case_id
          LEFT JOIN prescription
            ON prescription.workspace_id = outpatient_case.workspace_id
           AND prescription.epoch = outpatient_case.epoch
           AND prescription.prescription_id = outpatient_case.prescription_id
          LEFT JOIN prescription_withdrawal AS withdrawal
            ON withdrawal.workspace_id = prescription.workspace_id
           AND withdrawal.epoch = prescription.epoch
           AND withdrawal.prescription_id = prescription.prescription_id
          WHERE preview.workspace_id = ? AND preview.epoch = ? AND preview.preview_id = ?
        `).get(input.context.workspaceId, input.context.epoch, input.previewId),
      )
      if (preview === undefined || preview.consumed_at !== null) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The payment preview is unavailable')
      }
      this.#assertExpectedVersions(input.expectedVersions, [`ChargeItem/${preview.charge_item_id}`])
      if (preview.token_hash !== this.#hashToken(input.commitToken)) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The payment commit token is invalid')
      }
      if (Date.parse(preview.expires_at) < Date.parse(this.#virtualTime(input.context))) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The payment preview has expired')
      }
      if (!['billable', 'declined'].includes(preview.charge_status)) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The charge is no longer payable')
      }
      if (
        preview.charge_version !== preview.expected_charge_version
        || preview.current_amount_fen !== preview.amount_fen
      ) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The payment preview no longer matches the charge')
      }
      if (
        (preview.category === 'laboratory' && preview.case_status !== 'awaiting-lab-payment')
        || (preview.category === 'medication'
          && (preview.case_status !== 'awaiting-medication-payment'
            || preview.prescription_status !== 'signed'
            || preview.withdrawal_id !== null))
      ) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The clinical workflow is not ready for this payment')
      }
      const rule = this.#database.driver.prepare(`
        SELECT outcome FROM scenario_simulator_rule
        WHERE workspace_id = ? AND epoch = ? AND simulator = 'payment' AND rule_code = ?
      `).get(input.context.workspaceId, input.context.epoch, preview.simulator_rule) as {
        outcome: 'ambiguous' | 'declined' | 'success'
      } | undefined
      if (rule === undefined) throw new WorkflowError('CATALOG_CONFLICT', 'The payment simulator rule is unavailable')
      const paymentId = uuidv7()
      const now = this.#virtualTime(input.context)
      this.#database.driver.prepare(`
        INSERT INTO payment_transaction (
          workspace_id, epoch, payment_id, case_id, category, amount_fen,
          outcome, correlation_id, preview_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.context.workspaceId,
        input.context.epoch,
        paymentId,
        preview.case_id,
        preview.category,
        preview.amount_fen,
        rule.outcome,
        `sim-${paymentId}`,
        input.previewId,
        now,
      )
      this.#database.driver.prepare(`
        UPDATE payment_preview SET consumed_at = ?
        WHERE workspace_id = ? AND epoch = ? AND preview_id = ? AND consumed_at IS NULL
      `).run(now, input.context.workspaceId, input.context.epoch, input.previewId)
      let status = preview.case_status
      const effects: CommandEffect[] = [{
        kind: 'created' as const,
        reference: `PaymentTransaction/${paymentId}`,
        versionId: '1',
      }]
      const chargeItem = transaction.fhir.read(input.context, 'ChargeItem', preview.charge_item_id)
      const updatedChargeItem = transaction.fhir.update(input.context, {
        ...chargeItem,
        status: rule.outcome === 'success' ? 'billed' : 'billable',
      }, chargeItem.meta?.versionId ?? '1')
      effects.push({
        kind: 'updated',
        reference: `ChargeItem/${preview.charge_item_id}`,
        versionId: updatedChargeItem.meta?.versionId ?? String(preview.charge_version + 1),
      })
      if (rule.outcome === 'success') {
        this.#database.driver.prepare(`
          UPDATE charge_record SET status = 'paid', version = version + 1
          WHERE workspace_id = ? AND epoch = ? AND charge_id = ?
        `).run(input.context.workspaceId, input.context.epoch, preview.charge_id)
        status = preview.category === 'laboratory' ? 'awaiting-lis' : 'awaiting-dispense'
        this.#database.driver.prepare(`
          UPDATE outpatient_case SET status = ?, version = version + 1, updated_at = ?
          WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        `).run(status, now, input.context.workspaceId, input.context.epoch, preview.case_id)
        if (preview.category === 'laboratory') {
          transaction.enqueue({
            dedupKey: `lis:${preview.service_request_id}`,
            kind: 'lis.process-order',
            payload: {
              caseId: preview.case_id,
              encounterId: preview.encounter_id,
              patientId: preview.patient_id,
              serviceRequestId: preview.service_request_id,
            },
          })
        } else {
          this.#database.driver.prepare(`
            UPDATE prescription SET status = 'paid', version = version + 1
            WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
          `).run(input.context.workspaceId, input.context.epoch, preview.prescription_id)
          transaction.enqueue({
            dedupKey: `pharmacy:${preview.prescription_id}`,
            kind: 'pharmacy.ready',
            payload: { caseId: preview.case_id, prescriptionId: preview.prescription_id },
          })
        }
      } else {
        this.#database.driver.prepare(`
          UPDATE charge_record SET status = ?, version = version + 1
          WHERE workspace_id = ? AND epoch = ? AND charge_id = ?
        `).run(rule.outcome, input.context.workspaceId, input.context.epoch, preview.charge_id)
      }
      return {
        data: {
          amountFen: preview.amount_fen,
          outcome: rule.outcome,
          paymentId,
          status,
        },
        effects,
      }
    })
  }

  processLisOrder(input: {
    context: ActorContext
    eventId: string
    payload: {
      caseId: string
      encounterId: string
      patientId: string
      serviceRequestId: string
    }
  }): CommandResponse<{
    diagnosticReportId: string
    encounterVersion: string
    status: 'awaiting-revisit'
  }> {
    return this.#commands.execute({
      context: input.context,
      dataSchema: lisOrderDataSchema,
      expectedVersions: {},
      idempotencyKey: input.eventId,
      input: input.payload,
      operation: 'lis.process-order',
    }, transaction => {
      this.#assertRole(input.context, ['lis-system'])
      const outpatientCase = this.#database.driver.prepare(`
        SELECT case_id, patient_id, encounter_id, service_request_id,
          diagnostic_report_id, status
        FROM outpatient_case
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(input.context.workspaceId, input.context.epoch, input.payload.caseId) as {
        case_id: string
        diagnostic_report_id: string | null
        encounter_id: string
        patient_id: string
        service_request_id: string | null
        status: string
      } | undefined
      if (
        outpatientCase === undefined
        || outpatientCase.patient_id !== input.payload.patientId
        || outpatientCase.encounter_id !== input.payload.encounterId
        || outpatientCase.service_request_id !== input.payload.serviceRequestId
      ) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The paid laboratory request is not available to LIS')
      }
      if (outpatientCase.diagnostic_report_id !== null) {
        transaction.fhir.read(
          input.context,
          'DiagnosticReport',
          outpatientCase.diagnostic_report_id,
        )
        const encounter = transaction.fhir.read(
          input.context,
          'Encounter',
          outpatientCase.encounter_id,
        )
        return {
          data: {
            diagnosticReportId: outpatientCase.diagnostic_report_id,
            encounterVersion: encounter.meta?.versionId ?? '5',
            status: 'awaiting-revisit' as const,
          },
          effects: [],
        }
      }
      if (outpatientCase.status !== 'awaiting-lis') {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The paid laboratory request is not available to LIS')
      }
      const hiddenFact = this.#database.driver.prepare(`
        SELECT value_json FROM scenario_hidden_fact
        WHERE workspace_id = ? AND epoch = ? AND fact_code = 'respiratory-pathogen'
      `).get(input.context.workspaceId, input.context.epoch) as { value_json: string } | undefined
      if (hiddenFact === undefined) throw new WorkflowError('WORKFLOW_CONFLICT', 'The LIS Scenario fact is unavailable')
      const fact = respiratoryPathogenFactSchema.parse(JSON.parse(hiddenFact.value_json))
      const specimenId = `sp-${input.payload.serviceRequestId}`
      const influenzaObservationId = `obs-flu-${input.payload.serviceRequestId}`
      const bloodObservationId = `obs-wbc-${input.payload.serviceRequestId}`
      const diagnosticReportId = `dr-${input.payload.serviceRequestId}`
      const revisitTaskId = `task-rv-${input.payload.serviceRequestId}`
      const now = this.#virtualTime(input.context)
      const specimen = transaction.fhir.create(input.context, {
        resourceType: 'Specimen',
        id: specimenId,
        status: 'available',
        type: { text: 'Synthetic nasopharyngeal swab and blood specimen' },
        subject: { reference: `Patient/${input.payload.patientId}` },
        request: [{ reference: `ServiceRequest/${input.payload.serviceRequestId}` }],
        receivedTime: now,
      })
      const influenzaObservation = transaction.fhir.create(input.context, {
        resourceType: 'Observation',
        id: influenzaObservationId,
        status: 'final',
        category: [{ coding: [{ code: 'laboratory', system: 'http://terminology.hl7.org/CodeSystem/observation-category' }] }],
        code: { coding: [{ code: '80382-5', display: 'Influenza virus A Ag', system: 'http://loinc.org' }] },
        subject: { reference: `Patient/${input.payload.patientId}` },
        encounter: { reference: `Encounter/${input.payload.encounterId}` },
        basedOn: [{ reference: `ServiceRequest/${input.payload.serviceRequestId}` }],
        specimen: { reference: `Specimen/${specimenId}` },
        effectiveDateTime: now,
        valueBoolean: fact.detected,
        interpretation: [{ coding: [{ code: fact.detected ? 'POS' : 'NEG', system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation' }] }],
      })
      const bloodObservation = transaction.fhir.create(input.context, {
        resourceType: 'Observation',
        id: bloodObservationId,
        status: 'final',
        category: [{ coding: [{ code: 'laboratory', system: 'http://terminology.hl7.org/CodeSystem/observation-category' }] }],
        code: { coding: [{ code: '6690-2', display: 'Leukocytes [#/volume] in Blood', system: 'http://loinc.org' }] },
        subject: { reference: `Patient/${input.payload.patientId}` },
        encounter: { reference: `Encounter/${input.payload.encounterId}` },
        basedOn: [{ reference: `ServiceRequest/${input.payload.serviceRequestId}` }],
        specimen: { reference: `Specimen/${specimenId}` },
        effectiveDateTime: now,
        valueQuantity: { code: '10*9/L', system: 'http://unitsofmeasure.org', unit: '10^9/L', value: 6.8 },
        referenceRange: [{ low: { value: 3.5 }, high: { value: 9.5 }, text: '3.5-9.5 x10^9/L' }],
        interpretation: [{ coding: [{ code: 'N', system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation' }] }],
      })
      const report = transaction.fhir.create(input.context, {
        resourceType: 'DiagnosticReport',
        id: diagnosticReportId,
        status: 'final',
        code: { text: 'Synthetic fever laboratory panel' },
        subject: { reference: `Patient/${input.payload.patientId}` },
        encounter: { reference: `Encounter/${input.payload.encounterId}` },
        basedOn: [{ reference: `ServiceRequest/${input.payload.serviceRequestId}` }],
        specimen: [{ reference: `Specimen/${specimenId}` }],
        result: [
          { reference: `Observation/${influenzaObservationId}` },
          { reference: `Observation/${bloodObservationId}` },
        ],
        effectiveDateTime: now,
        issued: now,
        conclusion: fact.detected ? 'Influenza A antigen detected.' : 'Influenza A antigen not detected.',
      })
      const serviceRequest = transaction.fhir.read(input.context, 'ServiceRequest', input.payload.serviceRequestId)
      const completedRequest = transaction.fhir.update(input.context, {
        ...serviceRequest,
        status: 'completed',
      }, serviceRequest.meta?.versionId ?? '1')
      const encounter = transaction.fhir.read(input.context, 'Encounter', input.payload.encounterId)
      const updatedEncounter = transaction.fhir.update(input.context, {
        ...encounter,
        status: 'in-progress',
        extension: [
          ...(Array.isArray(encounter.extension) ? encounter.extension : []),
          {
            url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/workflow-phase',
            valueCode: 'awaiting-revisit',
          },
        ],
      }, encounter.meta?.versionId ?? '1')
      const revisitTask = transaction.fhir.create(input.context, {
        resourceType: 'Task',
        id: revisitTaskId,
        status: 'requested',
        intent: 'order',
        code: { text: 'Outpatient revisit after final laboratory report' },
        for: { reference: `Patient/${input.payload.patientId}` },
        focus: { reference: `Encounter/${input.payload.encounterId}` },
        owner: { reference: 'PractitionerRole/practitioner-role-outpatient-doctor' },
        authoredOn: now,
        input: [{
          type: { text: 'Diagnostic report' },
          valueReference: { reference: `DiagnosticReport/${diagnosticReportId}` },
        }],
      })
      this.#database.driver.prepare(`
        UPDATE outpatient_case
        SET status = 'awaiting-revisit', diagnostic_report_id = ?, doctor_task_id = ?,
          version = version + 1, updated_at = ?
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND status = 'awaiting-lis'
      `).run(
        diagnosticReportId,
        revisitTaskId,
        now,
        input.context.workspaceId,
        input.context.epoch,
        input.payload.caseId,
      )
      const created = [specimen, influenzaObservation, bloodObservation, report, revisitTask]
      const updated = [completedRequest, updatedEncounter]
      return {
        data: {
          diagnosticReportId,
          encounterVersion: updatedEncounter.meta?.versionId ?? '5',
          status: 'awaiting-revisit' as const,
        },
        effects: [
          ...created.map(resource => ({
            kind: 'created' as const,
            reference: `${resource.resourceType}/${resource.id}`,
            versionId: resource.meta?.versionId ?? '1',
          })),
          ...updated.map(resource => ({
            kind: 'updated' as const,
            reference: `${resource.resourceType}/${resource.id}`,
            versionId: resource.meta?.versionId ?? '2',
          })),
        ],
      }
    })
  }

  #assertRole(context: ActorContext, roles: string[]): void {
    if (!roles.includes(context.roleCode)) {
      throw new WorkflowError('ROLE_NOT_ALLOWED', 'The active Practitioner Role cannot perform this action')
    }
  }

  #requiredPractitionerRoleId(context: ActorContext): string {
    if (context.practitionerRoleId === undefined) {
      throw new WorkflowError('ROLE_NOT_ALLOWED', 'An active Practitioner Role is required')
    }
    return context.practitionerRoleId
  }

  #assignCaseResponsibility(context: ActorContext, caseId: string, assignedAt: string): void {
    const practitionerRoleId = this.#requiredPractitionerRoleId(context)
    this.#database.driver.prepare(`
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
    this.#assertCaseResponsibility(context, caseId)
  }

  #assertCaseResponsibility(context: ActorContext, caseId: string): void {
    const responsibility = practitionerRoleIdRowSchema.optional().parse(
      this.#database.driver.prepare(`
        SELECT practitioner_role_id
        FROM outpatient_case_responsibility
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(context.workspaceId, context.epoch, caseId),
    )
    if (responsibility?.practitioner_role_id !== this.#requiredPractitionerRoleId(context)) {
      throw new WorkflowError('ROLE_NOT_ALLOWED', 'The outpatient case belongs to another doctor')
    }
  }

  #isRegistrationLocation(resource: FhirResource): boolean {
    if (resource.resourceType !== 'Location' || resource.status !== 'active') return false
    if (!Array.isArray(resource.type)) return false
    return resource.type.some(type => {
      if (typeof type !== 'object' || type === null) return false
      const coding = (type as Record<string, unknown>).coding
      return Array.isArray(coding) && coding.some(candidate => (
        typeof candidate === 'object'
        && candidate !== null
        && (candidate as Record<string, unknown>).code === 'outpatient-registration'
      ))
    })
  }

  #prescriptionChargeLines(context: ActorContext, sourceReference: string) {
    const prescriptionId = sourceReference.startsWith('Prescription/')
      ? sourceReference.slice('Prescription/'.length)
      : ''
    const rows = this.#database.driver.prepare(`
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

  #assertExpectedVersions(expectedVersions: Record<string, string>, references: string[]): void {
    const missing = references.filter(reference => expectedVersions[reference] === undefined)
    if (missing.length > 0) {
      throw new WorkflowError(
        'WORKFLOW_CONFLICT',
        `Expected versions are required for ${missing.join(', ')}`,
      )
    }
  }

  #clinicalExpectedReferences(
    context: ActorContext,
    caseId: string,
    encounterId: string,
    taskId: string | null,
  ): string[] {
    const revisit = this.#database.driver.prepare(`
      SELECT content_json FROM clinical_draft
      WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND draft_kind = 'revisit'
    `).get(context.workspaceId, context.epoch, caseId) as { content_json: string } | undefined
    const conditionId = revisit === undefined
      ? undefined
      : revisitDraftContentSchema.parse(JSON.parse(revisit.content_json)).conditionId
    const medicationRequestIds = (this.#database.driver.prepare(`
      SELECT item.medication_request_id
      FROM prescription_item AS item
      JOIN prescription
        ON prescription.workspace_id = item.workspace_id
       AND prescription.epoch = item.epoch
       AND prescription.prescription_id = item.prescription_id
      WHERE item.workspace_id = ? AND item.epoch = ? AND prescription.case_id = ?
      ORDER BY item.medication_request_id
    `).all(context.workspaceId, context.epoch, caseId) as Array<{
      medication_request_id: string
    }>).map(row => row.medication_request_id)
    return [
      `Encounter/${encounterId}`,
      ...(taskId === null ? [] : [`Task/${taskId}`]),
      ...(typeof conditionId === 'string' ? [`Condition/${conditionId}`] : []),
      ...medicationRequestIds.map(id => `MedicationRequest/${id}`),
    ]
  }

  #transitionToFirstVisit(
    context: ActorContext,
    transaction: CommandTransaction,
    input: {
      caseId: string
      encounterId: string
      expectedVersions: Record<string, string>
      previousStatus: 'awaiting-doctor' | 'awaiting-triage'
      queueTaskId: string
    },
  ) {
    const encounterReference = `Encounter/${input.encounterId}`
    const taskReference = `Task/${input.queueTaskId}`
    this.#assertExpectedVersions(input.expectedVersions, [encounterReference, taskReference])
    const encounter = transaction.fhir.read(context, 'Encounter', input.encounterId)
    const task = transaction.fhir.read(context, 'Task', input.queueTaskId)
    const now = this.#virtualTime(context)
    const updatedEncounter = transaction.fhir.update(context, {
      ...encounter,
      status: 'in-progress',
      extension: [
        ...(Array.isArray(encounter.extension) ? encounter.extension : []),
        {
          url: 'https://caizongyuan.github.io/clinmesh/fhir/StructureDefinition/workflow-phase',
          valueCode: 'first-visit',
        },
      ],
    }, encounter.meta?.versionId ?? '1')
    const updatedTask = transaction.fhir.update(context, {
      ...task,
      code: { text: 'Outpatient consultation' },
      status: 'in-progress',
      executionPeriod: { start: now },
      owner: { reference: `PractitionerRole/${context.practitionerRoleId}` },
    }, task.meta?.versionId ?? '1')
    const updateCase = this.#database.driver.prepare(`
      UPDATE outpatient_case
      SET doctor_task_id = ?, status = 'first-visit', version = version + 1, updated_at = ?
      WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND status = ?
    `).run(
      input.queueTaskId,
      now,
      context.workspaceId,
      context.epoch,
      input.caseId,
      input.previousStatus,
    )
    if (updateCase.changes !== 1) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The outpatient case state has changed')
    }
    this.#assignCaseResponsibility(context, input.caseId, now)
    this.#database.driver.prepare(`
      UPDATE registration SET status = 'in-progress'
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
    `).run(context.workspaceId, context.epoch, input.caseId)
    return {
      effects: [updatedEncounter, updatedTask].map(resource => ({
        kind: 'updated' as const,
        reference: `${resource.resourceType}/${resource.id}`,
        versionId: resource.meta?.versionId ?? '1',
      })),
      encounterVersion: updatedEncounter.meta?.versionId ?? '1',
      taskVersion: updatedTask.meta?.versionId ?? '1',
    }
  }

  #reuseVirtualPatientIntake(
    context: ActorContext,
    transaction: CommandTransaction,
    activeCase: ActiveOutpatientCaseRow,
    expectedVersions: Record<string, string>,
  ): VirtualPatientIntake {
    if (activeCase.status === 'first-visit') {
      if (activeCase.doctor_task_id === null) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The patient has an incompatible active outpatient case')
      }
      this.#assertExpectedVersions(expectedVersions, [
        `Encounter/${activeCase.encounter_id}`,
        `Task/${activeCase.doctor_task_id}`,
      ])
      return {
        caseId: activeCase.case_id,
        effects: [],
        encounterId: activeCase.encounter_id,
        queueTaskId: activeCase.doctor_task_id,
        registrationId: activeCase.registration_id,
      }
    }
    if (activeCase.status !== 'awaiting-triage' && activeCase.status !== 'awaiting-doctor') {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The patient has an incompatible active outpatient case')
    }
    const queueTaskId = activeCase.status === 'awaiting-triage'
      ? activeCase.initial_task_id
      : activeCase.doctor_task_id
    if (queueTaskId === null) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The patient has an incompatible active outpatient case')
    }
    const transition = this.#transitionToFirstVisit(context, transaction, {
      caseId: activeCase.case_id,
      encounterId: activeCase.encounter_id,
      expectedVersions,
      previousStatus: activeCase.status,
      queueTaskId,
    })
    return {
      caseId: activeCase.case_id,
      effects: transition.effects,
      encounterId: activeCase.encounter_id,
      queueTaskId,
      registrationId: activeCase.registration_id,
    }
  }

  #activeCaseByPatient(context: ActorContext, patientId: string) {
    return activeOutpatientCaseRowSchema.optional().parse(this.#database.driver.prepare(`
      SELECT case_id, registration_id, encounter_id, initial_task_id, doctor_task_id, status
      FROM outpatient_case
      WHERE workspace_id = ? AND epoch = ? AND patient_id = ? AND status != 'completed'
    `).get(context.workspaceId, context.epoch, patientId))
  }

  #virtualPatientExpectedVersions(context: ActorContext, patientId: string): Record<string, string> {
    const activeCase = this.#activeCaseByPatient(context, patientId)
    if (activeCase === undefined) return {}
    const taskId = activeCase.status === 'awaiting-triage'
      ? activeCase.initial_task_id
      : (activeCase.doctor_task_id ?? activeCase.initial_task_id)
    const encounter = this.#fhir.read(context, 'Encounter', activeCase.encounter_id)
    const task = this.#fhir.read(context, 'Task', taskId)
    return {
      [`Encounter/${encounter.id}`]: encounter.meta?.versionId ?? '1',
      [`Task/${task.id}`]: task.meta?.versionId ?? '1',
    }
  }

  #caseByEncounter(context: ActorContext, encounterId: string) {
    const row = this.#database.driver.prepare(`
      SELECT case_id, patient_id, encounter_id, account_id, doctor_task_id, status
      FROM outpatient_case
      WHERE workspace_id = ? AND epoch = ? AND encounter_id = ?
    `).get(context.workspaceId, context.epoch, encounterId) as {
      account_id: string
      case_id: string
      doctor_task_id: string | null
      encounter_id: string
      patient_id: string
      status: string
    } | undefined
    if (row === undefined) throw new WorkflowError('WORKFLOW_CONFLICT', 'The Encounter was not found')
    return row
  }

  #laboratoryRequestCaseForAction(
    context: ActorContext,
    encounterId: string,
    action: 'edit-draft' | 'issue',
  ) {
    this.#assertRole(context, ['outpatient-doctor'])
    const outpatientCase = this.#caseByEncounter(context, encounterId)
    this.#assertCaseResponsibility(context, outpatientCase.case_id)
    if (outpatientCase.status !== 'first-visit'
      || this.#consultationState(context, outpatientCase.case_id) === undefined) {
      const message = action === 'issue'
        ? 'The Encounter cannot issue a laboratory request'
        : 'The Encounter cannot edit a laboratory request draft'
      throw new WorkflowError('WORKFLOW_CONFLICT', message)
    }
    return outpatientCase
  }

  #consultationDetail(context: ActorContext, caseId: string) {
    const state = this.#consultationState(context, caseId)
    if (state === undefined) return undefined
    const questions = z.array(consultationQuestionRowSchema).parse(
      this.#database.driver.prepare(`
        SELECT question_code, question_text
        FROM virtual_patient_question_rule
        WHERE workspace_id = ? AND epoch = ? AND virtual_patient_id = ?
        ORDER BY ordinal, question_code
      `).all(context.workspaceId, context.epoch, state.virtual_patient_id),
    )
    const records = z.array(consultationRecordRowSchema).parse(
      this.#database.driver.prepare(`
        SELECT record_id, sequence, question_code, question_text, answer_text, recorded_at
        FROM consultation_record
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        ORDER BY sequence
      `).all(context.workspaceId, context.epoch, caseId),
    )
    return {
      questions: questions.map(question => ({
        code: question.question_code,
        text: question.question_text,
      })),
      records: records.map(record => ({
        answer: record.answer_text,
        id: record.record_id,
        question: {
          code: record.question_code,
          text: record.question_text,
        },
        recordedAt: record.recorded_at,
        sequence: record.sequence,
      })),
      version: state.version,
    }
  }

  #documentBundleEntries(
    context: ActorContext,
    transaction: CommandTransaction,
    composition: FhirResource,
    sourceEntries: unknown = [],
  ) {
    const parsedSourceEntries = z.array(documentBundleEntrySchema).safeParse(sourceEntries)
    const sourceResources = new Map((parsedSourceEntries.success ? parsedSourceEntries.data : []).map(entry => [
      `${entry.resource.resourceType}/${entry.resource.id}`,
      entry.resource,
    ]))
    const resources = [composition]
    const visited = new Set([`${composition.resourceType}/${composition.id}`])
    const pendingReferences = localFhirReferences(composition)
    for (let index = 0; index < pendingReferences.length; index += 1) {
      const reference = pendingReferences[index]
      if (reference === undefined || visited.has(reference)) continue
      const [resourceType, resourceId] = reference.split('/')
      if (resourceType === undefined || resourceId === undefined) continue
      const resource = sourceResources.get(reference)
        ?? transaction.fhir.read(context, resourceType, resourceId)
      visited.add(reference)
      resources.push(resource)
      pendingReferences.push(...localFhirReferences(resource))
    }
    return resources.map(resource => ({
      fullUrl: `${fhirCanonicalBase}/${resource.resourceType}/${resource.id}`,
      resource,
    }))
  }

  #signedClinicalDocumentRoot(context: ActorContext, caseId: string) {
    return this.#database.driver.prepare(`
      SELECT document_id FROM signed_clinical_document
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        AND revision_of_document_id IS NULL
    `).get(context.workspaceId, context.epoch, caseId) as { document_id: string } | undefined
  }

  #clinicalDocumentRevisionNumber(context: ActorContext, documentId: string): number {
    const row = this.#database.driver.prepare(`
      WITH RECURSIVE document_chain (document_id, revision_of_document_id) AS (
        SELECT document_id, revision_of_document_id
        FROM signed_clinical_document
        WHERE workspace_id = ? AND epoch = ? AND document_id = ?
        UNION ALL
        SELECT parent.document_id, parent.revision_of_document_id
        FROM signed_clinical_document AS parent
        JOIN document_chain AS child
          ON child.revision_of_document_id = parent.document_id
        WHERE parent.workspace_id = ? AND parent.epoch = ?
      )
      SELECT COUNT(*) AS count FROM document_chain
    `).get(
      context.workspaceId,
      context.epoch,
      documentId,
      context.workspaceId,
      context.epoch,
    ) as { count: number }
    return row.count
  }

  #structuredClinicalDocuments(context: ActorContext, caseId: string) {
    return this.#clinicalDocuments(
      context,
      caseId,
      structuredClinicalDocumentFromComposition,
    )
  }

  #completedCaseClinicalDocuments(context: ActorContext, caseId: string) {
    return this.#clinicalDocuments(
      context,
      caseId,
      resource => structuredClinicalDocumentFromComposition(resource)
        ?? legacyClinicalDocumentFromComposition(resource),
    ).map(document => ({
      ...document,
      correctionSupported: clinicalDocumentContentSchema.safeParse(document.content).success,
    }))
  }

  #clinicalDocuments<Content>(
    context: ActorContext,
    caseId: string,
    contentFromComposition: (resource: FhirResource) => Content | undefined,
  ) {
    const rows = z.array(signedClinicalDocumentRowSchema).parse(
      this.#database.driver.prepare(`
        SELECT document_id, composition_id, bundle_id, provenance_id,
          revision_of_document_id, signed_at
        FROM signed_clinical_document
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        ORDER BY signed_at, document_id
      `).all(context.workspaceId, context.epoch, caseId),
    )
    const documentsById = new Map<string, { compositionId: string; revisionNumber: number }>()
    return rows.flatMap(row => {
      const composition = this.#fhir.read(context, 'Composition', row.composition_id)
      const content = contentFromComposition(composition)
      if (content === undefined) return []
      const provenance = provenanceReasonSchema.parse(
        this.#fhir.read(context, 'Provenance', row.provenance_id),
      )
      const revisionReason = provenance.reason?.[0]?.concept.text
      const parent = row.revision_of_document_id === null
        ? undefined
        : documentsById.get(row.revision_of_document_id)
      const revisionNumber = (parent?.revisionNumber ?? 0) + 1
      documentsById.set(row.document_id, {
        compositionId: row.composition_id,
        revisionNumber,
      })
      return [{
        bundleId: row.bundle_id,
        compositionId: row.composition_id,
        compositionVersion: composition.meta?.versionId ?? '1',
        content,
        documentId: row.document_id,
        provenanceId: row.provenance_id,
        revisionNumber,
        ...(parent === undefined ? {} : { revisionOfCompositionId: parent.compositionId }),
        ...(revisionReason === undefined ? {} : { revisionReason }),
        signedAt: row.signed_at,
      }]
    })
  }

  #consultationState(context: ActorContext, caseId: string) {
    return consultationStateRowSchema.optional().parse(
      this.#database.driver.prepare(`
        SELECT consultation.version, virtual_patient_case.virtual_patient_id
        FROM consultation
        JOIN virtual_patient_case
          ON virtual_patient_case.workspace_id = consultation.workspace_id
         AND virtual_patient_case.epoch = consultation.epoch
         AND virtual_patient_case.case_id = consultation.case_id
        WHERE consultation.workspace_id = ? AND consultation.epoch = ?
          AND consultation.case_id = ?
      `).get(context.workspaceId, context.epoch, caseId),
    )
  }

  #encounterCompletionPolicy(context: ActorContext, encounterId: string) {
    const outpatientCase = this.#caseByEncounter(context, encounterId)
    if (this.#consultationState(context, outpatientCase.case_id) === undefined) {
      throw new WorkflowError(
        'WORKFLOW_CONFLICT',
        'Encounter completion is available only for an independent Consultation',
      )
    }
    const encounter = encounterCompletionResourceSchema.parse(
      this.#fhir.read(context, 'Encounter', encounterId),
    )
    const diagnosis = this.#diagnosisConfirmation(context, outpatientCase.case_id)
    const primaryDiagnosisConfirmed = diagnosis?.entries.some(entry => entry.role === 'primary') === true
    const documents = this.#structuredClinicalDocuments(context, outpatientCase.case_id)
    const signedDocument = documents.at(-1)
    const activeLaboratoryRequests = z.array(laboratoryRequestRowSchema.pick({ status: true })).parse(
      this.#database.driver.prepare(`
        SELECT status FROM laboratory_request
        WHERE workspace_id = ? AND epoch = ? AND case_id = ? AND status <> 'cancelled'
      `).all(context.workspaceId, context.epoch, outpatientCase.case_id),
    )
    const requiredReportsAcknowledged = activeLaboratoryRequests.every(
      request => request.status === 'acknowledged',
    )
    const prescription = this.#issuedPrescription(context, outpatientCase.case_id)
    const medicationConclusionRecorded = (
      prescription !== undefined && prescription.status !== 'withdrawn'
    ) || this.#noMedicationConclusion(context, outpatientCase.case_id) !== undefined
    const clinicalDocumentDraft = z.object({ present: z.literal(1) }).strict().optional().parse(
      this.#database.driver.prepare(`
        SELECT 1 AS present FROM clinical_document_draft
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(context.workspaceId, context.epoch, outpatientCase.case_id),
    )
    const diagnosisDraft = diagnosisStateRowSchema.pick({ draft_json: true }).optional().parse(
      this.#database.driver.prepare(`
        SELECT draft_json FROM diagnosis_state
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(context.workspaceId, context.epoch, outpatientCase.case_id),
    )
    const laboratoryDraft = this.#laboratoryRequestState(context, outpatientCase.case_id)
    const prescriptionDraft = prescriptionDraftStateRowSchema.pick({ draft_json: true }).optional().parse(
      this.#database.driver.prepare(`
        SELECT draft_json FROM prescription_draft_state
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(context.workspaceId, context.epoch, outpatientCase.case_id),
    )
    let pendingDraftTarget: EncounterCompletionTarget | undefined
    if (signedDocument === undefined && clinicalDocumentDraft !== undefined) {
      pendingDraftTarget = 'clinical-document'
    } else if (typeof laboratoryDraft?.draft_catalog_item_id === 'string') {
      pendingDraftTarget = 'laboratory'
    } else if (diagnosisDraft?.draft_json !== null && diagnosisDraft?.draft_json !== undefined) {
      pendingDraftTarget = 'diagnosis'
    } else if (prescriptionDraft?.draft_json !== null && prescriptionDraft?.draft_json !== undefined) {
      pendingDraftTarget = 'medication-conclusion'
    }
    const noPendingDrafts = pendingDraftTarget === undefined
    const dispositionComplete = (signedDocument?.content.disposition.trim().length ?? 0) >= 2
    const followUpComplete = (signedDocument?.content.followUp.trim().length ?? 0) >= 2
    const items = [
      {
        code: 'primary-diagnosis-confirmed' as const,
        status: primaryDiagnosisConfirmed ? 'complete' as const : 'incomplete' as const,
        statusText: primaryDiagnosisConfirmed ? '已确认主诊断' : '待确认主诊断',
        target: 'diagnosis' as const,
      },
      {
        code: 'clinical-document-signed' as const,
        status: signedDocument === undefined ? 'incomplete' as const : 'complete' as const,
        statusText: signedDocument === undefined ? '待签署结构化病历' : '已签署结构化病历',
        target: 'clinical-document' as const,
      },
      {
        code: 'required-reports-acknowledged' as const,
        status: requiredReportsAcknowledged ? 'complete' as const : 'incomplete' as const,
        statusText: requiredReportsAcknowledged
          ? '必要报告已全部确认已阅'
          : '待确认必要报告已阅',
        target: 'laboratory' as const,
      },
      {
        code: 'medication-conclusion-recorded' as const,
        status: medicationConclusionRecorded ? 'complete' as const : 'incomplete' as const,
        statusText: medicationConclusionRecorded ? '已记录用药结论' : '待记录用药结论',
        target: 'medication-conclusion' as const,
      },
      {
        code: 'no-pending-drafts' as const,
        status: noPendingDrafts ? 'complete' as const : 'incomplete' as const,
        statusText: noPendingDrafts ? '无未处理临床草稿' : '存在未处理临床草稿',
        target: pendingDraftTarget ?? 'clinical-document',
      },
      {
        code: 'disposition-complete' as const,
        status: dispositionComplete ? 'complete' as const : 'incomplete' as const,
        statusText: dispositionComplete ? '已完善处置' : '待完善处置',
        target: 'clinical-document' as const,
      },
      {
        code: 'follow-up-complete' as const,
        status: followUpComplete ? 'complete' as const : 'incomplete' as const,
        statusText: followUpComplete ? '已完善随访安排' : '待完善随访安排',
        target: 'clinical-document' as const,
      },
    ]
    return {
      canComplete: encounter.status === 'in-progress'
        && items.every(item => item.status === 'complete'),
      encounterId,
      encounterVersion: encounter.meta.versionId,
      items,
    }
  }

  #laboratoryRequestState(context: ActorContext, caseId: string) {
    return laboratoryRequestStateRowSchema.optional().parse(
      this.#database.driver.prepare(`
        SELECT version, draft_catalog_item_id, draft_indication_code
        FROM laboratory_request_state
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(context.workspaceId, context.epoch, caseId),
    )
  }

  #expectedVersionWorkflowError(
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

  #prescriptionDraftConflictStatus(
    context: ActorContext,
    encounterId: string,
  ): NonNullable<ApiConflict['currentStatus']> {
    const outpatientCase = this.#caseByEncounter(context, encounterId)
    const state = prescriptionDraftStateRowSchema.optional().parse(
      this.#database.driver.prepare(`
        SELECT version, draft_json FROM prescription_draft_state
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(context.workspaceId, context.epoch, outpatientCase.case_id),
    )
    if (state === undefined) return 'missing'
    return state.draft_json === null ? 'empty' : 'draft'
  }

  #laboratoryRequestDraftConflictStatus(
    context: ActorContext,
    encounterId: string,
  ): NonNullable<ApiConflict['currentStatus']> {
    const outpatientCase = this.#caseByEncounter(context, encounterId)
    const state = this.#laboratoryRequestState(context, outpatientCase.case_id)
    if (state === undefined) return 'missing'
    return state.draft_catalog_item_id === null ? 'empty' : 'draft'
  }

  #clinicalDocumentConflictStatus(
    context: ActorContext,
    compositionId: string,
  ): NonNullable<ApiConflict['currentStatus']> {
    const source = clinicalDocumentIdRowSchema.optional().parse(
      this.#database.driver.prepare(`
        SELECT document_id FROM signed_clinical_document
        WHERE workspace_id = ? AND epoch = ? AND composition_id = ?
      `).get(context.workspaceId, context.epoch, compositionId),
    )
    if (source === undefined) return 'missing'
    return this.#clinicalDocumentHasSuccessor(context, source.document_id)
      ? 'superseded'
      : 'signed'
  }

  #clinicalDocumentHasSuccessor(context: ActorContext, documentId: string): boolean {
    const successor = clinicalDocumentIdRowSchema.optional().parse(
      this.#database.driver.prepare(`
        SELECT document_id FROM signed_clinical_document
        WHERE workspace_id = ? AND epoch = ? AND revision_of_document_id = ?
      `).get(context.workspaceId, context.epoch, documentId),
    )
    return successor !== undefined
  }

  #laboratoryReportConflictStatus(
    context: ActorContext,
    requestId: string,
    diagnosticReportId: string,
  ): NonNullable<ApiConflict['currentStatus']> {
    const request = this.#laboratoryRequest(context, requestId)
    if (request === undefined) return 'missing'
    if (request.diagnostic_report_id !== diagnosticReportId) return 'superseded'
    return request.status
  }

  #laboratoryRequests(context: ActorContext, caseId: string) {
    const requests = z.array(laboratoryRequestRowSchema).parse(
      this.#database.driver.prepare(`
        SELECT request_id, catalog_item_id, indication_code, service_request_id,
          execution_task_id, diagnostic_report_id, status, version
        FROM laboratory_request
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        ORDER BY authored_at, request_id
      `).all(context.workspaceId, context.epoch, caseId),
    ).map((request) => {
      const serviceRequest = this.#fhir.read(
        context,
        'ServiceRequest',
        request.service_request_id,
      )
      const task = this.#fhir.read(context, 'Task', request.execution_task_id)
      const reportVersions = request.diagnostic_report_id === null
        ? []
        : this.#laboratoryReportVersions(
            context,
            request.request_id,
            request.diagnostic_report_id,
            request.service_request_id,
          )
      return {
        catalogItemId: request.catalog_item_id,
        id: request.request_id,
        indicationCode: request.indication_code,
        previousReports: reportVersions.slice(0, -1),
        ...(reportVersions.length === 0 ? {} : { report: reportVersions.at(-1) }),
        serviceRequestId: request.service_request_id,
        serviceRequestVersion: serviceRequest.meta?.versionId ?? '1',
        status: request.status,
        taskId: request.execution_task_id,
        taskVersion: task.meta?.versionId ?? '1',
        version: request.version,
      }
    })
    return z.array(laboratoryRequestSchema).parse(requests)
  }

  #completedCaseLaboratoryRequests(context: ActorContext, caseId: string) {
    const independentRequests = this.#laboratoryRequests(context, caseId)
    if (independentRequests.length > 0) {
      return independentRequests.map(request => ({
        ...request,
        correctionSupported: true,
      }))
    }
    const row = legacyCompletedCaseLaboratoryRowSchema.optional().parse(
      this.#database.driver.prepare(`
        SELECT service_request_id, laboratory_task_id, diagnostic_report_id
        FROM outpatient_case
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(context.workspaceId, context.epoch, caseId),
    )
    if (
      row?.service_request_id === null
      || row?.diagnostic_report_id === null
      || row === undefined
    ) return []
    const serviceRequestResource = this.#fhir.read(
      context,
      'ServiceRequest',
      row.service_request_id,
    )
    const serviceRequest = completedCaseServiceRequestSchema.parse(serviceRequestResource)
    const task = row.laboratory_task_id === null
      ? undefined
      : this.#fhir.read(context, 'Task', row.laboratory_task_id)
    const reportResource = this.#fhir.read(context, 'DiagnosticReport', row.diagnostic_report_id)
    const report = completedCaseDiagnosticReportSchema.parse(reportResource)
    const specimenReference = report.specimen[0]?.reference
    if (specimenReference === undefined || !specimenReference.startsWith('Specimen/')) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The completed laboratory report specimen is invalid')
    }
    const results = report.result.map((reference) => {
      if (!reference.reference.startsWith('Observation/')) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The completed laboratory result is invalid')
      }
      const observationId = reference.reference.slice('Observation/'.length)
      const observation = completedCaseObservationSchema.parse(
        this.#fhir.read(context, 'Observation', observationId),
      )
      const coding = observation.code.coding[0]
      const value = observation.valueBoolean
        ?? observation.valueQuantity?.value
        ?? observation.valueString
      if (coding === undefined || value === undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The completed laboratory result is incomplete')
      }
      const referenceRange = observation.referenceRange?.[0]
      const unit = observation.valueQuantity?.unit
      return {
        code: coding.code,
        display: coding.display ?? coding.code,
        ...(completedCaseInterpretation(observation.interpretation?.[0]?.coding[0]?.code) === undefined
          ? {}
          : {
              interpretation: completedCaseInterpretation(
                observation.interpretation?.[0]?.coding[0]?.code,
              ),
            }),
        observationId,
        ...(referenceRange?.text === undefined ? {} : { referenceRange }),
        ...(unit === undefined
          ? {}
          : {
              unit: {
                ...(observation.valueQuantity?.code === undefined
                  ? {}
                  : { code: observation.valueQuantity.code }),
                display: unit,
                ...(observation.valueQuantity?.system === undefined
                  ? {}
                  : { system: observation.valueQuantity.system }),
              },
            }),
        value,
      }
    })
    const catalog = z.object({ item_id: z.string().min(1) }).strict().optional().parse(
      this.#database.driver.prepare(`
        SELECT item_id FROM outpatient_catalog
        WHERE workspace_id = ? AND epoch = ? AND kind = 'laboratory'
          AND (name_zh = ? OR name_en = ?)
        ORDER BY item_id
        LIMIT 1
      `).get(
        context.workspaceId,
        context.epoch,
        serviceRequest.code.concept.text,
        serviceRequest.code.concept.text,
      ),
    )
    return [{
      catalogDisplay: serviceRequest.code.concept.text,
      ...(catalog === undefined ? {} : { catalogItemId: catalog.item_id }),
      correctionSupported: false,
      id: `legacy-${row.service_request_id}`,
      indicationCode: serviceRequest.reason[0]?.concept.coding[0]?.code ?? 'legacy-indication',
      previousReports: [],
      report: {
        conclusion: report.conclusion,
        diagnosticReportId: row.diagnostic_report_id,
        diagnosticReportVersion: report.meta.versionId,
        issuedAt: report.issued,
        revisionNumber: 1,
        results,
        specimenId: specimenReference.slice('Specimen/'.length),
        status: report.status,
      },
      serviceRequestId: row.service_request_id,
      serviceRequestVersion: serviceRequest.meta.versionId,
      status: 'reported' as const,
      ...(row.laboratory_task_id === null
        ? {}
        : {
            taskId: row.laboratory_task_id,
            taskVersion: task?.meta?.versionId ?? '1',
          }),
      version: 1,
    }]
  }

  #completedCaseDiagnosis(context: ActorContext, caseId: string) {
    const confirmation = this.#diagnosisConfirmation(context, caseId)
    if (confirmation !== undefined) return confirmation
    const rows = z.array(signedClinicalDocumentRowSchema).parse(
      this.#database.driver.prepare(`
        SELECT document_id, composition_id, bundle_id, provenance_id,
          revision_of_document_id, signed_at
        FROM signed_clinical_document
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        ORDER BY signed_at DESC, document_id DESC
      `).all(context.workspaceId, context.epoch, caseId),
    )
    for (const row of rows) {
      const conditionReference = legacyDiagnosisReferenceFromComposition(
        this.#fhir.read(context, 'Composition', row.composition_id),
      )
      if (conditionReference === undefined) continue
      const conditionId = conditionReference.slice('Condition/'.length)
      const resource = this.#fhir.read(context, 'Condition', conditionId)
      const condition = confirmedDiagnosisConditionSchema.parse(resource)
      const coding = condition.code.coding[0]
      if (coding === undefined) continue
      const catalog = z.object({ item_id: z.string().min(1) }).strict().optional().parse(
        this.#database.driver.prepare(`
          SELECT item_id FROM diagnosis_catalog
          WHERE workspace_id = ? AND epoch = ? AND code_system = ? AND code = ?
          ORDER BY item_id
          LIMIT 1
        `).get(context.workspaceId, context.epoch, coding.system, coding.code),
      )
      const note = condition.note?.[0]?.text
      return {
        confirmedAt: row.signed_at,
        entries: [{
          ...(catalog === undefined ? {} : { catalogItemId: catalog.item_id }),
          code: coding.code,
          conditionId,
          conditionVersion: resource.meta?.versionId ?? '1',
          display: coding.display,
          ...(note === undefined ? {} : { note }),
          role: 'primary' as const,
          system: coding.system,
        }],
        id: `legacy-${row.document_id}`,
        provenanceId: row.provenance_id,
      }
    }
    return undefined
  }

  #completedCaseTimeline(
    context: ActorContext,
    input: Pick<
      z.infer<typeof doctorCompletedCaseDetailSchema>,
      | 'clinicalDocuments'
      | 'caseId'
      | 'completedAt'
      | 'consultation'
      | 'diagnosis'
      | 'laboratoryRequests'
      | 'medicationConclusion'
    > & { encounterId: string },
  ) {
    const events: Array<z.input<typeof doctorCompletedCaseTimelineEventSchema>> = [
      ...this.#completedCaseDraftDeletionEvents(context, input.caseId),
    ]
    for (const record of input.consultation?.records ?? []) {
      events.push({
        kind: 'consultation-recorded',
        occurredAt: record.recordedAt,
        reference: `ConsultationRecord/${record.id}`,
        relatedReferences: [],
      })
    }
    for (const document of input.clinicalDocuments) {
      events.push({
        kind: document.revisionNumber === 1
          ? 'clinical-document-signed'
          : 'clinical-document-revised',
        occurredAt: document.signedAt,
        reference: `Composition/${document.compositionId}`,
        relatedReferences: [
          `Bundle/${document.bundleId}`,
          `ClinicalDocument/${document.documentId}`,
          `Provenance/${document.provenanceId}`,
          ...(document.revisionOfCompositionId === undefined
            ? []
            : [`Composition/${document.revisionOfCompositionId}`]),
        ],
      })
    }
    for (const request of input.laboratoryRequests) {
      const serviceRequest = z.object({
        authoredOn: z.iso.datetime({ offset: true }),
        resourceType: z.literal('ServiceRequest'),
      }).loose().parse(this.#fhir.read(context, 'ServiceRequest', request.serviceRequestId))
      events.push({
        kind: 'laboratory-request-issued',
        occurredAt: serviceRequest.authoredOn,
        reference: `ServiceRequest/${request.serviceRequestId}`,
        relatedReferences: [
          `LaboratoryRequest/${request.id}`,
          ...(request.taskId === undefined ? [] : [`Task/${request.taskId}`]),
        ],
      })
      if (request.status === 'cancelled') {
        const cancellation = z.object({
          cancelled_at: z.iso.datetime({ offset: true }),
        }).strict().parse(this.#database.driver.prepare(`
          SELECT cancelled_at FROM laboratory_request
          WHERE workspace_id = ? AND epoch = ? AND request_id = ?
            AND cancelled_at IS NOT NULL
        `).get(context.workspaceId, context.epoch, request.id))
        events.push({
          kind: 'laboratory-request-cancelled',
          occurredAt: cancellation.cancelled_at,
          reference: `LaboratoryRequest/${request.id}`,
          relatedReferences: [
            `ServiceRequest/${request.serviceRequestId}`,
            ...(request.taskId === undefined ? [] : [`Task/${request.taskId}`]),
          ],
        })
      }
      for (const report of [
        ...request.previousReports,
        ...(request.report === undefined ? [] : [request.report]),
      ]) {
        events.push({
          kind: report.revisionNumber === 1
            ? 'laboratory-report-issued'
            : 'laboratory-report-revised',
          occurredAt: report.issuedAt,
          reference: `DiagnosticReport/${report.diagnosticReportId}`,
          relatedReferences: [
            `ServiceRequest/${request.serviceRequestId}`,
            `Specimen/${report.specimenId}`,
            ...report.results.map(result => `Observation/${result.observationId}`),
            ...(report.revisionOfDiagnosticReportId === undefined
              ? []
              : [`DiagnosticReport/${report.revisionOfDiagnosticReportId}`]),
          ],
        })
        if (report.acknowledgement !== undefined) {
          events.push({
            kind: 'laboratory-report-acknowledged',
            occurredAt: report.acknowledgement.acknowledgedAt,
            reference: `ReportAcknowledgement/${report.acknowledgement.id}`,
            relatedReferences: [`DiagnosticReport/${report.diagnosticReportId}`],
          })
        }
      }
    }
    if (input.diagnosis !== undefined) {
      const legacyCondition = input.diagnosis.id.startsWith('legacy-')
        ? input.diagnosis.entries[0]
        : undefined
      events.push({
        kind: 'diagnosis-confirmed',
        occurredAt: input.diagnosis.confirmedAt,
        reference: legacyCondition === undefined
          ? `DiagnosisConfirmation/${input.diagnosis.id}`
          : `Condition/${legacyCondition.conditionId}`,
        relatedReferences: [
          ...(legacyCondition === undefined
            ? input.diagnosis.entries.map(entry => `Condition/${entry.conditionId}`)
            : []),
          `Provenance/${input.diagnosis.provenanceId}`,
        ],
      })
    }
    const prescription = input.medicationConclusion?.prescription
    if (prescription !== undefined) {
      events.push({
        kind: 'prescription-issued',
        occurredAt: prescription.authoredAt,
        reference: `Prescription/${prescription.id}`,
        relatedReferences: prescription.items.map(
          item => `MedicationRequest/${item.medicationRequestId}`,
        ),
      })
      if (prescription.withdrawal !== undefined) {
        events.push({
          kind: 'prescription-withdrawn',
          occurredAt: prescription.withdrawal.withdrawnAt,
          reference: `PrescriptionWithdrawal/${prescription.withdrawal.id}`,
          relatedReferences: [`Prescription/${prescription.id}`],
        })
      }
    }
    const noMedication = input.medicationConclusion?.noMedication
    if (noMedication !== undefined) {
      events.push({
        kind: 'no-medication-confirmed',
        occurredAt: noMedication.authoredAt,
        reference: `NoMedicationConclusion/${noMedication.id}`,
        relatedReferences: [],
      })
    }
    events.push({
      kind: 'encounter-completed',
      occurredAt: input.completedAt,
      reference: `Encounter/${input.encounterId}`,
      relatedReferences: [],
    })
    events.sort((left, right) => (
      left.occurredAt.localeCompare(right.occurredAt)
      || left.reference.localeCompare(right.reference)
      || left.kind.localeCompare(right.kind)
    ))
    return z.array(doctorCompletedCaseTimelineEventSchema).parse(events)
  }

  #completedCaseDraftDeletionEvents(context: ActorContext, caseId: string) {
    const rows = z.array(draftDeletionTraceRowSchema).parse(this.#database.driver.prepare(`
      SELECT trace_id, operation, effect_json, virtual_timestamp
      FROM action_trace
      WHERE workspace_id = ? AND epoch = ? AND scenario_run_id = ?
        AND outcome = 'success'
        AND operation IN (
          'encounter.delete-prescription-draft',
          'laboratory-request.delete-draft'
        )
      ORDER BY sequence
    `).all(
      context.workspaceId,
      context.epoch,
      context.scenarioRunId,
    ))
    return rows.flatMap(row => {
      const draftReference = row.operation === 'encounter.delete-prescription-draft'
        ? `PrescriptionDraft/${caseId}`
        : `LaboratoryRequestDraft/${caseId}`
      const effects = z.array(actionTraceEffectSchema).parse(
        JSON.parse(row.effect_json) as unknown,
      )
      if (!effects.some(effect => effect.reference === draftReference)) return []
      return [{
        kind: row.operation === 'encounter.delete-prescription-draft'
          ? 'prescription-draft-deleted' as const
          : 'laboratory-request-draft-deleted' as const,
        occurredAt: row.virtual_timestamp,
        reference: `ActionTrace/${row.trace_id}`,
        relatedReferences: [draftReference],
      }]
    })
  }

  #supportsLaboratoryReports(context: ActorContext): boolean {
    return this.#activeScenarioDataset(context) !== undefined || this.#database.driver.prepare(`
      SELECT 1 AS present FROM scenario_hidden_fact
      WHERE workspace_id = ? AND epoch = ? AND fact_code = 'laboratory-results'
    `).get(context.workspaceId, context.epoch) !== undefined
  }

  #activeScenarioDataset(context: ActorContext): ScenarioDatasetContent | undefined {
    const row = this.#database.driver.prepare(`
      SELECT package.content_json
      FROM scenario_run AS run
      JOIN scenario_package AS package
        ON package.workspace_id = run.workspace_id
       AND package.package_id = run.scenario_id
      WHERE run.workspace_id = ? AND run.epoch = ? AND run.scenario_run_id = ?
    `).get(context.workspaceId, context.epoch, context.scenarioRunId) as {
      content_json: string
    } | undefined
    return row === undefined
      ? undefined
      : scenarioDatasetContentSchema.parse(JSON.parse(row.content_json))
  }

  #legacyLaboratoryResultFact(
    context: ActorContext,
    catalogItemId: LaboratoryRequestCatalogItemId,
  ) {
    const hiddenFact = this.#database.driver.prepare(`
      SELECT value_json FROM scenario_hidden_fact
      WHERE workspace_id = ? AND epoch = ? AND fact_code = 'laboratory-results'
    `).get(context.workspaceId, context.epoch) as { value_json: string } | undefined
    if (hiddenFact === undefined) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory result fact is unavailable')
    }
    const facts = laboratoryResultsFactSchema.parse(JSON.parse(hiddenFact.value_json))
    if (catalogItemId === 'lab-cbc' || catalogItemId === 'lab-crp') return facts[catalogItemId]
    throw new WorkflowError('CATALOG_CONFLICT', 'The laboratory result fact is unavailable for this item')
  }

  #laboratoryReportVersions(
    context: ActorContext,
    requestId: string,
    diagnosticReportId: string,
    serviceRequestId: string,
  ) {
    const chain: Array<{
      diagnosticReportId: string
      revision?: z.infer<typeof laboratoryReportRevisionRowSchema>
    }> = []
    const seen = new Set<string>()
    let currentId: string | undefined = diagnosticReportId
    while (currentId !== undefined) {
      if (seen.has(currentId)) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory report revision chain is cyclic')
      }
      seen.add(currentId)
      const revision = laboratoryReportRevisionRowSchema.optional().parse(
        this.#database.driver.prepare(`
          SELECT diagnostic_report_id, provenance_id, reason, request_id,
            revision_of_diagnostic_report_id
          FROM laboratory_report_revision
          WHERE workspace_id = ? AND epoch = ? AND diagnostic_report_id = ?
        `).get(context.workspaceId, context.epoch, currentId),
      )
      if (revision !== undefined && revision.request_id !== requestId) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'The laboratory report revision does not belong to its request',
        )
      }
      chain.push({ diagnosticReportId: currentId, ...(revision === undefined ? {} : { revision }) })
      currentId = revision?.revision_of_diagnostic_report_id
    }
    return chain.reverse().map((entry, index) => this.#laboratoryReport(
      context,
      requestId,
      entry.diagnosticReportId,
      serviceRequestId,
      {
        revisionNumber: index + 1,
        ...(entry.revision === undefined ? {} : {
          revisionOfDiagnosticReportId: entry.revision.revision_of_diagnostic_report_id,
          revisionReason: entry.revision.reason,
        }),
      },
    ))
  }

  #laboratoryReport(
    context: ActorContext,
    requestId: string,
    diagnosticReportId: string,
    serviceRequestId: string,
    revision: {
      revisionNumber: number
      revisionOfDiagnosticReportId?: string
      revisionReason?: string
    } = { revisionNumber: 1 },
  ) {
    const reportResource = this.#fhir.read(context, 'DiagnosticReport', diagnosticReportId)
    const report = laboratoryDiagnosticReportContentSchema.parse(reportResource)
    const serviceRequestReference = `ServiceRequest/${serviceRequestId}`
    if (!report.basedOn.some(reference => reference.reference === serviceRequestReference)) {
      throw new WorkflowError(
        'WORKFLOW_CONFLICT',
        'The laboratory report does not reference its request',
      )
    }
    const specimenReference = report.specimen[0]?.reference
    if (specimenReference === undefined || !specimenReference.startsWith('Specimen/')) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory report specimen is invalid')
    }
    const specimenId = specimenReference.slice('Specimen/'.length)
    const acknowledgement = laboratoryReportAcknowledgementRowSchema.optional().parse(
      this.#database.driver.prepare(`
        SELECT acknowledgement_id, acknowledged_at, acknowledged_by,
          diagnostic_report_id, request_id, request_version
        FROM laboratory_report_acknowledgement
        WHERE workspace_id = ? AND epoch = ? AND diagnostic_report_id = ?
      `).get(context.workspaceId, context.epoch, diagnosticReportId),
    )
    if (acknowledgement !== undefined && acknowledgement.request_id !== requestId) {
      throw new WorkflowError(
        'WORKFLOW_CONFLICT',
        'The laboratory report acknowledgement does not belong to its request',
      )
    }
    return laboratoryReportSchema.parse({
      ...(acknowledgement === undefined ? {} : {
        acknowledgement: {
          acknowledgedAt: acknowledgement.acknowledged_at,
          acknowledgedBy: acknowledgement.acknowledged_by,
          id: acknowledgement.acknowledgement_id,
        },
      }),
      conclusion: report.conclusion,
      diagnosticReportId,
      diagnosticReportVersion: reportResource.meta?.versionId ?? '1',
      issuedAt: report.issued,
      ...revision,
      results: report.result.map((resultReference) => {
        if (!resultReference.reference.startsWith('Observation/')) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory report result is invalid')
        }
        const observationId = resultReference.reference.slice('Observation/'.length)
        const observation = laboratoryObservationContentSchema.parse(
          this.#fhir.read(context, 'Observation', observationId),
        )
        if (!observation.basedOn.some(reference => (
          reference.reference === serviceRequestReference
        )) || observation.specimen.reference !== specimenReference) {
          throw new WorkflowError(
            'WORKFLOW_CONFLICT',
            'The laboratory result does not reference its request and specimen',
          )
        }
        const coding = observation.code.coding[0]
        const interpretationCode = observation.interpretation[0]?.coding[0]?.code
        const referenceRange = observation.referenceRange[0]
        if (coding === undefined || interpretationCode === undefined || referenceRange === undefined) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'The laboratory result is incomplete')
        }
        const base = {
          code: coding.code,
          display: coding.display,
          interpretation: interpretationCode === 'N'
            ? 'normal' as const
            : interpretationCode === 'H' ? 'high' as const : 'low' as const,
          observationId,
        }
        if (observation.valueQuantity !== undefined) {
          if (referenceRange.high === undefined && referenceRange.low === undefined) {
            throw new WorkflowError('WORKFLOW_CONFLICT', 'The quantitative laboratory result is incomplete')
          }
          return {
            ...base,
            referenceRange: {
              ...(referenceRange.high === undefined ? {} : { high: referenceRange.high.value }),
              ...(referenceRange.low === undefined ? {} : { low: referenceRange.low.value }),
              text: referenceRange.text,
            },
            unit: {
              code: observation.valueQuantity.code,
              display: observation.valueQuantity.unit,
              system: observation.valueQuantity.system,
            },
            value: observation.valueQuantity.value,
          }
        }
        const qualitativeValue = observation.valueBoolean ?? observation.valueString
        if (qualitativeValue === undefined) {
          throw new WorkflowError('WORKFLOW_CONFLICT', 'The qualitative laboratory result is incomplete')
        }
        return {
          ...base,
          referenceRange: {
            text: referenceRange.text,
          },
          value: qualitativeValue,
        }
      }),
      specimenId,
      status: report.status,
    })
  }

  #laboratoryRequest(context: ActorContext, requestId: string) {
    return laboratoryRequestCommandRowSchema.optional().parse(
      this.#database.driver.prepare(`
        SELECT laboratory_request.request_id, laboratory_request.case_id,
          laboratory_request.catalog_item_id, laboratory_request.indication_code,
          laboratory_request.service_request_id, laboratory_request.execution_task_id,
          laboratory_request.diagnostic_report_id, laboratory_request.status,
          laboratory_request.version, laboratory_request.authored_by,
          outpatient_case.patient_id, outpatient_case.encounter_id
        FROM laboratory_request
        JOIN outpatient_case
          ON outpatient_case.workspace_id = laboratory_request.workspace_id
         AND outpatient_case.epoch = laboratory_request.epoch
         AND outpatient_case.case_id = laboratory_request.case_id
        WHERE laboratory_request.workspace_id = ? AND laboratory_request.epoch = ?
          AND laboratory_request.request_id = ?
      `).get(context.workspaceId, context.epoch, requestId),
    )
  }

  #consultationAnswer(
    context: ActorContext,
    question: z.infer<typeof consultationQuestionRuleRowSchema>,
  ): string {
    if (question.fact_code === null || question.revealed_answer_text === null) {
      return question.answer_text
    }
    const triggerCode = `consultation-question:${question.question_code}`
    const permitted = this.#database.driver.prepare(`
      SELECT 1 AS permitted
      FROM scenario_reveal_policy
      JOIN scenario_hidden_fact
        ON scenario_hidden_fact.workspace_id = scenario_reveal_policy.workspace_id
       AND scenario_hidden_fact.epoch = scenario_reveal_policy.epoch
       AND scenario_hidden_fact.fact_code = scenario_reveal_policy.fact_code
      WHERE scenario_reveal_policy.workspace_id = ?
        AND scenario_reveal_policy.epoch = ?
        AND scenario_reveal_policy.fact_code = ?
        AND scenario_reveal_policy.trigger_code = ?
      LIMIT 1
    `).get(context.workspaceId, context.epoch, question.fact_code, triggerCode)
    return permitted === undefined ? question.answer_text : question.revealed_answer_text
  }

  #catalogItem(context: ActorContext, itemId: string, kind: string): CatalogRow {
    const row = this.#database.driver.prepare(`
      SELECT code, item_id, name_zh, name_en, price_fen, version, config_json
      FROM outpatient_catalog
      WHERE workspace_id = ? AND epoch = ? AND item_id = ? AND kind = ? AND active = 1
    `).get(context.workspaceId, context.epoch, itemId, kind) as CatalogRow | undefined
    if (row === undefined) throw new WorkflowError('CATALOG_CONFLICT', 'The catalog item is unavailable')
    return row
  }

  #diagnosisCatalogItem(context: ActorContext, itemId: string) {
    const row = diagnosisCatalogRowSchema.optional().parse(
      this.#database.driver.prepare(`
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

  #assertNoIndependentDiagnosisOwner(context: ActorContext, caseId: string): void {
    const diagnosisState = this.#database.driver.prepare(`
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

  #assertNoIndependentPrescriptionOwner(context: ActorContext, caseId: string): void {
    const prescriptionState = this.#database.driver.prepare(`
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

  #assertNoLegacyDiagnosisOwner(context: ActorContext, caseId: string): void {
    const legacyDraft = this.#database.driver.prepare(`
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

  #assertNoLegacyPrescriptionOwner(context: ActorContext, caseId: string): void {
    const legacyDraft = this.#database.driver.prepare(`
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

  #diagnosisConfirmation(
    context: ActorContext,
    caseId: string,
  ): DiagnosisConfirmation | undefined {
    const confirmation = diagnosisConfirmationRowSchema.optional().parse(
      this.#database.driver.prepare(`
        SELECT confirmation_id, provenance_id, confirmed_at
        FROM diagnosis_confirmation
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(context.workspaceId, context.epoch, caseId),
    )
    if (confirmation === undefined) return undefined
    const entries = z.array(diagnosisEntryRowSchema).parse(
      this.#database.driver.prepare(`
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
      const resource = this.#fhir.read(context, 'Condition', entry.condition_id)
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
    }
  }

  #noMedicationConclusion(
    context: ActorContext,
    caseId: string,
  ): z.infer<typeof noMedicationConclusionSchema> | undefined {
    const conclusion = noMedicationConclusionRowSchema.optional().parse(
      this.#database.driver.prepare(`
        SELECT conclusion_id, version, authored_by_actor_id,
          authored_by_practitioner_role_id, authored_at
        FROM no_medication_conclusion
        WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      `).get(context.workspaceId, context.epoch, caseId),
    )
    if (conclusion === undefined) return undefined
    return noMedicationConclusionSchema.parse({
      authoredAt: conclusion.authored_at,
      authoredByActorId: conclusion.authored_by_actor_id,
      authoredByPractitionerRoleId: conclusion.authored_by_practitioner_role_id,
      id: conclusion.conclusion_id,
      version: conclusion.version,
    })
  }

  #prescriptionWithdrawal(
    context: ActorContext,
    prescriptionId: string,
  ): z.infer<typeof prescriptionWithdrawalSchema> | undefined {
    const withdrawal = prescriptionWithdrawalRowSchema.optional().parse(
      this.#database.driver.prepare(`
        SELECT withdrawal_id, version, withdrawn_by_actor_id,
          withdrawn_by_practitioner_role_id, withdrawn_at
        FROM prescription_withdrawal
        WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
      `).get(context.workspaceId, context.epoch, prescriptionId),
    )
    if (withdrawal === undefined) return undefined
    return prescriptionWithdrawalSchema.parse({
      id: withdrawal.withdrawal_id,
      prescriptionId,
      version: withdrawal.version,
      withdrawnAt: withdrawal.withdrawn_at,
      withdrawnByActorId: withdrawal.withdrawn_by_actor_id,
      withdrawnByPractitionerRoleId: withdrawal.withdrawn_by_practitioner_role_id,
    })
  }

  #prescriptionHasDispensedQuantity(context: ActorContext, prescriptionId: string): boolean {
    const row = countRowSchema.parse(this.#database.driver.prepare(`
      SELECT COUNT(*) AS count
      FROM prescription_item
      WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
        AND dispensed_quantity > 0
    `).get(context.workspaceId, context.epoch, prescriptionId))
    return row.count > 0
  }

  #prescriptionWithdrawalConflictStatus(
    context: ActorContext,
    prescriptionId: string,
  ): NonNullable<ApiConflict['currentStatus']> {
    const prescription = prescriptionWithdrawalLookupRowSchema.optional().parse(
      this.#database.driver.prepare(`
        SELECT prescription.case_id, prescription.version, prescription.status,
          withdrawal.withdrawal_id
        FROM prescription
        LEFT JOIN prescription_withdrawal AS withdrawal
          ON withdrawal.workspace_id = prescription.workspace_id
         AND withdrawal.epoch = prescription.epoch
         AND withdrawal.prescription_id = prescription.prescription_id
        WHERE prescription.workspace_id = ? AND prescription.epoch = ?
          AND prescription.prescription_id = ?
      `).get(context.workspaceId, context.epoch, prescriptionId),
    )
    if (prescription === undefined) return 'missing'
    if (prescription.withdrawal_id !== null) return 'withdrawn'
    if (this.#prescriptionHasDispensedQuantity(context, prescriptionId)) {
      return 'dispensing-started'
    }
    return prescription.status
  }

  #issuedPrescription(
    context: ActorContext,
    caseId: string,
  ): z.infer<typeof issuedPrescriptionSchema> | undefined {
    const prescription = issuedPrescriptionRowSchema.optional().parse(
      this.#database.driver.prepare(`
        SELECT prescription.prescription_id, prescription.prescription_number,
          prescription.status, prescription.version, prescription.authored_at,
          authorship.authored_by_practitioner_role_id
        FROM prescription
        LEFT JOIN prescription_authorship AS authorship
          ON authorship.workspace_id = prescription.workspace_id
         AND authorship.epoch = prescription.epoch
         AND authorship.prescription_id = prescription.prescription_id
        WHERE prescription.workspace_id = ? AND prescription.epoch = ?
          AND prescription.case_id = ? AND prescription.status != 'draft'
      `).get(context.workspaceId, context.epoch, caseId),
    )
    if (prescription === undefined) return undefined
    const withdrawal = this.#prescriptionWithdrawal(
      context,
      prescription.prescription_id,
    )
    let authoredByPractitionerRoleId = prescription.authored_by_practitioner_role_id ?? undefined
    const items = z.array(issuedPrescriptionItemRowSchema).parse(
      this.#database.driver.prepare(`
        SELECT medication_request_id, medication_id, quantity, dose_text,
          frequency_code, course_days
        FROM prescription_item
        WHERE workspace_id = ? AND epoch = ? AND prescription_id = ?
        ORDER BY medication_request_id
      `).all(
        context.workspaceId,
        context.epoch,
        prescription.prescription_id,
      ),
    ).map((item) => {
      const resource = this.#fhir.read(context, 'MedicationRequest', item.medication_request_id)
      const request = issuedMedicationRequestSchema.parse(resource)
      if (!request.requester.reference.startsWith('PractitionerRole/')) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription requester is inconsistent')
      }
      const requesterRoleId = request.requester.reference.slice('PractitionerRole/'.length)
      authoredByPractitionerRoleId ??= requesterRoleId
      if (requesterRoleId !== authoredByPractitionerRoleId) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription requester is inconsistent')
      }
      const catalog = z.object({
        name_en: z.string().min(1),
        name_zh: z.string().min(1),
      }).strict().optional().parse(this.#database.driver.prepare(`
        SELECT name_zh, name_en FROM outpatient_catalog
        WHERE workspace_id = ? AND epoch = ? AND item_id = ? AND kind = 'medication'
      `).get(context.workspaceId, context.epoch, item.medication_id))
      return {
        catalogItemId: item.medication_id,
        courseDays: item.course_days,
        display: request.medication.reference.display
          ?? catalog?.name_zh
          ?? catalog?.name_en
          ?? item.medication_id,
        doseText: item.dose_text,
        frequencyCode: item.frequency_code,
        medicationRequestId: item.medication_request_id,
        medicationRequestVersion: resource.meta?.versionId ?? '1',
        quantity: item.quantity,
      }
    })
    if (authoredByPractitionerRoleId === undefined) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The prescription requester is incomplete')
    }
    return issuedPrescriptionSchema.parse({
      authoredAt: prescription.authored_at,
      authoredByPractitionerRoleId,
      id: prescription.prescription_id,
      items,
      number: prescription.prescription_number,
      status: withdrawal === undefined ? prescription.status : 'withdrawn',
      version: prescription.version,
      ...(withdrawal === undefined ? {} : { withdrawal }),
    })
  }

  #patientAllergies(context: ActorContext, patientId: string): FhirResource[] {
    const parameters = new URLSearchParams({
      _count: '100',
      patient: `Patient/${patientId}`,
    })
    return this.#fhir.search(context, 'AllergyIntolerance', parameters).resources.filter(allergy => {
      const category = Array.isArray(allergy.category) ? allergy.category : []
      const clinicalStatus = allergyStatusCode(allergy.clinicalStatus)
      const verificationStatus = allergyStatusCode(allergy.verificationStatus)
      return category.includes('medication')
        && clinicalStatus === 'active'
        && verificationStatus === 'confirmed'
    })
  }

  #patientAllergyCodes(context: ActorContext, patientId: string): Set<string> {
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

  #validatedPrescriptionDraftMedications(
    context: ActorContext,
    items: PrescriptionDraftItem[],
  ): Array<PrescriptionDraftItem & { catalog: CatalogRow }> {
    const medications = items.map(item => ({
      ...item,
      catalog: this.#catalogItem(context, item.catalogItemId, 'medication'),
    }))
    this.#assertMedicationCatalogRules(medications.map(medication => ({
      catalogItemId: medication.catalogItemId,
      configJson: medication.catalog.config_json,
      doseText: medication.doseText,
      frequencyCode: medication.frequencyCode,
    })))
    for (const medication of medications) {
      const config = prescriptionMedicationCatalogConfigSchema.parse(
        JSON.parse(medication.catalog.config_json ?? '{}') as unknown,
      )
      if (
        !config.allowedCourseDays.includes(medication.courseDays)
        || !config.allowedQuantities.includes(medication.quantity)
      ) {
        throw new WorkflowError(
          'CATALOG_CONFLICT',
          `The course or quantity is not allowed for ${medication.catalogItemId}`,
        )
      }
    }
    return medications
  }

  #assertMedicationAllergies(
    context: ActorContext,
    patientId: string,
    medications: Array<{ code: string; name_en?: string; name_zh?: string }>,
  ): void {
    const allergyCodes = this.#patientAllergyCodes(context, patientId)
    const contraindicated = medications.find(medication => allergyCodes.has(medication.code))
    if (contraindicated !== undefined) {
      throw new WorkflowError(
        'WORKFLOW_CONFLICT',
        `Medication ${contraindicated.name_en ?? contraindicated.name_zh ?? contraindicated.code} conflicts with an active allergy`,
      )
    }
  }

  #assertMedicationCatalogRules(medications: MedicationRuleSelection[]): void {
    if (new Set(medications.map(medication => medication.catalogItemId)).size !== medications.length) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'A medication can appear only once in a prescription')
    }
    for (const medication of medications) {
      const config = legacyMedicationCatalogConfigSchema.parse(
        JSON.parse(medication.configJson ?? '{}') as unknown,
      )
      if (
        !config.allowedDoseTexts.includes(medication.doseText)
        || !config.allowedFrequencyCodes.includes(medication.frequencyCode)
      ) {
        throw new WorkflowError(
          'CATALOG_CONFLICT',
          `The dose or frequency is not allowed for ${medication.catalogItemId}`,
        )
      }
      const otherMedicationIds = medications
        .map(candidate => candidate.catalogItemId)
        .filter(candidateId => candidateId !== medication.catalogItemId)
      if (otherMedicationIds.some(candidateId => !config.allowedCombinationIds.includes(candidateId))) {
        throw new WorkflowError(
          'CATALOG_CONFLICT',
          `The medication combination is not allowed for ${medication.catalogItemId}`,
        )
      }
    }
  }

  #assertPrescriptionConclusionSupported(context: ActorContext): void {
    if (!this.#prescriptionConclusionSupportedInContext(context)) {
      throw new WorkflowError(
        'CATALOG_CONFLICT',
        'Independent medication conclusions are not supported by this Scenario',
      )
    }
  }

  #prescriptionConclusionSupportedInContext(context: ActorContext): boolean {
    const rows = z.array(medicationCatalogConfigRowSchema).parse(
      this.#database.driver.prepare(`
        SELECT config_json FROM outpatient_catalog
        WHERE workspace_id = ? AND epoch = ? AND kind = 'medication' AND active = 1
      `).all(context.workspaceId, context.epoch),
    )
    return this.#prescriptionConclusionSupported(
      rows.map(row => JSON.parse(row.config_json) as unknown),
    )
  }

  #prescriptionConclusionSupported(configs: unknown[]): boolean {
    return configs.length > 0
      && configs.every(config => prescriptionMedicationCatalogConfigSchema.safeParse(config).success)
  }

  #patientAllergyWarnings(context: ActorContext, patientId: string): Array<{ code: string; display: string }> {
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

  #virtualTime(context: ActorContext): string {
    const row = this.#database.driver.prepare(`
      SELECT virtual_time FROM scenario_epoch_state
      WHERE workspace_id = ? AND epoch = ? AND scenario_run_id = ?
    `).get(context.workspaceId, context.epoch, context.scenarioRunId) as { virtual_time: string } | undefined
    if (row === undefined) throw new WorkflowError('WORKFLOW_CONFLICT', 'The active virtual clock is unavailable')
    return row.virtual_time
  }

  #createVirtualPatientVersionToken(
    value: z.infer<typeof virtualPatientVersionPayloadSchema>,
  ): string {
    const payload = Buffer.from(JSON.stringify(virtualPatientVersionPayloadSchema.parse(value)))
    if (payload.byteLength > virtualPatientVersionPayloadBytes) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The Virtual Patient version is unavailable')
    }
    // Fixed-size ciphertext does not reveal whether the candidate already has an active case.
    const plaintext = Buffer.alloc(virtualPatientVersionPayloadBytes, 0x20)
    payload.copy(plaintext)
    const initializationVector = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.#virtualPatientVersionTokenKey, initializationVector)
    cipher.setAAD(virtualPatientVersionTokenAad)
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return [
      virtualPatientVersionTokenPrefix,
      initializationVector.toString('base64url'),
      ciphertext.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join('.')
  }

  #parseVirtualPatientVersionToken(
    context: ActorContext,
    virtualPatientId: string,
    token: string,
  ): z.infer<typeof virtualPatientVersionPayloadSchema> {
    try {
      const [prefix, encodedInitializationVector, encodedCiphertext, encodedAuthenticationTag, extra] = token.split('.')
      if (
        prefix !== virtualPatientVersionTokenPrefix
        || encodedInitializationVector === undefined
        || encodedCiphertext === undefined
        || encodedAuthenticationTag === undefined
        || extra !== undefined
      ) {
        throw new Error('Invalid token structure')
      }
      const initializationVector = Buffer.from(encodedInitializationVector, 'base64url')
      const ciphertext = Buffer.from(encodedCiphertext, 'base64url')
      const authenticationTag = Buffer.from(encodedAuthenticationTag, 'base64url')
      if (
        initializationVector.byteLength !== 12
        || ciphertext.byteLength !== virtualPatientVersionPayloadBytes
        || authenticationTag.byteLength !== 16
      ) {
        throw new Error('Invalid token length')
      }
      const decipher = createDecipheriv('aes-256-gcm', this.#virtualPatientVersionTokenKey, initializationVector)
      decipher.setAAD(virtualPatientVersionTokenAad)
      decipher.setAuthTag(authenticationTag)
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      const payload = virtualPatientVersionPayloadSchema.parse(JSON.parse(plaintext.toString().trimEnd()) as unknown)
      if (
        payload.workspaceId !== context.workspaceId
        || payload.epoch !== context.epoch
        || payload.virtualPatientId !== virtualPatientId
      ) {
        throw new Error('Token context does not match')
      }
      return payload
    } catch {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The Virtual Patient version has changed')
    }
  }

  #hashToken(value: string): string {
    return createHmac('sha256', this.#tokenSecret).update(value).digest('hex')
  }

  #actorContextHash(context: ActorContext): string {
    return this.#hashToken(JSON.stringify([
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
