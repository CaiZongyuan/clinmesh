import { fhirResourceSchema } from '@clinmesh/contracts/fhir'
import {
  confirmIdentityQuarantineMergeBodySchema,
  confirmIdentityQuarantineMergeResponseSchema,
  DEFAULT_LOCAL_INGESTION_HOSPITAL_ID,
  DEFAULT_LOCAL_INGESTION_MAPPING_VERSION,
  DEFAULT_PATIENT_MATCH_CONFIDENCE_THRESHOLD,
  ingestLocalSourceBatchRequestSchema,
  ingestLocalSourceBatchResponseSchema,
  listIdentityQuarantineQuerySchema,
  listIdentityQuarantineResponseSchema,
  localIngestionBatchContractSchema,
  localIngestionPatientRefSchema,
  patientIdentityCandidateSchema,
  PRIMARY_LOCAL_SOURCE_SYSTEM_ID,
  SIM_LIS_V2_SOURCE_SYSTEM_ID,
  type ConfirmIdentityQuarantineMergeBody,
  type ConfirmIdentityQuarantineMergeResponse,
  type IngestLocalSourceBatchRequest,
  type IngestLocalSourceBatchResponse,
  type ListIdentityQuarantineQuery,
  type ListIdentityQuarantineResponse,
  type PatientIdentityCandidate,
} from '@clinmesh/contracts/local-source-ingestion'
import {
  isBatchComplete,
  matchSourcePatientIdentity,
  normalizePrimaryLisReportToFhir,
  normalizeSimLisV2ReportToFhir,
  type LocalPatientIndexEntry,
  type NormalizedFhirObservationRecord,
} from '@clinmesh/core/local-source-ingestion'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import {
  FhirRepositoryError,
  type FhirRepository,
  type RepositoryContext,
} from '../infrastructure/sqlite/fhir-repository.ts'
import type { ActorContext, CommandExecutor } from './command-executor.ts'
import type { OutpatientWorkflowContext } from './outpatient-workflow-context.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'

export class LocalSourceIngestionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 422,
    readonly reason?: string,
  ) {
    super(message)
    this.name = 'LocalSourceIngestionError'
  }
}

const batchRowSchema = z.object({
  batch_id: z.string(),
  source_system_id: z.string(),
  hospital_id: z.string(),
  expected_count: z.number().int(),
  received_count: z.number().int(),
  status: z.enum(['incomplete', 'complete']),
  created_at: z.string(),
  completed_at: z.string().nullable(),
}).strict()

const quarantineRowSchema = z.object({
  candidate_id: z.string(),
  batch_id: z.string(),
  source_system_id: z.string(),
  external_patient_id: z.string(),
  target_patient_id: z.string().nullable(),
  confidence_score: z.number(),
  threshold: z.number(),
  decision: z.enum(['matched', 'distinct-patient', 'quarantined']),
  resolution_status: z.enum(['auto-matched', 'pending-review', 'confirmed-merged', 'rejected-distinct']),
  mismatch_reasons_json: z.string(),
  patient_payload_json: z.string(),
  resolved_by_actor_id: z.string().nullable(),
  resolved_by_practitioner_id: z.string().nullable(),
  resolved_at: z.string().nullable(),
  note: z.string().nullable(),
  created_at: z.string(),
}).strict()

const linkedExternalIdRowSchema = z.object({
  source_system_id: z.string(),
  external_patient_id: z.string(),
  target_patient_id: z.string(),
}).strict()

const fhirPatientRowSchema = z.object({
  id: z.string(),
  content_json: z.string(),
}).strict()

const fhirPatientContentSchema = z.object({
  id: z.string(),
  birthDate: z.string().optional(),
  name: z.array(z.object({
    text: z.string().optional(),
    family: z.string().optional(),
    given: z.array(z.string()).optional(),
  }).loose()).optional(),
  identifier: z.array(z.object({
    system: z.string().optional(),
    value: z.string().optional(),
    type: z.object({
      coding: z.array(z.object({
        code: z.string().optional(),
      }).loose()).optional(),
    }).loose().optional(),
  }).loose()).optional(),
  telecom: z.array(z.object({
    system: z.string().optional(),
    value: z.string().optional(),
  }).loose()).optional(),
}).loose()

const stringArraySchema = z.array(z.string())

const ingestionRecordSubjectRowSchema = z.object({
  ingestion_record_id: z.string(),
  fhir_observation_json: z.string(),
}).strict()

const ingestionRecordProjectRowSchema = z.object({
  ingestion_record_id: z.string(),
  source_system_id: z.string(),
  fhir_observation_json: z.string(),
  provenance_json: z.string(),
}).strict()

const basedOnEntrySchema = z.object({
  display: z.string().optional(),
  identifier: z.unknown().optional(),
  reference: z.string().optional(),
}).loose()

const QUARANTINE_ALLOWED_ROLES = new Set(['administrator', 'registrar'])

function assertRole(context: ActorContext, allowed: ReadonlySet<string>): void {
  if (!allowed.has(context.roleCode)) {
    throw new LocalSourceIngestionError(
      'FORBIDDEN',
      `Role ${context.roleCode} cannot access local source ingestion controls`,
      403,
    )
  }
}

function extractPatientDemographics(rawContent: unknown): {
  fullName: string | null
  birthDate: string | null
  nationalId: string | null
  phone: string | null
} {
  const p = fhirPatientContentSchema.parse(rawContent)
  const nameEntry = p.name?.[0]
  const fullName = nameEntry?.text?.trim()
    || [nameEntry?.family ?? '', ...(nameEntry?.given ?? [])].join('').trim()
    || null
  const birthDate = p.birthDate ?? null

  let nationalId: string | null = null
  for (const ident of p.identifier ?? []) {
    if (!ident.value) continue
    const system = ident.system ?? ''
    const hasNiCoding = ident.type?.coding?.some(c => c.code === 'NNCHN' || c.code === 'NI') ?? false
    if (
      system === 'urn:oid:1.2.156.112605.1.1'
      || system === 'urn:cn-health-data:simulated-resident-id'
      || system.endsWith('national-id')
      || system.endsWith('resident-id')
      || hasNiCoding
    ) {
      nationalId = ident.value.trim()
      break
    }
  }
  if (nationalId === null) {
    const residentFallback = (p.identifier ?? []).find(
      ident => typeof ident.value === 'string' && /^\d{17}[\dXx]$/.test(ident.value.trim()),
    )
    if (residentFallback?.value) {
      nationalId = residentFallback.value.trim()
    }
  }

  const phone = p.telecom?.find(t => t.system === 'phone' && typeof t.value === 'string')?.value?.trim() ?? null
  return { fullName, birthDate, nationalId, phone }
}

function mapQuarantineRow(row: z.infer<typeof quarantineRowSchema>): PatientIdentityCandidate {
  return patientIdentityCandidateSchema.parse({
    candidateId: row.candidate_id,
    sourceSystemId: row.source_system_id,
    externalPatientId: row.external_patient_id,
    batchId: row.batch_id,
    patientPayload: localIngestionPatientRefSchema.parse(JSON.parse(row.patient_payload_json)),
    matchedLocalPatientId: row.target_patient_id,
    confidenceScore: row.confidence_score,
    confidenceThreshold: row.threshold,
    decision: row.decision,
    mismatchReasons: stringArraySchema.parse(JSON.parse(row.mismatch_reasons_json)),
    resolutionStatus: row.resolution_status,
    resolvedByActorId: row.resolved_by_actor_id,
    resolvedAt: row.resolved_at,
    auditNote: row.note,
  })
}

export interface LocalSourceIngestionServiceOptions {
  commands: CommandExecutor
  database: ClinMeshDatabase
  fhir: FhirRepository
  outpatientContext: OutpatientWorkflowContext
}

/**
 * Manages intra-hospital L0 multi-source batch ingestion, batch completeness gates,
 * and cross-system patient identity quarantine resolution.
 */
export class LocalSourceIngestionService {
  readonly #commands: CommandExecutor
  readonly #database: ClinMeshDatabase
  readonly #fhir: FhirRepository
  readonly #outpatient: OutpatientWorkflowContext

  constructor(options: LocalSourceIngestionServiceOptions) {
    this.#commands = options.commands
    this.#database = options.database
    this.#fhir = options.fhir
    this.#outpatient = options.outpatientContext
  }

  ingestBatch(input: {
    context: ActorContext
    body: IngestLocalSourceBatchRequest
    idempotencyKey: string
  }): IngestLocalSourceBatchResponse {
    const parsedBody = ingestLocalSourceBatchRequestSchema.parse(input.body)
    return this.#commands.execute({
      authorize: () => assertRole(input.context, new Set(['administrator'])),
      context: input.context,
      dataSchema: ingestLocalSourceBatchResponseSchema.shape.data,
      expectedVersions: {},
      idempotencyKey: input.idempotencyKey,
      input: parsedBody,
      operation: 'sim.local-ingestion.batch.ingest',
    }, () => {
      const now = this.#outpatient.virtualTime(input.context)
      const isSimLisV2 = 'patient_ref' in parsedBody
      const sourceSystemId = parsedBody.sourceSystemId ?? SIM_LIS_V2_SOURCE_SYSTEM_ID
      const hospitalId = parsedBody.hospitalId ?? DEFAULT_LOCAL_INGESTION_HOSPITAL_ID
      const ingestedAt = parsedBody.ingestedAt ?? now
      const patientRef = isSimLisV2 ? parsedBody.patient_ref : parsedBody.patientRef

      const existingBatch = batchRowSchema.optional().parse(
        this.#database.driver.prepare(`
          SELECT batch_id, source_system_id, hospital_id, expected_count, received_count, status, created_at, completed_at
          FROM local_ingestion_batch
          WHERE workspace_id = ? AND epoch = ? AND batch_id = ?
        `).get(input.context.workspaceId, input.context.epoch, parsedBody.batchId),
      )

      if (existingBatch) {
        if (
          existingBatch.source_system_id !== sourceSystemId
          || existingBatch.hospital_id !== hospitalId
          || existingBatch.expected_count !== parsedBody.expectedItemCount
        ) {
          throw new LocalSourceIngestionError(
            'INGESTION_BATCH_CONFLICT',
            `Batch ${parsedBody.batchId} metadata conflicts with existing batch definition`,
            409,
          )
        }
        if (existingBatch.received_count + parsedBody.records.length > existingBatch.expected_count) {
          throw new LocalSourceIngestionError(
            'INGESTION_BATCH_OVERFLOW',
            `Batch ${parsedBody.batchId} would exceed expectedItemCount ${existingBatch.expected_count}`,
            409,
          )
        }
      } else {
        if (parsedBody.records.length > parsedBody.expectedItemCount) {
          throw new LocalSourceIngestionError(
            'INGESTION_BATCH_OVERFLOW',
            `Chunk record count ${parsedBody.records.length} exceeds expectedItemCount ${parsedBody.expectedItemCount}`,
            409,
          )
        }
        this.#database.driver.prepare(`
          INSERT INTO local_ingestion_batch (
            workspace_id, epoch, batch_id, source_system_id, hospital_id,
            expected_count, received_count, status, created_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, 0, 'incomplete', ?, NULL)
        `).run(
          input.context.workspaceId,
          input.context.epoch,
          parsedBody.batchId,
          sourceSystemId,
          hospitalId,
          parsedBody.expectedItemCount,
          ingestedAt,
        )
      }

      const existingQuarantine = quarantineRowSchema.optional().parse(
        this.#database.driver.prepare(`
          SELECT candidate_id, batch_id, source_system_id, external_patient_id, target_patient_id,
                 confidence_score, threshold, decision, resolution_status, mismatch_reasons_json,
                 patient_payload_json, resolved_by_actor_id, resolved_by_practitioner_id,
                 resolved_at, note, created_at
          FROM local_ingestion_quarantine
          WHERE workspace_id = ? AND epoch = ? AND batch_id = ? AND source_system_id = ? AND external_patient_id = ?
        `).get(
          input.context.workspaceId,
          input.context.epoch,
          parsedBody.batchId,
          sourceSystemId,
          patientRef.externalPatientId,
        ),
      )

      let identityCandidate: PatientIdentityCandidate
      if (existingQuarantine) {
        const existingPayload = localIngestionPatientRefSchema.parse(JSON.parse(existingQuarantine.patient_payload_json))
        if (canonicalJsonHash(existingPayload) !== canonicalJsonHash(patientRef)) {
          throw new LocalSourceIngestionError(
            'INGESTION_PATIENT_PAYLOAD_CONFLICT',
            `Batch ${parsedBody.batchId} received conflicting demographics for externalPatientId ${patientRef.externalPatientId}`,
            409,
          )
        }
        identityCandidate = mapQuarantineRow(existingQuarantine)
      } else {
        const localPatients = this.#loadLocalPatientIndex(input.context)
        const candidateId = uuidv7()
        identityCandidate = matchSourcePatientIdentity({
          candidateId,
          sourceSystemId,
          batchId: parsedBody.batchId,
          patientPayload: patientRef,
          localPatients,
          confidenceThreshold: DEFAULT_PATIENT_MATCH_CONFIDENCE_THRESHOLD,
        })
        this.#database.driver.prepare(`
          INSERT INTO local_ingestion_quarantine (
            workspace_id, epoch, candidate_id, batch_id, source_system_id,
            external_patient_id, target_patient_id, confidence_score, threshold,
            decision, resolution_status, mismatch_reasons_json, patient_payload_json,
            resolved_by_actor_id, resolved_by_practitioner_id, resolved_at, note, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.context.workspaceId,
          input.context.epoch,
          identityCandidate.candidateId,
          parsedBody.batchId,
          sourceSystemId,
          patientRef.externalPatientId,
          identityCandidate.matchedLocalPatientId,
          identityCandidate.confidenceScore,
          identityCandidate.confidenceThreshold,
          identityCandidate.decision,
          identityCandidate.resolutionStatus,
          JSON.stringify(identityCandidate.mismatchReasons),
          JSON.stringify(identityCandidate.patientPayload),
          identityCandidate.resolvedByActorId,
          null,
          identityCandidate.resolvedAt,
          identityCandidate.auditNote,
          ingestedAt,
        )
      }

      const assignedPatientId =
        identityCandidate.resolutionStatus === 'auto-matched'
        || identityCandidate.resolutionStatus === 'confirmed-merged'
          ? identityCandidate.matchedLocalPatientId
          : null
      const subjectPatientIdPlaceholder = assignedPatientId ?? `quarantined-${identityCandidate.candidateId}`

      const normalizedRecords: NormalizedFhirObservationRecord[] = isSimLisV2
        ? parsedBody.records.map(record => normalizeSimLisV2ReportToFhir({
            record,
            batchId: parsedBody.batchId,
            localPatientId: subjectPatientIdPlaceholder,
            ingestedAt,
            sourceSystemId,
            hospitalId,
            specimenBarcode: parsedBody.specimen_barcode,
            mappingVersion: DEFAULT_LOCAL_INGESTION_MAPPING_VERSION,
          }))
        : parsedBody.records.map(record => normalizePrimaryLisReportToFhir({
            record,
            batchId: parsedBody.batchId,
            localPatientId: subjectPatientIdPlaceholder,
            ingestedAt,
            sourceSystemId: PRIMARY_LOCAL_SOURCE_SYSTEM_ID,
            hospitalId,
            specimenBarcode: parsedBody.specimenBarcode ?? null,
            mappingVersion: DEFAULT_LOCAL_INGESTION_MAPPING_VERSION,
          }))

      const insertStmt = this.#database.driver.prepare(`
        INSERT INTO local_ingestion_record (
          workspace_id, epoch, ingestion_record_id, batch_id, candidate_id,
          source_system_id, patient_id, fhir_observation_json, provenance_json, ingested_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      for (const normalized of normalizedRecords) {
        const ingestionRecordId = `${parsedBody.batchId}::${sourceSystemId}::${normalized.externalReportId}::v${normalized.version}`
        const duplicate = this.#database.driver.prepare(`
          SELECT 1 AS found FROM local_ingestion_record
          WHERE workspace_id = ? AND epoch = ? AND ingestion_record_id = ?
        `).get(input.context.workspaceId, input.context.epoch, ingestionRecordId)
        if (duplicate !== undefined) {
          throw new LocalSourceIngestionError(
            'INGESTION_RECORD_DUPLICATE',
            `Duplicate ingestion record ${ingestionRecordId} in batch ${parsedBody.batchId}`,
            409,
          )
        }
        insertStmt.run(
          input.context.workspaceId,
          input.context.epoch,
          ingestionRecordId,
          parsedBody.batchId,
          identityCandidate.candidateId,
          sourceSystemId,
          assignedPatientId,
          JSON.stringify(normalized.observation),
          JSON.stringify(normalized.provenance),
          ingestedAt,
        )
      }

      const countRow = z.object({ total: z.number().int() }).parse(
        this.#database.driver.prepare(`
          SELECT COUNT(*) AS total
          FROM local_ingestion_record
          WHERE workspace_id = ? AND epoch = ? AND batch_id = ?
        `).get(input.context.workspaceId, input.context.epoch, parsedBody.batchId),
      )

      const complete = isBatchComplete(parsedBody.expectedItemCount, countRow.total)
      const nextStatus = complete ? 'complete' : 'incomplete'
      const completedAt = complete ? ingestedAt : null

      this.#database.driver.prepare(`
        UPDATE local_ingestion_batch
        SET received_count = ?, status = ?, completed_at = ?
        WHERE workspace_id = ? AND epoch = ? AND batch_id = ?
      `).run(
        countRow.total,
        nextStatus,
        completedAt,
        input.context.workspaceId,
        input.context.epoch,
        parsedBody.batchId,
      )

      const updatedBatch = batchRowSchema.parse(
        this.#database.driver.prepare(`
          SELECT batch_id, source_system_id, hospital_id, expected_count, received_count, status, created_at, completed_at
          FROM local_ingestion_batch
          WHERE workspace_id = ? AND epoch = ? AND batch_id = ?
        `).get(input.context.workspaceId, input.context.epoch, parsedBody.batchId),
      )

      const batchSummary = localIngestionBatchContractSchema.parse({
        sourceSystemId: updatedBatch.source_system_id,
        hospitalId: updatedBatch.hospital_id,
        batchId: updatedBatch.batch_id,
        expectedItemCount: updatedBatch.expected_count,
        receivedItemCount: updatedBatch.received_count,
        batchStatus: updatedBatch.status,
        ingestedAt,
      })

      const projectedEffects = complete && assignedPatientId !== null
        ? this.#projectBatchRecordsToFhir(input.context, parsedBody.batchId, assignedPatientId)
        : []

      return {
        data: {
          batch: batchSummary,
          identityCandidate,
          acceptedRecordCount: normalizedRecords.length,
          visibleInClinicalLedger: complete && assignedPatientId !== null,
        },
        effects: [
          {
            kind: existingBatch ? 'updated' : 'created',
            reference: `LocalIngestionBatch/${parsedBody.batchId}`,
            versionId: String(updatedBatch.received_count),
          },
          {
            kind: existingQuarantine ? 'updated' : 'created',
            reference: `IdentityQuarantine/${identityCandidate.candidateId}`,
            versionId: '1',
          },
          ...projectedEffects,
        ],
      }
    })
  }

  listQuarantineCandidates(
    context: ActorContext,
    rawQuery: ListIdentityQuarantineQuery = {},
  ): ListIdentityQuarantineResponse {
    const query = listIdentityQuarantineQuerySchema.parse(rawQuery)
    try {
      assertRole(context, QUARANTINE_ALLOWED_ROLES)

      const clauses = ['workspace_id = ?', 'epoch = ?']
      const params: unknown[] = [context.workspaceId, context.epoch]
      if (query.resolutionStatus !== undefined) {
        clauses.push('resolution_status = ?')
        params.push(query.resolutionStatus)
      }
      if (query.sourceSystemId !== undefined) {
        clauses.push('source_system_id = ?')
        params.push(query.sourceSystemId)
      }
      if (query.batchId !== undefined) {
        clauses.push('batch_id = ?')
        params.push(query.batchId)
      }

      const rows = z.array(quarantineRowSchema).parse(
        this.#database.driver.prepare(`
          SELECT candidate_id, batch_id, source_system_id, external_patient_id, target_patient_id,
                 confidence_score, threshold, decision, resolution_status, mismatch_reasons_json,
                 patient_payload_json, resolved_by_actor_id, resolved_by_practitioner_id,
                 resolved_at, note, created_at
          FROM local_ingestion_quarantine
          WHERE ${clauses.join(' AND ')}
          ORDER BY julianday(created_at) DESC, candidate_id ASC
        `).all(...params),
      )

      const pendingRow = z.object({ total: z.number().int() }).parse(
        this.#database.driver.prepare(`
          SELECT COUNT(*) AS total
          FROM local_ingestion_quarantine
          WHERE workspace_id = ? AND epoch = ? AND resolution_status = 'pending-review'
        `).get(context.workspaceId, context.epoch),
      )

      const items = rows.map(mapQuarantineRow)
      const response = listIdentityQuarantineResponseSchema.parse({
        items,
        totalCount: items.length,
        pendingCount: pendingRow.total,
      })

      this.#commands.auditRead(context, 'identity-quarantine.list', query, 'success')
      return response
    } catch (error) {
      try {
        this.#commands.auditRead(context, 'identity-quarantine.list', query, 'failed')
      } catch {
        /* preserve original error */
      }
      throw error
    }
  }

  confirmMerge(input: {
    context: ActorContext
    candidateId: string
    body: ConfirmIdentityQuarantineMergeBody
    idempotencyKey: string
  }): ConfirmIdentityQuarantineMergeResponse {
    const parsedBody = confirmIdentityQuarantineMergeBodySchema.parse(input.body)
    return this.#commands.execute({
      authorize: () => assertRole(input.context, QUARANTINE_ALLOWED_ROLES),
      context: input.context,
      dataSchema: confirmIdentityQuarantineMergeResponseSchema.shape.data,
      expectedVersions: {},
      idempotencyKey: input.idempotencyKey,
      input: { candidateId: input.candidateId, ...parsedBody },
      operation: 'identity-quarantine.confirm-merge',
    }, () => {
      const row = quarantineRowSchema.optional().parse(
        this.#database.driver.prepare(`
          SELECT candidate_id, batch_id, source_system_id, external_patient_id, target_patient_id,
                 confidence_score, threshold, decision, resolution_status, mismatch_reasons_json,
                 patient_payload_json, resolved_by_actor_id, resolved_by_practitioner_id,
                 resolved_at, note, created_at
          FROM local_ingestion_quarantine
          WHERE workspace_id = ? AND epoch = ? AND candidate_id = ?
        `).get(input.context.workspaceId, input.context.epoch, input.candidateId),
      )
      if (!row) {
        throw new LocalSourceIngestionError(
          'IDENTITY_QUARANTINE_NOT_FOUND',
          `Identity quarantine candidate ${input.candidateId} was not found`,
          404,
        )
      }
      if (row.resolution_status === 'confirmed-merged' || row.resolution_status === 'rejected-distinct') {
        throw new LocalSourceIngestionError(
          'IDENTITY_QUARANTINE_ALREADY_RESOLVED',
          `Identity quarantine candidate ${input.candidateId} was already resolved as ${row.resolution_status}`,
          409,
        )
      }
      if (row.resolution_status === 'auto-matched') {
        throw new LocalSourceIngestionError(
          'IDENTITY_QUARANTINE_ALREADY_AUTO_MATCHED',
          `Identity quarantine candidate ${input.candidateId} was already auto-matched`,
          409,
        )
      }

      const resolvedAt = this.#outpatient.virtualTime(input.context)
      const payload = localIngestionPatientRefSchema.parse(JSON.parse(row.patient_payload_json))

      if (parsedBody.decision === 'confirm-merge') {
        const targetPatientId = parsedBody.targetPatientId ?? row.target_patient_id
        if (!targetPatientId) {
          throw new LocalSourceIngestionError(
            'MISSING_TARGET_PATIENT_ID',
            'targetPatientId is required when confirming an identity quarantine merge',
            400,
          )
        }

        let patientResource: unknown
        try {
          patientResource = this.#fhir.read(input.context, 'Patient', targetPatientId)
        } catch (error) {
          if (error instanceof FhirRepositoryError && error.code === 'NOT_FOUND') {
            throw new LocalSourceIngestionError(
              'TARGET_PATIENT_NOT_FOUND',
              `Target patient ${targetPatientId} was not found`,
              404,
            )
          }
          throw error
        }

        const demographics = extractPatientDemographics(patientResource)
        if (demographics.birthDate !== null && demographics.birthDate !== payload.birthDate) {
          throw new LocalSourceIngestionError(
            'BIRTH_DATE_MISMATCH_MERGE_FORBIDDEN',
            `Cannot merge ${row.candidate_id}: birthDate ${payload.birthDate} conflicts with target patient ${targetPatientId} (${demographics.birthDate})`,
            422,
          )
        }
        if (
          demographics.nationalId !== null
          && demographics.nationalId.trim().toUpperCase() !== payload.nationalId.trim().toUpperCase()
        ) {
          throw new LocalSourceIngestionError(
            'NATIONAL_ID_MISMATCH_MERGE_FORBIDDEN',
            `Cannot merge ${row.candidate_id}: nationalId conflicts with target patient ${targetPatientId}`,
            422,
          )
        }

        this.#database.driver.prepare(`
          UPDATE local_ingestion_quarantine
          SET target_patient_id = ?,
              resolution_status = 'confirmed-merged',
              resolved_by_actor_id = ?,
              resolved_by_practitioner_id = ?,
              resolved_at = ?,
              note = ?
          WHERE workspace_id = ? AND epoch = ? AND candidate_id = ?
        `).run(
          targetPatientId,
          input.context.actorId,
          input.context.practitionerId ?? null,
          resolvedAt,
          parsedBody.auditNote,
          input.context.workspaceId,
          input.context.epoch,
          input.candidateId,
        )

        const records = z.array(ingestionRecordSubjectRowSchema).parse(
          this.#database.driver.prepare(`
            SELECT ingestion_record_id, fhir_observation_json
            FROM local_ingestion_record
            WHERE workspace_id = ? AND epoch = ? AND candidate_id = ?
          `).all(input.context.workspaceId, input.context.epoch, input.candidateId),
        )
        const updateRecordStmt = this.#database.driver.prepare(`
          UPDATE local_ingestion_record
          SET patient_id = ?, fhir_observation_json = ?
          WHERE workspace_id = ? AND epoch = ? AND ingestion_record_id = ?
        `)
        for (const rec of records) {
          const parsedObs = fhirResourceSchema.parse(JSON.parse(rec.fhir_observation_json))
          const updatedObs = {
            ...parsedObs,
            subject: { reference: `Patient/${targetPatientId}` },
          }
          updateRecordStmt.run(
            targetPatientId,
            JSON.stringify(updatedObs),
            input.context.workspaceId,
            input.context.epoch,
            rec.ingestion_record_id,
          )
        }

        const completeBatchRows = z.array(z.object({ batch_id: z.string().min(1) }).strict()).parse(
          this.#database.driver.prepare(`
            SELECT DISTINCT r.batch_id
            FROM local_ingestion_record AS r
            JOIN local_ingestion_batch AS b
              ON b.workspace_id = r.workspace_id
             AND b.epoch = r.epoch
             AND b.batch_id = r.batch_id
            WHERE r.workspace_id = ? AND r.epoch = ? AND r.candidate_id = ? AND b.status = 'complete'
            ORDER BY r.batch_id ASC
          `).all(input.context.workspaceId, input.context.epoch, input.candidateId),
        )
        const projectedEffects = completeBatchRows.flatMap(batchRow => (
          this.#projectBatchRecordsToFhir(input.context, batchRow.batch_id, targetPatientId)
        ))

        const updatedRow = quarantineRowSchema.parse(
          this.#database.driver.prepare(`
            SELECT candidate_id, batch_id, source_system_id, external_patient_id, target_patient_id,
                   confidence_score, threshold, decision, resolution_status, mismatch_reasons_json,
                   patient_payload_json, resolved_by_actor_id, resolved_by_practitioner_id,
                   resolved_at, note, created_at
            FROM local_ingestion_quarantine
            WHERE workspace_id = ? AND epoch = ? AND candidate_id = ?
          `).get(input.context.workspaceId, input.context.epoch, input.candidateId),
        )

        const releasedCountRow = z.object({ total: z.number().int() }).parse(
          this.#database.driver.prepare(`
            SELECT COUNT(*) AS total
            FROM local_ingestion_record AS r
            JOIN local_ingestion_batch AS b
              ON b.workspace_id = r.workspace_id
             AND b.epoch = r.epoch
             AND b.batch_id = r.batch_id
            WHERE r.workspace_id = ? AND r.epoch = ? AND r.candidate_id = ? AND b.status = 'complete'
          `).get(input.context.workspaceId, input.context.epoch, input.candidateId),
        )

        return {
          data: {
            candidate: mapQuarantineRow(updatedRow),
            releasedObservationCount: releasedCountRow.total,
          },
          effects: [
            {
              kind: 'updated',
              reference: `IdentityQuarantine/${input.candidateId}`,
              versionId: '2',
            },
            ...projectedEffects,
          ],
        }
      }

      this.#database.driver.prepare(`
        UPDATE local_ingestion_quarantine
        SET target_patient_id = NULL,
            resolution_status = 'rejected-distinct',
            resolved_by_actor_id = ?,
            resolved_by_practitioner_id = ?,
            resolved_at = ?,
            note = ?
        WHERE workspace_id = ? AND epoch = ? AND candidate_id = ?
      `).run(
        input.context.actorId,
        input.context.practitionerId ?? null,
        resolvedAt,
        parsedBody.auditNote,
        input.context.workspaceId,
        input.context.epoch,
        input.candidateId,
      )

      this.#database.driver.prepare(`
        UPDATE local_ingestion_record
        SET patient_id = NULL
        WHERE workspace_id = ? AND epoch = ? AND candidate_id = ?
      `).run(input.context.workspaceId, input.context.epoch, input.candidateId)

      const updatedRow = quarantineRowSchema.parse(
        this.#database.driver.prepare(`
          SELECT candidate_id, batch_id, source_system_id, external_patient_id, target_patient_id,
                 confidence_score, threshold, decision, resolution_status, mismatch_reasons_json,
                 patient_payload_json, resolved_by_actor_id, resolved_by_practitioner_id,
                 resolved_at, note, created_at
          FROM local_ingestion_quarantine
          WHERE workspace_id = ? AND epoch = ? AND candidate_id = ?
        `).get(input.context.workspaceId, input.context.epoch, input.candidateId),
      )

      return {
        data: {
          candidate: mapQuarantineRow(updatedRow),
          releasedObservationCount: 0,
        },
        effects: [
          {
            kind: 'updated',
            reference: `IdentityQuarantine/${input.candidateId}`,
            versionId: '2',
          },
        ],
      }
    })
  }

  #loadLocalPatientIndex(context: RepositoryContext): LocalPatientIndexEntry[] {
    const patientRows = z.array(fhirPatientRowSchema).parse(
      this.#database.driver.prepare(`
        SELECT resource_id AS id, content_json
        FROM fhir_resource
        WHERE workspace_id = ? AND epoch = ? AND resource_type = 'Patient'
        ORDER BY resource_id ASC
      `).all(context.workspaceId, context.epoch),
    )

    const linkedRows = z.array(linkedExternalIdRowSchema).parse(
      this.#database.driver.prepare(`
        SELECT DISTINCT source_system_id, external_patient_id, target_patient_id
        FROM local_ingestion_quarantine
        WHERE workspace_id = ? AND epoch = ?
          AND resolution_status IN ('auto-matched', 'confirmed-merged')
          AND target_patient_id IS NOT NULL
      `).all(context.workspaceId, context.epoch),
    )

    const linksByPatient = new Map<string, Array<{ sourceSystemId: string; externalPatientId: string }>>()
    for (const link of linkedRows) {
      const list = linksByPatient.get(link.target_patient_id)
      const entry = {
        sourceSystemId: link.source_system_id,
        externalPatientId: link.external_patient_id,
      }
      if (list) list.push(entry)
      else linksByPatient.set(link.target_patient_id, [entry])
    }

    const entries: LocalPatientIndexEntry[] = []
    for (const row of patientRows) {
      const demographics = extractPatientDemographics(JSON.parse(row.content_json))
      if (!demographics.fullName || !demographics.birthDate) continue
      entries.push({
        localPatientId: row.id,
        fullName: demographics.fullName,
        birthDate: demographics.birthDate,
        nationalId: demographics.nationalId,
        phone: demographics.phone,
        linkedExternalIds: linksByPatient.get(row.id) ?? [],
      })
    }
    return entries
  }

  #hasFhirResource(context: RepositoryContext, resourceType: string, resourceId: string): boolean {
    try {
      this.#fhir.read(context, resourceType, resourceId)
      return true
    } catch (error) {
      if (error instanceof FhirRepositoryError && error.code === 'NOT_FOUND') return false
      throw error
    }
  }

  #projectBatchRecordsToFhir(
    context: RepositoryContext,
    batchId: string,
    targetPatientId: string,
  ): Array<{ kind: 'created' | 'updated'; reference: string; versionId: string }> {
    const rows = z.array(ingestionRecordProjectRowSchema).parse(
      this.#database.driver.prepare(`
        SELECT ingestion_record_id, source_system_id, fhir_observation_json, provenance_json
        FROM local_ingestion_record
        WHERE workspace_id = ? AND epoch = ? AND batch_id = ?
        ORDER BY rowid ASC
      `).all(context.workspaceId, context.epoch, batchId),
    )

    const effects: Array<{ kind: 'created' | 'updated'; reference: string; versionId: string }> = []
    for (const row of rows) {
      const parsedObs = fhirResourceSchema.parse(JSON.parse(row.fhir_observation_json))
      const parsedProv = fhirResourceSchema.parse(JSON.parse(row.provenance_json))
      if (this.#hasFhirResource(context, 'Provenance', parsedProv.id)) {
        continue
      }

      const rawBasedOn = parsedObs['basedOn']
      const sanitizedBasedOn = Array.isArray(rawBasedOn)
        ? z.array(basedOnEntrySchema).parse(rawBasedOn).map(entry => {
            if (typeof entry.reference === 'string' && entry.reference.startsWith('ServiceRequest/')) {
              const srId = entry.reference.slice('ServiceRequest/'.length)
              if (!this.#hasFhirResource(context, 'ServiceRequest', srId)) {
                return {
                  display: srId,
                  identifier: {
                    system: `urn:clinmesh:local-source:${row.source_system_id}:order`,
                    value: srId,
                  },
                }
              }
            }
            return entry
          })
        : undefined

      const obsForFhir = fhirResourceSchema.parse({
        ...parsedObs,
        subject: { reference: `Patient/${targetPatientId}` },
        ...(sanitizedBasedOn !== undefined ? { basedOn: sanitizedBasedOn } : {}),
      })

      let existingObsVersion: string | undefined
      try {
        existingObsVersion = this.#fhir.read(context, 'Observation', obsForFhir.id).meta?.versionId
      } catch (error) {
        if (!(error instanceof FhirRepositoryError && error.code === 'NOT_FOUND')) throw error
      }

      const committedObs = existingObsVersion === undefined
        ? this.#fhir.create(context, obsForFhir)
        : this.#fhir.update(context, obsForFhir, existingObsVersion)
      effects.push({
        kind: existingObsVersion === undefined ? 'created' : 'updated',
        reference: `Observation/${committedObs.id}`,
        versionId: committedObs.meta?.versionId ?? '1',
      })

      const committedProv = this.#fhir.createImmutable(context, parsedProv)
      effects.push({
        kind: 'created',
        reference: `Provenance/${committedProv.id}`,
        versionId: committedProv.meta?.versionId ?? '1',
      })
    }
    return effects
  }
}
