import {
  clinicalFactCategorySchema,
  clinicalFactLedgerFilterQuerySchema,
  clinicalFactVerificationDecisionSchema,
  clinicalFactVerificationResponseSchema,
  DEFAULT_CLINICAL_FACT_HOSPITAL_ID,
  type ClinicalFactCategory,
  type ClinicalFactLedger,
  type ClinicalFactSubjectKind,
  type ClinicalFactVerificationRecord,
  type ClinicalFactVerificationResponse,
  type RecordClinicalFactVerificationBody,
} from '@clinmesh/contracts/clinical-fact-ledger'
import { bedsideQuestionnaireValueInputSchema, clinicalRiskAssessmentValuesSchema } from '@clinmesh/contracts/clinical-scores'
import { visibleSourceClinicalSchema } from '@clinmesh/contracts/agent'
import { fhirResourceSchema } from '@clinmesh/contracts/fhir'
import {
  evaluateClinicalFactLedger,
  LEGACY_BEDSIDE_QUESTIONNAIRE_FIELDS,
  normalizeBedsideItemCode,
  synthesizeUnaskedQuestionnaireCandidates,
  transcribeBedsideQuestionnaireFacts,
  transcribeLocalFhirFacts,
  transcribeVisibleSourceHistoryFacts,
  type ActivePackPromptItemInput,
  type BedsideQuestionnaireExtraAnswerInput,
  type FhirAllergyIntoleranceLike,
  type FhirConditionLike,
  type FhirDiagnosticReportLike,
  type FhirMedicationLike,
  type FhirObservationLike,
  type FhirProcedureLike,
  type TranscribedClinicalFactCandidate,
} from '@clinmesh/core/clinical-fact-ledger'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { FhirRepository, RepositoryContext } from '../infrastructure/sqlite/fhir-repository.ts'
import type { ActorContext, CommandExecutor, CommandTransaction } from './command-executor.ts'
import type { InpatientService } from './inpatient-service.ts'
import { outpatientCaseSource } from './outpatient-case-source.ts'
import type { OutpatientWorkflowContext } from './outpatient-workflow-context.ts'

export class ClinicalFactLedgerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409,
    readonly reason?: string,
  ) {
    super(message)
    this.name = 'ClinicalFactLedgerError'
  }
}

const eligibleIngestedRecordRowSchema = z.object({
  ingestion_record_id: z.string(),
  source_system_id: z.string(),
  fhir_observation_json: z.string(),
  provenance_json: z.string(),
  ingested_at: z.string(),
}).strict()

const ingestedFhirObservationSchema = z.object({
  resourceType: z.literal('Observation'),
  id: z.string(),
  status: z.string(),
}).loose()

const ingestedProvenancePayloadSchema = z.object({
  resourceType: z.literal('Provenance'),
  id: z.string().min(1),
  target: z.array(z.object({ reference: z.string().min(1) }).strict()).min(1),
  recorded: z.string().min(1),
  sourceSystemId: z.string().min(1),
  hospitalId: z.string().min(1),
  batchId: z.string().min(1),
  ingestedAt: z.string().min(1),
  mappingVersion: z.string().min(1),
  orderedAt: z.string().nullable(),
  externalReportId: z.string().min(1),
  specimenBarcode: z.string().nullable(),
  adapterFormat: z.enum(['clinmesh-sim-lis-v2', 'clinmesh-his-fhir-v1']),
  meta: z.object({
    versionId: z.string().min(1),
    lastUpdated: z.string().min(1),
  }).strict(),
}).strict()

export interface ClinicalFactLedgerQueryOptions {
  asOf?: string | undefined
  itemCodes?: readonly string[] | undefined
  categories?: readonly ClinicalFactCategory[] | undefined
  includeSuperseded?: boolean | undefined
}

export type ActivePackPromptsResolver = (
  context: ActorContext,
  subject: { kind: ClinicalFactSubjectKind; id: string; patientId: string },
  baseLedger: ClinicalFactLedger,
  asOf: string,
) => ActivePackPromptItemInput[]

export interface ClinicalFactLedgerServiceOptions {
  activePromptsResolver?: ActivePackPromptsResolver
  commands: CommandExecutor
  database: ClinMeshDatabase
  fhir: FhirRepository
  outpatientContext: OutpatientWorkflowContext
}

const patientSexSchema = z.enum(['male', 'female', 'other', 'unknown'])

function parseCommaList(raw: string | readonly string[] | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  const entries = (Array.isArray(raw) ? raw : [raw])
    .flatMap(chunk => chunk.split(','))
    .map(token => token.trim())
    .filter(token => token.length > 0)
  return entries.length > 0 ? entries : undefined
}

export function parseClinicalFactLedgerFilterParams(raw: {
  asOf?: string | undefined
  itemCodes?: string | readonly string[] | undefined
  categories?: string | readonly string[] | undefined
  includeSuperseded?: boolean | string | undefined
}): ClinicalFactLedgerQueryOptions {
  let includeSuperseded: boolean | undefined
  if (typeof raw.includeSuperseded === 'boolean') {
    includeSuperseded = raw.includeSuperseded
  } else if (typeof raw.includeSuperseded === 'string') {
    const normalized = raw.includeSuperseded.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1') includeSuperseded = true
    else if (normalized === 'false' || normalized === '0') includeSuperseded = false
    else throw new ClinicalFactLedgerError('INVALID_INPUT', 'Invalid includeSuperseded boolean value', 400)
  }

  const itemCodes = parseCommaList(raw.itemCodes)
  const rawCategories = parseCommaList(raw.categories)
  const categories = rawCategories ? z.array(clinicalFactCategorySchema).parse(rawCategories) : undefined

  const checkedFilter = clinicalFactLedgerFilterQuerySchema.parse({
    ...(raw.asOf !== undefined ? { asOf: raw.asOf } : {}),
    ...(itemCodes ? { itemCodes: itemCodes.join(',') } : {}),
    ...(categories ? { categories: categories.join(',') } : {}),
    ...(includeSuperseded !== undefined ? { includeSuperseded } : {}),
  })

  return {
    ...(checkedFilter.asOf !== undefined ? { asOf: checkedFilter.asOf } : {}),
    ...(itemCodes !== undefined ? { itemCodes } : {}),
    ...(categories !== undefined ? { categories } : {}),
    ...(includeSuperseded !== undefined ? { includeSuperseded } : {}),
  }
}

export function buildFactQueryFromHttp(queries: {
  single: Record<string, string | undefined>
  multi: (key: string) => string[] | undefined
}): ClinicalFactLedgerQueryOptions {
  const allowed = new Set(['asOf', 'itemCodes', 'categories', 'includeSuperseded'])
  for (const key of Object.keys(queries.single)) {
    if (!allowed.has(key)) {
      throw new ClinicalFactLedgerError('INVALID_INPUT', `Unsupported query parameter: ${key}`, 400)
    }
  }
  return parseClinicalFactLedgerFilterParams({
    ...(queries.single['asOf'] !== undefined ? { asOf: queries.single['asOf'] } : {}),
    ...(queries.multi('itemCodes')?.length ? { itemCodes: queries.multi('itemCodes') } : {}),
    ...(queries.multi('categories')?.length ? { categories: queries.multi('categories') } : {}),
    ...(queries.single['includeSuperseded'] !== undefined ? { includeSuperseded: queries.single['includeSuperseded'] } : {}),
  })
}

const verificationRowSchema = z.object({
  verification_id: z.string().min(1),
  subject_kind: z.enum(['outpatient', 'inpatient']),
  subject_id: z.string().min(1),
  patient_id: z.string().min(1),
  fact_id: z.string().min(1),
  item_code: z.string().min(1),
  source_reference: z.string().min(1),
  source_version: z.string().min(1),
  decision: clinicalFactVerificationDecisionSchema,
  note: z.string().nullable(),
  actor_id: z.string().min(1),
  practitioner_id: z.string().nullable(),
  practitioner_role_id: z.string().nullable(),
  verified_at: z.string().min(1),
}).strict()

const fhirHistoryContentRowSchema = z.object({
  resource_id: z.string().min(1),
  version_id: z.number().int().positive(),
  last_updated: z.string().min(1),
  content_json: z.string().min(1),
}).strict()

export class ClinicalFactLedgerService {
  #activePromptsResolver: ActivePackPromptsResolver | undefined
  readonly #commands: CommandExecutor
  readonly #database: ClinMeshDatabase
  readonly #fhir: FhirRepository
  readonly #outpatient: OutpatientWorkflowContext

  constructor(options: ClinicalFactLedgerServiceOptions) {
    this.#activePromptsResolver = options.activePromptsResolver
    this.#commands = options.commands
    this.#database = options.database
    this.#fhir = options.fhir
    this.#outpatient = options.outpatientContext
  }

  setActivePromptsResolver(resolver: ActivePackPromptsResolver): void {
    this.#activePromptsResolver = resolver
  }

  readOutpatientLedger(
    context: ActorContext,
    caseId: string,
    options?: ClinicalFactLedgerQueryOptions,
  ): ClinicalFactLedger {
    const auditInput = { caseId, ...options }
    try {
      this.#outpatient.requireDoctorCase(context, caseId)
      this.#outpatient.assertCaseResponsibility(context, caseId)
      const caseRow = z.object({ patient_id: z.string().min(1) }).optional().parse(
        this.#database.driver.prepare(`
          SELECT patient_id FROM outpatient_case
          WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        `).get(context.workspaceId, context.epoch, caseId),
      )
      if (!caseRow) {
        throw new ClinicalFactLedgerError('OUTPATIENT_CASE_NOT_FOUND', `Outpatient case ${caseId} was not found`, 404)
      }
      const asOf = options?.asOf ?? this.#outpatient.virtualTime(context)
      const ledger = this.buildInternalLedger(
        context,
        { kind: 'outpatient', id: caseId, patientId: caseRow.patient_id },
        { ...options, asOf },
      )
      this.#commands.auditRead(context, 'doctor.case.clinical-fact-ledger.read', auditInput, 'success')
      return ledger
    } catch (error) {
      try {
        this.#commands.auditRead(context, 'doctor.case.clinical-fact-ledger.read', auditInput, 'failed')
      } catch {
        /* preserve original error */
      }
      throw error
    }
  }

  readInpatientLedger(
    inpatient: InpatientService,
    context: ActorContext,
    admissionId: string,
    options?: ClinicalFactLedgerQueryOptions,
  ): ClinicalFactLedger {
    const auditInput = { admissionId, ...options }
    try {
      inpatient.assertRole(context, ['inpatient-doctor'])
      const binding = inpatient.admissionBinding(context, admissionId)
      const asOf = options?.asOf ?? inpatient.virtualTime(context)
      const ledger = this.buildInternalLedger(
        context,
        { kind: 'inpatient', id: admissionId, patientId: binding.patientId },
        { ...options, asOf },
      )
      inpatient.commands.auditRead(context, 'inpatient.clinical-fact-ledger.read', auditInput, 'success')
      return ledger
    } catch (error) {
      try {
        inpatient.commands.auditRead(context, 'inpatient.clinical-fact-ledger.read', auditInput, 'failed')
      } catch {
        /* preserve original error */
      }
      throw error
    }
  }

  recordOutpatientVerification(input: {
    context: ActorContext
    caseId: string
    body: RecordClinicalFactVerificationBody
    idempotencyKey: string
  }): ClinicalFactVerificationResponse {
    return this.#commands.execute({
      authorize: () => {
        this.#outpatient.requireDoctorCase(input.context, input.caseId)
        this.#outpatient.assertCaseResponsibility(input.context, input.caseId)
      },
      context: input.context,
      dataSchema: clinicalFactVerificationResponseSchema.shape.data,
      expectedVersions: {},
      idempotencyKey: input.idempotencyKey,
      input: { caseId: input.caseId, ...input.body },
      operation: 'doctor.case.clinical-fact-verification.record',
    }, transaction => {
      const caseRow = z.object({ patient_id: z.string().min(1) }).optional().parse(
        this.#database.driver.prepare(`
          SELECT patient_id FROM outpatient_case
          WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        `).get(input.context.workspaceId, input.context.epoch, input.caseId),
      )
      if (!caseRow) {
        throw new ClinicalFactLedgerError('OUTPATIENT_CASE_NOT_FOUND', `Outpatient case ${input.caseId} was not found`, 404)
      }
      const now = this.#outpatient.virtualTime(input.context)
      return this.#persistVerification(
        transaction,
        input.context,
        { kind: 'outpatient', id: input.caseId, patientId: caseRow.patient_id },
        input.body,
        now,
      )
    })
  }

  recordInpatientVerification(
    inpatient: InpatientService,
    input: {
      context: ActorContext
      admissionId: string
      body: RecordClinicalFactVerificationBody
      idempotencyKey: string
    },
  ): ClinicalFactVerificationResponse {
    return inpatient.commands.execute({
      authorize: () => {
        inpatient.assertRole(input.context, ['inpatient-doctor'])
        inpatient.admissionBinding(input.context, input.admissionId)
      },
      context: input.context,
      dataSchema: clinicalFactVerificationResponseSchema.shape.data,
      expectedVersions: {},
      idempotencyKey: input.idempotencyKey,
      input: { admissionId: input.admissionId, ...input.body },
      operation: 'inpatient.clinical-fact-verification.record',
    }, transaction => {
      const binding = inpatient.admissionBinding(input.context, input.admissionId)
      const now = inpatient.virtualTime(input.context)
      return this.#persistVerification(
        transaction,
        input.context,
        { kind: 'inpatient', id: input.admissionId, patientId: binding.patientId },
        input.body,
        now,
      )
    })
  }

  #persistVerification(
    transaction: CommandTransaction,
    context: ActorContext,
    subject: { kind: ClinicalFactSubjectKind; id: string; patientId: string },
    body: RecordClinicalFactVerificationBody,
    now: string,
  ) {
    const preLedger = this.buildInternalLedger(context, subject, {
      asOf: now,
      includeSuperseded: false,
    })
    const targetFact = preLedger.facts.find(f => f.factId === body.factId)
    if (!targetFact) {
      throw new ClinicalFactLedgerError(
        'CLINICAL_FACT_NOT_FOUND',
        `Active clinical fact ${body.factId} was not found for patient ${subject.patientId}`,
        404,
      )
    }
    if (
      body.expectedSourceVersion !== undefined
      && body.expectedSourceVersion !== targetFact.provenance.recordVersion
    ) {
      throw new ClinicalFactLedgerError(
        'CLINICAL_FACT_VERSION_CONFLICT',
        `Clinical fact ${body.factId} expected source version ${body.expectedSourceVersion}, actual ${targetFact.provenance.recordVersion}`,
        409,
      )
    }

    const verificationId = uuidv7()
    const decision = body.decision ?? 'verified'
    const sourceReference = targetFact.provenance.recordId.includes('/')
      ? targetFact.provenance.recordId
      : `${targetFact.provenance.recordType}/${targetFact.provenance.recordId}`

    this.#database.driver.prepare(`
      INSERT INTO clinical_fact_verification (
        workspace_id, epoch, verification_id, subject_kind, subject_id, patient_id,
        fact_id, item_code, source_reference, source_version, decision, note,
        actor_id, practitioner_id, practitioner_role_id, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      context.workspaceId,
      context.epoch,
      verificationId,
      subject.kind,
      subject.id,
      subject.patientId,
      targetFact.factId,
      targetFact.itemCode.code,
      sourceReference,
      targetFact.provenance.recordVersion,
      decision,
      body.note ?? null,
      context.actorId,
      context.practitionerId ?? null,
      context.practitionerRoleId ?? null,
      now,
    )

    // Maintain transaction command audit effect contract without duplicating state
    void transaction

    const refreshedLedger = this.buildInternalLedger(context, subject, {
      asOf: now,
      includeSuperseded: false,
    })
    const refreshedFact = refreshedLedger.facts.find(f => f.factId === targetFact.factId) ?? targetFact

    const verification: ClinicalFactVerificationRecord = {
      verificationId,
      subjectKind: subject.kind,
      subjectId: subject.id,
      patientId: subject.patientId,
      factId: targetFact.factId,
      itemCode: targetFact.itemCode.code,
      sourceReference,
      sourceVersion: targetFact.provenance.recordVersion,
      decision,
      note: body.note ?? null,
      verifiedAt: now,
      verifiedByActorId: context.actorId,
      verifiedByPractitionerId: context.practitionerId ?? null,
      verifiedByPractitionerRoleId: context.practitionerRoleId ?? null,
    }

    return {
      data: {
        verification,
        fact: refreshedFact,
      },
      effects: [
        {
          kind: 'created' as const,
          reference: `ClinicalFactVerification/${verificationId}`,
          versionId: '1',
        },
      ],
      warnings: [],
    }
  }

  buildInternalLedger(
    context: ActorContext,
    subject: { kind: ClinicalFactSubjectKind; id: string; patientId: string },
    options?: ClinicalFactLedgerQueryOptions & { asOf: string },
  ): ClinicalFactLedger {
    const asOf = options?.asOf ?? new Date().toISOString()
    const patientResource = this.#safeReadPatient(context, subject.patientId)
    const rawGender = typeof patientResource?.['gender'] === 'string' ? patientResource['gender'] : undefined
    const parsedGender = patientSexSchema.safeParse(rawGender)
    const patientSex = parsedGender.success ? parsedGender.data : null

    const localCandidates = this.#loadLocalFhirCandidates(context, subject.patientId)
    const orderedCandidates = this.#loadOrderedWorkupAndProcedureCandidates(context, subject.patientId, asOf)
    const encounterContextCandidates = this.#loadDischargeAndEncounterContextCandidates(context, subject, asOf)
    const visibleCandidates = this.#loadVisibleHistoryCandidates(context, subject)
    const bedsideCandidates = this.#loadBedsideQuestionnaireCandidates(context, subject.patientId)
    const verifications = this.#loadClinicianVerifications(context, subject.patientId)

    const baseCandidates = [
      ...localCandidates,
      ...orderedCandidates,
      ...encounterContextCandidates,
      ...visibleCandidates,
      ...bedsideCandidates,
    ]
    const evaluationUnfiltered = {
      hospitalId: DEFAULT_CLINICAL_FACT_HOSPITAL_ID,
      patientId: subject.patientId,
      patientSex,
      subjectKind: subject.kind,
      subjectId: subject.id,
      evaluatedAsOf: asOf,
      includeSuperseded: options?.includeSuperseded ?? false,
      candidates: baseCandidates,
      verifications,
    }
    const filterProps = {
      ...(options?.itemCodes ? { filterItemCodes: options.itemCodes } : {}),
      ...(options?.categories ? { filterCategories: options.categories } : {}),
    }

    if (this.#activePromptsResolver === undefined) {
      return evaluateClinicalFactLedger({ ...evaluationUnfiltered, ...filterProps })
    }

    const baseLedger = evaluateClinicalFactLedger(evaluationUnfiltered)
    const promptItems = this.#activePromptsResolver(context as ActorContext, subject, baseLedger, asOf)
    if (promptItems.length === 0) {
      return evaluateClinicalFactLedger({ ...evaluationUnfiltered, ...filterProps })
    }

    const recordedCodes = new Set(
      bedsideCandidates
        .filter(c => c.category === 'bedside-questionnaire' && c.presence !== 'not-asked')
        .map(c => normalizeBedsideItemCode(c.itemCode.code)),
    )
    const unaskedCandidates = synthesizeUnaskedQuestionnaireCandidates({
      evaluatedAt: asOf,
      items: promptItems,
      recordedCodes,
      subjectId: subject.id,
      subjectKind: subject.kind,
    })
    if (unaskedCandidates.length === 0) {
      return evaluateClinicalFactLedger({ ...evaluationUnfiltered, ...filterProps })
    }

    return evaluateClinicalFactLedger({
      ...evaluationUnfiltered,
      ...filterProps,
      candidates: [...baseCandidates, ...unaskedCandidates],
    })
  }

  #safeReadPatient(context: RepositoryContext, patientId: string): Record<string, unknown> | null {
    try {
      return this.#fhir.read(context, 'Patient', patientId) as Record<string, unknown>
    } catch {
      return null
    }
  }

  #searchAllFhirIdsForPatient(
    context: RepositoryContext,
    resourceType: Parameters<FhirRepository['search']>[1],
    patientId: string,
  ): Array<{ id: string; resource: Record<string, unknown> }> {
    const results: Array<{ id: string; resource: Record<string, unknown> }> = []
    let cursor: string | undefined
    for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
      const params = new URLSearchParams({ _count: '100', patient: `Patient/${patientId}` })
      if (cursor) params.set('_cursor', cursor)
      const bundle = this.#fhir.search(context, resourceType, params)
      for (const res of bundle.resources) {
        const record = res as Record<string, unknown>
        if (typeof record['id'] === 'string') {
          results.push({ id: record['id'], resource: record })
        }
      }
      const nextCursor = bundle.nextCursor
      if (!nextCursor || nextCursor === cursor) break
      cursor = nextCursor
    }
    return results
  }

  #loadFhirHistoryForPatient(
    context: RepositoryContext,
    resourceType: Parameters<FhirRepository['search']>[1],
    patientId: string,
  ): Record<string, unknown>[] {
    const currentEntries = this.#searchAllFhirIdsForPatient(context, resourceType, patientId)
    if (currentEntries.length === 0) return []

    const selectHistory = this.#database.driver.prepare(`
      SELECT resource_id, version_id, last_updated, content_json
      FROM fhir_history
      WHERE workspace_id = ? AND epoch = ? AND resource_type = ? AND resource_id = ? AND deleted = 0
      ORDER BY version_id ASC
    `)

    const resources: Record<string, unknown>[] = []
    for (const entry of currentEntries) {
      const historyRows = z.array(fhirHistoryContentRowSchema).parse(
        selectHistory.all(context.workspaceId, context.epoch, resourceType, entry.id),
      )
      if (historyRows.length === 0) {
        resources.push(entry.resource)
        continue
      }
      for (const row of historyRows) {
        const parsed = fhirResourceSchema.parse(JSON.parse(row.content_json))
        const existingMeta = parsed.meta
        resources.push({
          ...parsed,
          meta: {
            ...existingMeta,
            versionId: String(row.version_id),
            lastUpdated: existingMeta?.lastUpdated ?? row.last_updated,
          },
        })
      }
    }
    return resources
  }

  #loadLocalFhirCandidates(
    context: RepositoryContext,
    patientId: string,
  ): TranscribedClinicalFactCandidate[] {
    const observations = this.#loadFhirHistoryForPatient(context, 'Observation', patientId) as unknown as FhirObservationLike[]
    const diagnosticReports = this.#loadFhirHistoryForPatient(context, 'DiagnosticReport', patientId) as unknown as FhirDiagnosticReportLike[]
    const conditions = this.#loadFhirHistoryForPatient(context, 'Condition', patientId) as unknown as FhirConditionLike[]
    const allergyIntolerances = this.#loadFhirHistoryForPatient(context, 'AllergyIntolerance', patientId) as unknown as FhirAllergyIntoleranceLike[]
    const medicationRequests = this.#loadFhirHistoryForPatient(context, 'MedicationRequest', patientId)
    const medicationAdmins = this.#loadFhirHistoryForPatient(context, 'MedicationAdministration', patientId)
    const medicationDispenses = this.#loadFhirHistoryForPatient(context, 'MedicationDispense', patientId)
    const procedures = this.#loadFhirHistoryForPatient(context, 'Procedure', patientId) as unknown as FhirProcedureLike[]
    const serviceRequests = this.#searchAllFhirIdsForPatient(context, 'ServiceRequest', patientId)

    const orderedAtByObservationId: Record<string, string> = {}
    const orderedAtByReportId: Record<string, string> = {}
    const orderedAtByRequestRef: Record<string, string> = {}
    const sourceSystemIdByObservationId: Record<string, string> = {}
    const ingestedAtByObservationId: Record<string, string> = {}

    const existingObsVersionKeys = new Set(
      observations.map(obs => `${obs.id}::${obs.meta?.versionId ?? '1'}`),
    )
    for (const entry of this.listEligibleIngestedObservations(context, patientId)) {
      const obsId = entry.observation.id
      const obsVer = entry.observation.meta?.versionId ?? '1'
      const versionKey = `${obsId}::${obsVer}`
      if (!existingObsVersionKeys.has(versionKey)) {
        observations.push(entry.observation)
        existingObsVersionKeys.add(versionKey)
      }
      sourceSystemIdByObservationId[obsId] = entry.sourceSystemId
      ingestedAtByObservationId[obsId] = entry.ingestedAt
      if (entry.orderedAt) {
        orderedAtByObservationId[obsId] = entry.orderedAt
      }
    }

    for (const sr of serviceRequests) {
      if (typeof sr.resource['authoredOn'] === 'string') {
        orderedAtByRequestRef[`ServiceRequest/${sr.id}`] = sr.resource['authoredOn']
      }
    }

    const labReqRows = z.array(z.object({
      request_id: z.string(),
      service_request_id: z.string(),
      diagnostic_report_id: z.string().nullable(),
      authored_at: z.string(),
    }).strict()).parse(
      this.#database.driver.prepare(`
        SELECT r.request_id, r.service_request_id, r.diagnostic_report_id, r.authored_at
        FROM laboratory_request AS r
        JOIN clinical_request_context AS ctx
          ON ctx.workspace_id = r.workspace_id
         AND ctx.epoch = r.epoch
         AND ctx.case_id = r.case_id
        WHERE r.workspace_id = ? AND r.epoch = ? AND ctx.patient_id = ?
      `).all(context.workspaceId, context.epoch, patientId),
    )

    const requestIds: string[] = []
    for (const row of labReqRows) {
      requestIds.push(row.request_id)
      orderedAtByRequestRef[`ServiceRequest/${row.service_request_id}`] = row.authored_at
      if (row.diagnostic_report_id) {
        orderedAtByReportId[row.diagnostic_report_id] = row.authored_at
      }
    }

    const supersedesReportId: Record<string, string> = {}
    if (requestIds.length > 0) {
      const revRows = z.array(z.object({
        request_id: z.string(),
        diagnostic_report_id: z.string(),
        revision_of_diagnostic_report_id: z.string(),
      }).strict()).parse(
        this.#database.driver.prepare(`
          SELECT rev.request_id, rev.diagnostic_report_id, rev.revision_of_diagnostic_report_id
          FROM laboratory_report_revision AS rev
          JOIN laboratory_request AS r
            ON r.workspace_id = rev.workspace_id
           AND r.epoch = rev.epoch
           AND r.request_id = rev.request_id
          JOIN clinical_request_context AS ctx
            ON ctx.workspace_id = r.workspace_id
           AND ctx.epoch = r.epoch
           AND ctx.case_id = r.case_id
          WHERE rev.workspace_id = ? AND rev.epoch = ? AND ctx.patient_id = ?
        `).all(context.workspaceId, context.epoch, patientId),
      )
      for (const rev of revRows) {
        supersedesReportId[rev.diagnostic_report_id] = rev.revision_of_diagnostic_report_id
        const authored = labReqRows.find(r => r.request_id === rev.request_id)?.authored_at
        if (authored) orderedAtByReportId[rev.diagnostic_report_id] = authored
      }
    }

    const supersedesObservationId: Record<string, string> = {}
    const vitalRevRows = z.array(z.object({
      admission_id: z.string(),
      revision: z.number().int(),
      observation_id: z.string(),
    }).strict()).parse(
      this.#database.driver.prepare(`
        SELECT v.admission_id, v.revision, v.observation_id
        FROM inpatient_vital_signs AS v
        JOIN inpatient_admission AS a
          ON a.workspace_id = v.workspace_id
         AND a.epoch = v.epoch
         AND a.admission_id = v.admission_id
        WHERE v.workspace_id = ? AND v.epoch = ? AND a.patient_id = ?
        ORDER BY v.admission_id ASC, v.revision ASC
      `).all(context.workspaceId, context.epoch, patientId),
    )
    let prevVitalAdmission: string | null = null
    let prevVitalObsId: string | null = null
    for (const row of vitalRevRows) {
      if (row.admission_id === prevVitalAdmission && prevVitalObsId && prevVitalObsId !== row.observation_id) {
        supersedesObservationId[row.observation_id] = prevVitalObsId
      }
      prevVitalAdmission = row.admission_id
      prevVitalObsId = row.observation_id
    }

    const specimenLabelById: Record<string, string> = {}
    const specimenIds = new Set<string>()
    for (const obs of observations) {
      const ref = obs.specimen?.reference
      if (ref && !obs.specimen?.display) {
        specimenIds.add(ref.replace(/^Specimen\//, ''))
      }
    }
    for (const report of diagnosticReports) {
      for (const spec of report.specimen ?? []) {
        if (spec.reference && !spec.display) {
          specimenIds.add(spec.reference.replace(/^Specimen\//, ''))
        }
      }
    }
    for (const specimenId of specimenIds) {
      try {
        const specimen = this.#fhir.read(context, 'Specimen', specimenId) as { type?: { text?: string; coding?: Array<{ display?: string }> } }
        const label = specimen.type?.text ?? specimen.type?.coding?.[0]?.display
        if (label) specimenLabelById[specimenId] = label
      } catch {
        /* ignore missing Specimen reference */
      }
    }

    return transcribeLocalFhirFacts({
      observations,
      diagnosticReports,
      conditions,
      allergyIntolerances,
      medications: [...medicationRequests, ...medicationAdmins, ...medicationDispenses] as unknown as FhirMedicationLike[],
      procedures,
      orderedAtByObservationId,
      orderedAtByReportId,
      orderedAtByRequestRef,
      specimenLabelById,
      supersedesObservationId,
      supersedesReportId,
      sourceSystemIdByObservationId,
      ingestedAtByObservationId,
    })
  }

  listEligibleIngestedObservations(
    context: RepositoryContext,
    patientId: string,
  ): ReadonlyArray<{
    observation: FhirObservationLike & {
      referenceRange?: ReadonlyArray<{ low?: { value?: number }; high?: { value?: number } }>
      interpretation?: ReadonlyArray<{ coding?: ReadonlyArray<{ code?: string; display?: string }> }>
    }
    sourceSystemId: string
    ingestedAt: string
    orderedAt: string | null
  }> {
    const rows = z.array(eligibleIngestedRecordRowSchema).parse(
      this.#database.driver.prepare(`
        SELECT r.ingestion_record_id, r.source_system_id, r.fhir_observation_json,
               r.provenance_json, r.ingested_at
        FROM local_ingestion_record AS r
        JOIN local_ingestion_batch AS b
          ON b.workspace_id = r.workspace_id
         AND b.epoch = r.epoch
         AND b.batch_id = r.batch_id
        JOIN local_ingestion_quarantine AS q
          ON q.workspace_id = r.workspace_id
         AND q.epoch = r.epoch
         AND q.candidate_id = r.candidate_id
        WHERE r.workspace_id = ?
          AND r.epoch = ?
          AND r.patient_id = ?
          AND b.status = 'complete'
          AND q.resolution_status IN ('auto-matched', 'confirmed-merged')
        ORDER BY r.ingested_at ASC, r.ingestion_record_id ASC
      `).all(context.workspaceId, context.epoch, patientId),
    )

    return rows.map(row => {
      const obs = ingestedFhirObservationSchema.parse(
        JSON.parse(row.fhir_observation_json),
      ) as unknown as FhirObservationLike & {
        referenceRange?: ReadonlyArray<{ low?: { value?: number }; high?: { value?: number } }>
        interpretation?: ReadonlyArray<{ coding?: ReadonlyArray<{ code?: string; display?: string }> }>
      }
      const prov = ingestedProvenancePayloadSchema.parse(JSON.parse(row.provenance_json))
      return {
        observation: obs,
        sourceSystemId: row.source_system_id,
        ingestedAt: prov.ingestedAt ?? row.ingested_at,
        orderedAt: prov.orderedAt ?? null,
      }
    })
  }

  #loadVisibleHistoryCandidates(
    context: ActorContext,
    subject: { kind: ClinicalFactSubjectKind; id: string; patientId: string },
  ): TranscribedClinicalFactCandidate[] {
    let sourceCaseId: string | undefined
    if (subject.kind === 'outpatient') {
      sourceCaseId = outpatientCaseSource(this.#database, context, subject.id, subject.patientId)?.case_id
    } else {
      const admRow = z.object({ source_case_id: z.string().nullable() }).optional().parse(
        this.#database.driver.prepare(`
          SELECT source_case_id FROM inpatient_admission
          WHERE workspace_id = ? AND epoch = ? AND admission_id = ?
        `).get(context.workspaceId, context.epoch, subject.id),
      )
      sourceCaseId = admRow?.source_case_id ?? undefined
    }
    if (!sourceCaseId) return []

    const rows = z.array(z.object({
      sequence: z.number().int(),
      source_reference: z.string().min(1),
      resource_type: z.string().min(1),
      clinical_date: z.string().min(1),
      title: z.string().min(1),
      resource_json: z.string().min(1),
    }).strict()).parse(
      this.#database.driver.prepare(`
        SELECT vh.sequence, vh.source_reference, vh.resource_type, vh.clinical_date, vh.title, vr.resource_json
        FROM synthetic_case_visible_history AS vh
        JOIN synthetic_case_visible_resource AS vr
          ON vr.workspace_id = vh.workspace_id
         AND vr.case_id = vh.case_id
         AND vr.source_reference = vh.source_reference
        WHERE vh.workspace_id = ? AND vh.case_id = ?
        ORDER BY vh.sequence ASC
      `).all(context.workspaceId, sourceCaseId),
    )

    return transcribeVisibleSourceHistoryFacts({
      entries: rows.map(row => ({
        entryId: `${sourceCaseId}:${row.sequence}:${row.source_reference}`,
        sourceReference: row.source_reference,
        resourceType: row.resource_type,
        clinicalDate: row.clinical_date,
        title: row.title,
        clinical: visibleSourceClinicalSchema.parse(JSON.parse(row.resource_json)),
      })),
    })
  }

  #loadOrderedWorkupAndProcedureCandidates(
    context: RepositoryContext,
    patientId: string,
    asOf: string,
  ): TranscribedClinicalFactCandidate[] {
    const candidates: TranscribedClinicalFactCandidate[] = []
    const emittedRequestIds = new Set<string>()
    const srList = this.#searchAllFhirIdsForPatient(context, 'ServiceRequest', patientId)
    const closedLabReqRows = z.array(z.object({
      service_request_id: z.string().min(1),
    }).strict()).parse(
      this.#database.driver.prepare(`
        SELECT r.service_request_id
        FROM laboratory_request AS r
        JOIN clinical_request_context AS ctx
          ON ctx.workspace_id = r.workspace_id AND ctx.epoch = r.epoch AND ctx.case_id = r.case_id
        WHERE r.workspace_id = ? AND r.epoch = ? AND ctx.patient_id = ?
          AND (r.status IN ('reported', 'acknowledged', 'cancelled') OR r.diagnostic_report_id IS NOT NULL)
      `).all(context.workspaceId, context.epoch, patientId),
    )
    const closedServiceRequestIds = new Set(closedLabReqRows.map(r => r.service_request_id))

    const pushRequestCandidate = (input: {
      category: 'laboratory' | 'examination' | 'procedure'
      code: string
      display: string
      effectiveAt: string
      recordId: string
      system: string
    }) => {
      if (emittedRequestIds.has(input.recordId)) return
      emittedRequestIds.add(input.recordId)
      candidates.push({
        category: input.category,
        effectiveAt: input.effectiveAt,
        factId: `his-fhir:ServiceRequest:${input.recordId}:1:${input.code}`,
        ingestedAt: input.effectiveAt,
        institutionScope: 'local',
        itemCode: {
          code: input.code,
          display: input.display,
          system: input.system,
        },
        mappingVersion: 'clinmesh-fact-map-v1',
        method: null,
        orderedAt: input.effectiveAt,
        presence: 'present',
        provenance: {
          recordId: input.recordId,
          recordType: 'ServiceRequest',
          recordVersion: '1',
          sourceSystemId: 'clinmesh-his-fhir',
        },
        recordStatus: 'final',
        reportedAt: null,
        specimenOrSite: null,
        supersedesFactId: null,
        value: {
          normalizedValue: {
            code: input.code,
            display: input.display,
            system: input.system,
          },
          rawText: `已开立${input.display}`,
        },
        verificationStatus: 'provisional',
      })
    }

    for (const sr of srList) {
      const parsed = z.object({
        authoredOn: z.string().optional(),
        code: z.object({
          coding: z.array(z.object({ code: z.string().optional(), display: z.string().optional(), system: z.string().optional() }).loose()).optional(),
          concept: z.object({
            coding: z.array(z.object({ code: z.string().optional(), display: z.string().optional(), system: z.string().optional() }).loose()).optional(),
            text: z.string().optional(),
          }).loose().optional(),
          text: z.string().optional(),
        }).loose().optional(),
        id: z.string().min(1),
        status: z.string().optional(),
      }).loose().safeParse(sr.resource)
      if (!parsed.success || parsed.data.status !== 'active' || closedServiceRequestIds.has(parsed.data.id)) continue
      const authoredAt = parsed.data.authoredOn ?? asOf
      const codings = [
        ...(parsed.data.code?.concept?.coding ?? []),
        ...(parsed.data.code?.coding ?? []),
      ]
      const codes = codings.map(c => c.code ?? '').filter(Boolean)
      const display = [parsed.data.code?.concept?.text, parsed.data.code?.text, ...codings.map(c => c.display)].filter(Boolean).join(' ')
      if (
        codes.some(c => c === '11524-6' || c === 'examination-ecg-12-lead' || c === 'ECG-12')
        || /(?:12|十二)\s*导联心电图|\bECG\b/i.test(display)
      ) {
        pushRequestCandidate({
          category: 'examination',
          code: '11524-6',
          display: '常规 12 导联心电图',
          effectiveAt: authoredAt,
          recordId: parsed.data.id,
          system: 'http://loinc.org',
        })
      } else if (
        codes.some(c => ['89579-7', '10839-9', '6597-9', '2100404B', '2100404A', '2100504A', 'CN-LAB-CARDIAC'].includes(c))
        || /肌钙蛋白|troponin|hs-?ctn/i.test(display)
      ) {
        const matchedCode = codes.find(c => ['89579-7', '10839-9', '6597-9'].includes(c)) ?? '89579-7'
        pushRequestCandidate({
          category: 'laboratory',
          code: matchedCode,
          display: codings[0]?.display ?? '心肌肌钙蛋白测定',
          effectiveAt: authoredAt,
          recordId: parsed.data.id,
          system: 'http://loinc.org',
        })
      } else if (codes.some(c => /^(?:00\.66|36\.0[67]|36\.1|88\.5[56])/.test(c))) {
        const matchedCode = codes.find(c => /^(?:00\.66|36\.0[67]|36\.1|88\.5[56])/.test(c))!
        pushRequestCandidate({
          category: 'procedure',
          code: matchedCode,
          display: codings[0]?.display ?? '冠脉介入检查/治疗计划',
          effectiveAt: authoredAt,
          recordId: parsed.data.id,
          system: codings[0]?.system ?? 'http://loinc.org',
        })
      }
    }

    const plannedSurgeries = z.array(z.object({
      planned_procedure_json: z.string().min(1),
      request_id: z.string().min(1),
      requested_at: z.string().min(1),
    }).strict()).parse(
      this.#database.driver.prepare(`
        SELECT s.request_id, s.planned_procedure_json, s.requested_at
        FROM inpatient_surgery_request AS s
        JOIN inpatient_admission AS a
          ON a.workspace_id = s.workspace_id AND a.epoch = s.epoch AND a.admission_id = s.admission_id
        WHERE s.workspace_id = ? AND s.epoch = ? AND a.patient_id = ?
          AND s.status IN ('requested', 'ready', 'standby-pci')
      `).all(context.workspaceId, context.epoch, patientId),
    )
    for (const row of plannedSurgeries) {
      const proc = z.object({
        coding: z.object({ code: z.string(), display: z.string(), system: z.string() }).optional(),
        code: z.string().optional(),
        display: z.string().optional(),
        system: z.string().optional(),
      }).loose().safeParse(JSON.parse(row.planned_procedure_json))
      if (!proc.success) continue
      const code = proc.data.coding?.code ?? proc.data.code
      const display = proc.data.coding?.display ?? proc.data.display ?? '计划手术'
      const system = proc.data.coding?.system ?? proc.data.system ?? 'urn:clinmesh:procedure'
      if (code && /^(?:00\.66|36\.0[67]|36\.1|88\.5[56])/.test(code)) {
        pushRequestCandidate({
          category: 'procedure',
          code,
          display,
          effectiveAt: row.requested_at,
          recordId: row.request_id,
          system,
        })
      }
    }

    return candidates
  }

  #loadDischargeAndEncounterContextCandidates(
    context: RepositoryContext,
    subject: { kind: ClinicalFactSubjectKind; id: string; patientId: string },
    asOf: string,
  ): TranscribedClinicalFactCandidate[] {
    const candidates: TranscribedClinicalFactCandidate[] = []

    const dischargeRows = z.array(z.object({
      event_id: z.string().min(1),
      virtual_time: z.string().min(1),
    }).strict()).parse(
      this.#database.driver.prepare(`
        SELECT de.event_id, de.virtual_time
        FROM inpatient_discharge_event de
        JOIN inpatient_admission ia
          ON ia.workspace_id = de.workspace_id AND ia.epoch = de.epoch AND ia.admission_id = de.admission_id
        WHERE de.workspace_id = ? AND de.epoch = ? AND ia.patient_id = ?
          AND de.kind IN ('issue', 'depart')
          AND julianday(de.virtual_time) <= julianday(?)
          AND NOT EXISTS (
            SELECT 1 FROM inpatient_discharge_event r
            WHERE r.workspace_id = de.workspace_id AND r.epoch = de.epoch
              AND r.kind = 'recall' AND r.reverses_event_id = de.event_id
          )
        ORDER BY julianday(de.virtual_time) ASC, de.event_id ASC
      `).all(context.workspaceId, context.epoch, subject.patientId, asOf),
    )
    for (const row of dischargeRows) {
      candidates.push({
        category: 'procedure',
        effectiveAt: row.virtual_time,
        factId: `his-fhir:DischargeEvent:${row.event_id}:1:18842-5`,
        ingestedAt: row.virtual_time,
        institutionScope: 'local',
        itemCode: {
          code: '18842-5',
          display: '住院出院时间/出院小结',
          system: 'http://loinc.org',
        },
        mappingVersion: 'clinmesh-fact-map-v1',
        method: null,
        orderedAt: null,
        presence: 'present',
        provenance: {
          recordId: row.event_id,
          recordType: 'DischargeEvent',
          recordVersion: '1',
          sourceSystemId: 'clinmesh-his-fhir',
        },
        recordStatus: 'final',
        reportedAt: row.virtual_time,
        specimenOrSite: null,
        supersedesFactId: null,
        value: {
          normalizedValue: row.virtual_time,
          rawText: `出院时间 ${row.virtual_time}`,
        },
        verificationStatus: 'confirmed',
      })
    }

    if (subject.kind === 'outpatient') {
      const caseRow = z.object({
        arrived_at: z.string().min(1),
      }).optional().parse(
        this.#database.driver.prepare(`
          SELECT arrived_at FROM outpatient_case
          WHERE workspace_id = ? AND epoch = ? AND case_id = ?
        `).get(context.workspaceId, context.epoch, subject.id),
      )
      if (caseRow !== undefined) {
        const recordId = `outpatient-encounter-context:${subject.id}`
        candidates.push({
          category: 'procedure',
          effectiveAt: caseRow.arrived_at,
          factId: `his-fhir:EncounterContext:${recordId}:1:outpatient-encounter-context`,
          ingestedAt: caseRow.arrived_at,
          institutionScope: 'local',
          itemCode: {
            code: 'outpatient-encounter-context',
            display: '当前门诊接诊上下文',
            system: 'urn:clinmesh:encounter-context',
          },
          mappingVersion: 'clinmesh-fact-map-v1',
          method: null,
          orderedAt: null,
          presence: 'present',
          provenance: {
            recordId,
            recordType: 'EncounterContext',
            recordVersion: '1',
            sourceSystemId: 'clinmesh-his-fhir',
          },
          recordStatus: 'final',
          reportedAt: caseRow.arrived_at,
          specimenOrSite: null,
          supersedesFactId: null,
          value: {
            normalizedValue: subject.id,
            rawText: `门诊接诊 ${subject.id}`,
          },
          verificationStatus: 'confirmed',
        })
      }
    }

    return candidates
  }

  #loadBedsideQuestionnaireCandidates(
    context: RepositoryContext,
    patientId: string,
  ): TranscribedClinicalFactCandidate[] {
    const rows = z.array(z.object({
      case_id: z.string().min(1),
      revision: z.number().int().positive(),
      assessment_json: z.string().min(1),
      observation_id: z.string().min(1),
      observation_version: z.string().min(1),
      recorded_at: z.string().min(1),
    }).strict()).parse(
      this.#database.driver.prepare(`
        SELECT a.case_id, a.revision, a.assessment_json, a.observation_id, a.observation_version, a.recorded_at
        FROM clinical_risk_assessment AS a
        JOIN clinical_request_context AS ctx
          ON ctx.workspace_id = a.workspace_id
         AND ctx.epoch = a.epoch
         AND ctx.case_id = a.case_id
        WHERE a.workspace_id = ? AND a.epoch = ? AND ctx.patient_id = ?
        ORDER BY a.case_id ASC, a.revision ASC
      `).all(context.workspaceId, context.epoch, patientId),
    )

    const byCaseId = new Map<string, typeof rows>()
    for (const row of rows) {
      const list = byCaseId.get(row.case_id)
      if (list) list.push(row)
      else byCaseId.set(row.case_id, [row])
    }

    const legacyCodes = new Set(LEGACY_BEDSIDE_QUESTIONNAIRE_FIELDS.map(field => field.code))
    const answerRows = z.array(z.object({
      answers_json: z.string().min(1),
      recorded_at: z.string().min(1),
      revision: z.number().int().positive(),
      subject_id: z.string().min(1),
      subject_kind: z.enum(['outpatient', 'inpatient']),
    }).strict()).parse(
      this.#database.driver.prepare(`
        SELECT subject_kind, subject_id, revision, answers_json, recorded_at
        FROM bedside_questionnaire_answers
        WHERE workspace_id = ? AND epoch = ? AND patient_id = ?
        ORDER BY subject_kind ASC, subject_id ASC, revision ASC
      `).all(context.workspaceId, context.epoch, patientId),
    )

    const extrasBySubject = new Map<string, typeof answerRows>()
    for (const row of answerRows) {
      const key = `${row.subject_kind}:${row.subject_id}`
      const list = extrasBySubject.get(key)
      if (list) list.push(row)
      else extrasBySubject.set(key, [row])
    }

    const candidates: TranscribedClinicalFactCandidate[] = []
    for (const [caseId, caseRows] of byCaseId) {
      candidates.push(...transcribeBedsideQuestionnaireFacts({
        revisions: caseRows.map(row => ({
          revisionId: `${caseId}-rev-${row.revision}`,
          revisionNumber: row.revision,
          recordedAt: row.recorded_at,
          observationId: row.observation_id,
          observationVersion: row.observation_version,
          values: clinicalRiskAssessmentValuesSchema.parse(JSON.parse(row.assessment_json)),
        })),
      }))
    }

    for (const [subjectKey, subjectRows] of extrasBySubject) {
      const subjectId = subjectRows[0]!.subject_id
      const skipLegacyForSubject = byCaseId.has(subjectId)
      candidates.push(...transcribeBedsideQuestionnaireFacts({
        revisions: subjectRows.map(row => {
          const parsedAnswers = z.array(bedsideQuestionnaireValueInputSchema).parse(JSON.parse(row.answers_json))
          const extraAnswers: BedsideQuestionnaireExtraAnswerInput[] = []
          for (const answer of parsedAnswers) {
            const code = normalizeBedsideItemCode(answer.code)
            if (skipLegacyForSubject && legacyCodes.has(code)) continue
            const scalar = answer.booleanValue ?? answer.numberValue ?? answer.textValue ?? null
            extraAnswers.push({ code, value: scalar })
          }
          return {
            extraAnswers,
            observationId: `questionnaire-${subjectKey}-rev-${row.revision}`,
            observationVersion: String(row.revision),
            recordedAt: row.recorded_at,
            revisionId: `${subjectKey}-q-rev-${row.revision}`,
            revisionNumber: row.revision,
          }
        }),
      }))
    }

    return candidates
  }

  #loadClinicianVerifications(
    context: RepositoryContext,
    patientId: string,
  ): ClinicalFactVerificationRecord[] {
    const rows = z.array(verificationRowSchema).parse(
      this.#database.driver.prepare(`
        SELECT verification_id, subject_kind, subject_id, patient_id, fact_id, item_code,
          source_reference, source_version, decision, note, actor_id, practitioner_id,
          practitioner_role_id, verified_at
        FROM clinical_fact_verification
        WHERE workspace_id = ? AND epoch = ? AND patient_id = ?
        ORDER BY verified_at ASC, verification_id ASC
      `).all(context.workspaceId, context.epoch, patientId),
    )

    return rows.map(row => ({
      verificationId: row.verification_id,
      subjectKind: row.subject_kind,
      subjectId: row.subject_id,
      patientId: row.patient_id,
      factId: row.fact_id,
      itemCode: row.item_code,
      sourceReference: row.source_reference,
      sourceVersion: row.source_version,
      decision: row.decision,
      note: row.note,
      verifiedAt: row.verified_at,
      verifiedByActorId: row.actor_id,
      verifiedByPractitionerId: row.practitioner_id,
      verifiedByPractitionerRoleId: row.practitioner_role_id,
    }))
  }
}
