import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import { fhirResourceSchema, type FhirResource } from '@clinmesh/contracts/fhir'
import {
  askConsultationQuestionResponseSchema,
  type ClinicalDocumentContent,
  clinicalDocumentContentSchema,
  clinicalDocumentDraftResponseSchema,
  clinicalDocumentSignPreviewResponseSchema,
  clinicalDocumentSignResponseSchema,
  clinicalPresentationSchema,
  clinicalDocumentRevisionResponseSchema,
  clinicalSignPreviewResponseSchema,
  clinicalSignResponseSchema,
  createPatientResponseSchema,
  dispenseResponseSchema,
  firstVisitDraftResponseSchema,
  laboratoryOrderResponseSchema,
  paymentPreviewResponseSchema,
  paymentResponseSchema,
  type PatientSummary,
  prescriptionReviewResponseSchema,
  registrationStatusSchema,
  registrationResponseSchema,
  revisitDraftResponseSchema,
  startVirtualPatientResponseSchema,
  startVisitResponseSchema,
  triageResponseSchema,
  virtualPatientListSchema,
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

export class WorkflowError extends Error {
  readonly code: 'CATALOG_CONFLICT' | 'DUPLICATE_PATIENT' | 'ROLE_NOT_ALLOWED' | 'WORKFLOW_CONFLICT'
  readonly status: 403 | 409

  constructor(
    code: 'CATALOG_CONFLICT' | 'DUPLICATE_PATIENT' | 'ROLE_NOT_ALLOWED' | 'WORKFLOW_CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'WorkflowError'
    this.code = code
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

interface MedicationRuleSelection {
  catalogItemId: string
  configJson: string | undefined
  doseText: string
  frequencyCode: string
}

const medicationCatalogConfigSchema = z.object({
  allowedCombinationIds: z.array(z.string().min(1)),
  allowedDoseTexts: z.array(z.string().min(1)).min(1),
  allowedFrequencyCodes: z.array(z.string().min(1)).min(1),
  dose: z.string().min(1),
  frequency: z.string().min(1),
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
  return {
    ...(typeof resource.birthDate === 'string' ? { birthDate: resource.birthDate } : {}),
    ...(typeof resource.gender === 'string' ? { gender: resource.gender } : {}),
    id: resource.id,
    identifier: typeof identifier === 'string' ? identifier : '',
    name: typeof name === 'string' ? name : '',
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
  { code: 'physical-examination', field: 'physicalExamination', title: '查体' },
  { code: 'assessment', field: 'assessment', title: '评估' },
  { code: 'disposition', field: 'disposition', title: '处置' },
  { code: 'follow-up', field: 'followUp', title: '随访' },
] as const

function structuredClinicalDocumentSections(document: ClinicalDocumentContent) {
  return clinicalDocumentSections.map(section => ({
    code: {
      coding: [{
        code: section.code,
        display: section.title,
        system: clinicalDocumentSectionSystem,
      }],
      text: section.title,
    },
    text: {
      div: `<div xmlns="http://www.w3.org/1999/xhtml">${xhtmlText(document[section.field])}</div>`,
      status: 'generated',
    },
    title: section.title,
  }))
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
    text: z.object({ div: z.string() }).loose(),
  }).loose()),
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
  const content = Object.fromEntries(clinicalDocumentSections.map(section => [
    section.field,
    sections.get(section.code),
  ]))
  const parsed = clinicalDocumentContentSchema.safeParse(content)
  return parsed.success ? parsed.data : undefined
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
    return {
      laboratory: rows.filter(row => row.kind === 'laboratory').map(row => {
        const config = laboratoryCatalogConfigSchema.parse(JSON.parse(row.config_json) as unknown)
        return { ...summary(row), ...config }
      }),
      medications: rows.filter(row => row.kind === 'medication').map(row => {
        const config = medicationCatalogConfigSchema.parse(JSON.parse(row.config_json) as unknown)
        return {
          ...summary(row),
          allowedCombinationIds: config.allowedCombinationIds,
          allowedDoseTexts: config.allowedDoseTexts,
          allowedFrequencyCodes: config.allowedFrequencyCodes,
          defaultDoseText: config.dose,
          defaultFrequencyCode: config.frequency,
        }
      }),
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
      WHERE workspace_id = ? AND epoch = ? AND status IN (${placeholders})
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
          owner: { reference: 'PractitionerRole/practitioner-role-outpatient-doctor' },
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
      encounter: {
        id: encounter.id,
        status: encounter.status,
        versionId: encounter.meta?.versionId,
      },
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
      context: input.context,
      dataSchema: clinicalDocumentRevisionResponseSchema.shape.data,
      expectedVersions: input.expectedVersions,
      idempotencyKey: input.idempotencyKey,
      input: {
        compositionId: input.compositionId,
        reason: input.reason,
        ...revision.payload,
      },
      operation: 'clinical-document.revise',
    }, transaction => {
      this.#assertRole(input.context, ['outpatient-doctor'])
      const source = this.#database.driver.prepare(`
        SELECT document.document_id, document.bundle_id, outpatient_case.patient_id,
          outpatient_case.encounter_id
        FROM signed_clinical_document AS document
        JOIN outpatient_case
          ON outpatient_case.workspace_id = document.workspace_id
         AND outpatient_case.epoch = document.epoch
         AND outpatient_case.case_id = document.case_id
        WHERE document.workspace_id = ? AND document.epoch = ?
          AND document.composition_id = ?
      `).get(
        input.context.workspaceId,
        input.context.epoch,
        input.compositionId,
      ) as {
        bundle_id: string
        document_id: string
        encounter_id: string
        patient_id: string
      } | undefined
      if (source === undefined) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The signed clinical document was not found')
      }
      const successor = this.#database.driver.prepare(`
        SELECT document_id FROM signed_clinical_document
        WHERE workspace_id = ? AND epoch = ? AND revision_of_document_id = ?
      `).get(
        input.context.workspaceId,
        input.context.epoch,
        source.document_id,
      ) as { document_id: string } | undefined
      if (successor !== undefined) {
        throw new WorkflowError(
          'WORKFLOW_CONFLICT',
          'Only the latest Clinical Document version can be revised',
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
    const total = this.#database.driver.prepare(`
      SELECT COUNT(*) AS count FROM charge_record
      WHERE workspace_id = ? AND epoch = ? AND category = ?
        AND status IN (${placeholders})
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
      const prescription = this.#database.driver.prepare(`
        SELECT prescription.version, prescription.status,
          outpatient_case.encounter_id, outpatient_case.status AS case_status
        FROM prescription
        JOIN outpatient_case
          ON outpatient_case.workspace_id = prescription.workspace_id
         AND outpatient_case.epoch = prescription.epoch
         AND outpatient_case.case_id = prescription.case_id
        WHERE prescription.workspace_id = ? AND prescription.epoch = ?
          AND prescription.prescription_id = ?
      `).get(input.context.workspaceId, input.context.epoch, input.prescriptionId) as {
        case_status: string
        encounter_id: string
        status: string
        version: number
      } | undefined
      if (
        prescription === undefined
        || prescription.status !== 'paid'
        || prescription.case_status !== 'awaiting-dispense'
        || prescription.version !== input.expectedPrescriptionVersion
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
      const prescription = this.#database.driver.prepare(`
        SELECT prescription.prescription_id, prescription.prescription_number,
          prescription.version, prescription.status,
          outpatient_case.case_id, outpatient_case.patient_id,
          outpatient_case.encounter_id, outpatient_case.status AS case_status,
          outpatient_case.scenario_run_id,
          review.review_id
        FROM prescription
        JOIN outpatient_case
          ON outpatient_case.workspace_id = prescription.workspace_id
         AND outpatient_case.epoch = prescription.epoch
         AND outpatient_case.case_id = prescription.case_id
        LEFT JOIN prescription_review AS review
          ON review.workspace_id = prescription.workspace_id
         AND review.epoch = prescription.epoch
         AND review.prescription_id = prescription.prescription_id
        WHERE prescription.workspace_id = ? AND prescription.epoch = ?
          AND prescription.prescription_id = ?
      `).get(input.context.workspaceId, input.context.epoch, input.prescriptionId) as {
        case_id: string
        case_status: string
        encounter_id: string
        patient_id: string
        prescription_id: string
        prescription_number: string
        review_id: string | null
        scenario_run_id: string
        status: string
        version: number
      } | undefined
      if (
        prescription === undefined
        || prescription.status !== 'paid'
        || prescription.review_id === null
        || prescription.case_status !== 'awaiting-dispense'
        || prescription.version !== input.expectedPrescriptionVersion
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
      const charge = this.#database.driver.prepare(`
        SELECT charge.charge_id, charge.charge_item_id, charge.total_fen,
          charge.version, charge.status, outpatient_case.status AS case_status,
          prescription.status AS prescription_status
        FROM charge_record AS charge
        JOIN outpatient_case
          ON outpatient_case.workspace_id = charge.workspace_id
         AND outpatient_case.epoch = charge.epoch
         AND outpatient_case.case_id = charge.case_id
        LEFT JOIN prescription
          ON prescription.workspace_id = outpatient_case.workspace_id
         AND prescription.epoch = outpatient_case.epoch
         AND prescription.prescription_id = outpatient_case.prescription_id
        WHERE charge.workspace_id = ? AND charge.epoch = ?
          AND charge.case_id = ? AND charge.category = ?
      `).get(input.context.workspaceId, input.context.epoch, input.caseId, input.category) as {
        case_status: string
        charge_id: string
        charge_item_id: string
        prescription_status: string | null
        status: string
        total_fen: number
        version: number
      } | undefined
      if (charge === undefined || !['billable', 'declined'].includes(charge.status)) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The charge is not available for payment')
      }
      this.#assertExpectedVersions(input.expectedVersions, [`ChargeItem/${charge.charge_item_id}`])
      if (
        (input.category === 'laboratory' && charge.case_status !== 'awaiting-lab-payment')
        || (input.category === 'medication'
          && (charge.case_status !== 'awaiting-medication-payment' || charge.prescription_status !== 'signed'))
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
      const preview = this.#database.driver.prepare(`
        SELECT preview.*, charge.charge_id, charge.charge_item_id,
          charge.status AS charge_status, charge.version AS charge_version,
          charge.total_fen AS current_amount_fen,
          outpatient_case.patient_id, outpatient_case.encounter_id,
          outpatient_case.account_id, outpatient_case.service_request_id,
          outpatient_case.prescription_id, outpatient_case.status AS case_status,
          prescription.status AS prescription_status
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
        WHERE preview.workspace_id = ? AND preview.epoch = ? AND preview.preview_id = ?
      `).get(input.context.workspaceId, input.context.epoch, input.previewId) as {
        account_id: string
        amount_fen: number
        case_id: string
        case_status: string
        category: 'laboratory' | 'medication'
        charge_id: string
        charge_item_id: string
        charge_status: string
        charge_version: number
        consumed_at: string | null
        current_amount_fen: number
        encounter_id: string
        expected_charge_version: number
        expires_at: string
        patient_id: string
        prescription_id: string | null
        prescription_status: string | null
        service_request_id: string | null
        simulator_rule: string
        token_hash: string
      } | undefined
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
            || preview.prescription_status !== 'signed'))
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
    const rows = this.#database.driver.prepare(`
      SELECT document_id, composition_id, bundle_id, provenance_id,
        revision_of_document_id, signed_at
      FROM signed_clinical_document
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      ORDER BY signed_at, document_id
    `).all(context.workspaceId, context.epoch, caseId) as Array<{
      bundle_id: string
      composition_id: string
      document_id: string
      provenance_id: string
      revision_of_document_id: string | null
      signed_at: string
    }>
    const documentsById = new Map<string, { compositionId: string; revisionNumber: number }>()
    return rows.flatMap(row => {
      const composition = this.#fhir.read(context, 'Composition', row.composition_id)
      const content = structuredClinicalDocumentFromComposition(composition)
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
      const config = medicationCatalogConfigSchema.parse(
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
