import { createHash } from 'node:crypto'
import {
  syntheticCaseInstanceSchema,
  syntheticCaseRegistrationListSchema,
  syntheticCaseRegistrationSummarySchema,
  syntheticPatientIdentitySchema,
  syntheticPatientProfileSchema,
  syntheticSourceHistoryListSchema,
  syntheticSourceResourceDetailSchema,
  type SyntheticCaseInstance,
  type SyntheticCaseRegistrationList,
  type SyntheticCaseRegistrationSummary,
  type SyntheticPatientProfile,
  type SyntheticSourceHistoryList,
  type SyntheticSourceResourceDetail,
} from '@clinmesh/contracts/scenario'
import { z } from 'zod'
import type { CompiledSyntheaIndexCase } from '../../application/scenario-data/synthea-index-case.ts'
import type { ClinMeshDatabase } from './database.ts'

const resourceSchema = z.object({
  id: z.string().min(1),
  resourceType: z.string().min(1),
}).passthrough()

const bundleSchema = z.object({
  entry: z.array(z.object({
    fullUrl: z.string().min(1).optional(),
    resource: resourceSchema,
  }).passthrough()).min(1),
  resourceType: z.literal('Bundle'),
  type: z.literal('collection'),
}).passthrough()

const compiledCaseSchema = z.object({
  caseType: z.enum(['follow-up', 'new-problem', 'preventive']),
  hiddenResourceReferences: z.array(z.string().min(1)),
  indexEncounterReference: z.string().min(1),
  visibleHistory: z.array(z.object({
    clinicalDate: z.iso.datetime({ offset: true }),
    resourceType: z.string().min(1),
    sourceReference: z.string().min(1),
    title: z.string().min(1),
  }).strict()),
  visibleResourceReferences: z.array(z.string().min(1)),
}).strict()

const caseRowSchema = z.object({
  active_brief_revision: z.number().int().positive().nullable(),
  case_id: z.string().min(1),
  case_type: z.enum(['new-problem', 'follow-up', 'preventive']),
  created_at: z.iso.datetime({ offset: true }),
  profile_id: z.string().min(1),
  profile_revision: z.number().int().positive(),
  revision: z.number().int().positive(),
  source_hash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['brief-pending', 'brief-ready', 'started', 'completed', 'retired']),
  updated_at: z.iso.datetime({ offset: true }),
  visible_history_count: z.number().int().nonnegative(),
  workspace_id: z.string().min(1),
}).strict()

const countRowSchema = z.object({ count: z.number().int().nonnegative() }).strict()

const registrationCaseRowSchema = z.object({
  active_brief_revision: z.number().int().positive(),
  case_id: z.string().min(1),
  case_type: z.enum(['new-problem', 'follow-up', 'preventive']),
  demographics_json: z.string(),
  identity_json: z.string(),
  profile_revision: z.number().int().positive(),
  revision: z.number().int().positive(),
}).strict()

const registrationCaseRevisionRowSchema = z.object({
  revision: z.number().int().positive(),
}).strict()

const registrationCaseColumns = `
  synthetic_case.case_id, synthetic_case.revision,
  synthetic_case.case_type, synthetic_case.profile_revision,
  synthetic_case.active_brief_revision,
  profile_revision.identity_json, profile_revision.demographics_json
`

const registrationCaseSource = `
  FROM synthetic_case_instance AS synthetic_case
  JOIN synthetic_patient_profile_revision AS profile_revision
    ON profile_revision.workspace_id = synthetic_case.workspace_id
   AND profile_revision.profile_id = synthetic_case.profile_id
   AND profile_revision.revision = synthetic_case.profile_revision
  JOIN patient_brief_revision AS active_brief
    ON active_brief.workspace_id = synthetic_case.workspace_id
   AND active_brief.case_id = synthetic_case.case_id
   AND active_brief.revision = synthetic_case.active_brief_revision
  WHERE synthetic_case.workspace_id = ?
    AND synthetic_case.status = 'brief-ready'
`

const historyRowSchema = z.object({
  clinical_date: z.iso.datetime({ offset: true }),
  resource_type: z.string().min(1),
  source_reference: z.string().min(1),
  title: z.string().min(1),
}).strict()

const visibleResourceRowSchema = z.object({
  resource_json: z.string().min(1),
  source_reference: z.string().min(1),
}).strict()

const truthRowSchema = z.object({
  hidden_resource_references_json: z.string().min(1),
  hidden_resources_json: z.string().min(1),
  index_encounter_reference: z.string().min(1),
  source_hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

const hiddenResourceSchema = z.object({
  resource: z.json(),
  sourceReference: z.string().min(1),
}).strict()

const syntheticCaseTruthSchema = z.object({
  hiddenResourceReferences: z.array(z.string().min(1)),
  hiddenResources: z.array(hiddenResourceSchema),
  indexEncounterReference: z.string().min(1),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export type SyntheticCaseTruth = z.infer<typeof syntheticCaseTruthSchema>

export class SyntheticCaseRepositoryError extends Error {
  readonly code: 'CASE_ALREADY_EXISTS' | 'CASE_SOURCE_INVALID'

  constructor(
    code: 'CASE_ALREADY_EXISTS' | 'CASE_SOURCE_INVALID',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SyntheticCaseRepositoryError'
    this.code = code
  }
}

const selectCase = `
  SELECT workspace_id, case_id, profile_id, profile_revision, revision,
    case_type, status, active_brief_revision, source_hash,
    visible_history_count, created_at, updated_at
  FROM synthetic_case_instance
`

function sourceReference(entry: z.infer<typeof bundleSchema>['entry'][number]): string {
  return entry.fullUrl ?? `${entry.resource.resourceType}/${entry.resource.id}`
}

function visibleHistoryItem(row: z.infer<typeof historyRowSchema>) {
  return {
    clinicalDate: row.clinical_date,
    resourceType: row.resource_type,
    sourceReference: row.source_reference,
    title: row.title,
  }
}

function registrationCaseSummary(
  row: z.infer<typeof registrationCaseRowSchema>,
): SyntheticCaseRegistrationSummary {
  const identity = syntheticPatientIdentitySchema.parse(JSON.parse(row.identity_json))
  const demographics = syntheticPatientProfileSchema.shape.demographics.parse(
    JSON.parse(row.demographics_json),
  )
  return syntheticCaseRegistrationSummarySchema.parse({
    activeBriefRevision: row.active_brief_revision,
    birthDate: demographics.birthDate,
    caseId: row.case_id,
    caseRevision: row.revision,
    caseType: row.case_type,
    gender: demographics.gender,
    mrn: identity.mrn,
    name: identity.displayName,
    profileRevision: row.profile_revision,
  })
}

function caseId(profile: SyntheticPatientProfile): string {
  const digest = createHash('sha256')
    .update(`${profile.workspaceId}:${profile.profileId}:${profile.revision}:${profile.source.hash}`)
    .digest('hex')
    .slice(0, 32)
  return `synthetic-case-${digest}`
}

export class SyntheticCaseRepository {
  readonly #database: ClinMeshDatabase

  constructor(database: ClinMeshDatabase) {
    this.#database = database
  }

  createFromProfile(input: {
    actorId: string
    compiled: CompiledSyntheaIndexCase
    profile: SyntheticPatientProfile
  }): SyntheticCaseInstance {
    const profile = syntheticPatientProfileSchema.parse(input.profile)
    const compiled = compiledCaseSchema.parse(input.compiled)
    const bundleResult = bundleSchema.safeParse(profile.source.raw)
    if (profile.source.format !== 'fhir-r4-bundle' || !bundleResult.success) {
      throw new SyntheticCaseRepositoryError(
        'CASE_SOURCE_INVALID',
        'A Synthetic Case requires an immutable Synthea R4 source Bundle',
      )
    }
    const entryByReference = new Map(bundleResult.data.entry.map(entry => (
      [sourceReference(entry), entry] as const
    )))
    const visibleReferences = new Set(compiled.visibleResourceReferences)
    const hiddenReferences = new Set(compiled.hiddenResourceReferences)
    if (
      !hiddenReferences.has(compiled.indexEncounterReference)
      || [...visibleReferences].some(reference => hiddenReferences.has(reference))
      || [...visibleReferences, ...hiddenReferences].some(reference => !entryByReference.has(reference))
      || compiled.visibleHistory.some(item => !visibleReferences.has(item.sourceReference))
    ) {
      throw new SyntheticCaseRepositoryError(
        'CASE_SOURCE_INVALID',
        'The compiled Synthetic Case manifests do not match the source Bundle',
      )
    }
    const created = syntheticCaseInstanceSchema.parse({
      activeBriefRevision: null,
      caseId: caseId(profile),
      caseType: compiled.caseType,
      createdAt: profile.createdAt,
      profileId: profile.profileId,
      profileRevision: profile.revision,
      revision: 1,
      sourceHash: profile.source.hash,
      status: 'brief-pending',
      updatedAt: profile.updatedAt,
      visibleHistoryCount: compiled.visibleHistory.length,
      workspaceId: profile.workspaceId,
    })
    const persist = this.#database.driver.transaction(() => {
      this.#database.driver.prepare(`
        INSERT INTO synthetic_case_instance (
          workspace_id, case_id, profile_id, profile_revision, revision,
          case_type, status, active_brief_revision, source_hash,
          visible_history_count, created_by_actor_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
      `).run(
        created.workspaceId,
        created.caseId,
        created.profileId,
        created.profileRevision,
        created.revision,
        created.caseType,
        created.status,
        created.sourceHash,
        created.visibleHistoryCount,
        input.actorId,
        created.createdAt,
        created.updatedAt,
      )
      const insertVisibleResource = this.#database.driver.prepare(`
        INSERT INTO synthetic_case_visible_resource (
          workspace_id, case_id, source_reference, resource_type, resource_json
        ) VALUES (?, ?, ?, ?, ?)
      `)
      for (const reference of compiled.visibleResourceReferences) {
        const entry = entryByReference.get(reference)!
        insertVisibleResource.run(
          created.workspaceId,
          created.caseId,
          reference,
          entry.resource.resourceType,
          JSON.stringify(entry.resource),
        )
      }
      const insertHistory = this.#database.driver.prepare(`
        INSERT INTO synthetic_case_visible_history (
          workspace_id, case_id, sequence, source_reference,
          resource_type, clinical_date, title
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      compiled.visibleHistory.forEach((item, sequence) => {
        insertHistory.run(
          created.workspaceId,
          created.caseId,
          sequence,
          item.sourceReference,
          item.resourceType,
          item.clinicalDate,
          item.title,
        )
      })
      const hiddenResources = compiled.hiddenResourceReferences.map(reference => ({
        resource: entryByReference.get(reference)!.resource,
        sourceReference: reference,
      }))
      this.#database.driver.prepare(`
        INSERT INTO synthetic_case_truth (
          workspace_id, case_id, index_encounter_reference,
          hidden_resource_references_json, hidden_resources_json,
          source_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        created.workspaceId,
        created.caseId,
        compiled.indexEncounterReference,
        JSON.stringify(compiled.hiddenResourceReferences),
        JSON.stringify(hiddenResources),
        created.sourceHash,
        created.createdAt,
      )
    })
    try {
      persist()
    } catch (error) {
      const existing = this.getByProfileRevision(
        profile.workspaceId,
        profile.profileId,
        profile.revision,
      )
      if (existing !== undefined) {
        throw new SyntheticCaseRepositoryError(
          'CASE_ALREADY_EXISTS',
          'The Synthetic Patient Profile Revision already owns a Case',
          { cause: error },
        )
      }
      throw error
    }
    return created
  }

  get(workspaceId: string, caseIdValue: string): SyntheticCaseInstance | undefined {
    const row = this.#database.driver.prepare(`${selectCase}
      WHERE workspace_id = ? AND case_id = ?
    `).get(workspaceId, caseIdValue)
    return row === undefined ? undefined : this.#mapCase(caseRowSchema.parse(row))
  }

  hasMaterialization(workspaceId: string, epoch: string, caseIdValue: string): boolean {
    return this.#database.driver.prepare(`
      SELECT 1 AS present
      FROM synthetic_case_materialization
      WHERE workspace_id = ? AND epoch = ? AND case_id = ?
      LIMIT 1
    `).get(workspaceId, epoch, caseIdValue) !== undefined
  }

  getByProfileRevision(
    workspaceId: string,
    profileId: string,
    profileRevision: number,
  ): SyntheticCaseInstance | undefined {
    const row = this.#database.driver.prepare(`${selectCase}
      WHERE workspace_id = ? AND profile_id = ? AND profile_revision = ?
    `).get(workspaceId, profileId, profileRevision)
    return row === undefined ? undefined : this.#mapCase(caseRowSchema.parse(row))
  }

  getByProfile(workspaceId: string, profileId: string): SyntheticCaseInstance | undefined {
    const row = this.#database.driver.prepare(`${selectCase}
      WHERE workspace_id = ? AND profile_id = ?
      ORDER BY profile_revision DESC, case_id
      LIMIT 1
    `).get(workspaceId, profileId)
    return row === undefined ? undefined : this.#mapCase(caseRowSchema.parse(row))
  }

  getRegistrationCandidateRevision(
    workspaceId: string,
    caseIdValue: string,
  ): number | undefined {
    const row = this.#database.driver.prepare(`
      SELECT synthetic_case.revision
      ${registrationCaseSource}
        AND synthetic_case.case_id = ?
    `).get(workspaceId, caseIdValue)
    return row === undefined ? undefined : registrationCaseRevisionRowSchema.parse(row).revision
  }

  listForRegistration(input: {
    page: number
    pageSize: number
    search?: string
    workspaceId: string
  }): SyntheticCaseRegistrationList {
    const query = input.search ?? null
    const filterBindings = [input.workspaceId, query, query, query] as const
    const fromAndFilter = `
      ${registrationCaseSource}
        AND (
          ? IS NULL
          OR instr(lower(json_extract(profile_revision.identity_json, '$.displayName')), lower(?)) > 0
          OR instr(lower(json_extract(profile_revision.identity_json, '$.mrn')), lower(?)) > 0
        )
    `
    const total = countRowSchema.parse(this.#database.driver.prepare(`
      SELECT COUNT(*) AS count
      ${fromAndFilter}
    `).get(...filterBindings)).count
    const rows = z.array(registrationCaseRowSchema).parse(this.#database.driver.prepare(`
      SELECT ${registrationCaseColumns}
      ${fromAndFilter}
      ORDER BY synthetic_case.updated_at DESC, synthetic_case.case_id
      LIMIT ? OFFSET ?
    `).all(
      ...filterBindings,
      input.pageSize,
      (input.page - 1) * input.pageSize,
    ))
    return syntheticCaseRegistrationListSchema.parse({
      items: rows.map(registrationCaseSummary),
      page: input.page,
      pageSize: input.pageSize,
      total,
    })
  }

  listVisibleHistory(input: {
    caseId: string
    page: number
    pageSize: number
    workspaceId: string
  }): SyntheticSourceHistoryList {
    const total = countRowSchema.parse(this.#database.driver.prepare(`
      SELECT COUNT(*) AS count
      FROM synthetic_case_visible_history
      WHERE workspace_id = ? AND case_id = ?
    `).get(input.workspaceId, input.caseId)).count
    const rows = z.array(historyRowSchema).parse(this.#database.driver.prepare(`
      SELECT source_reference, resource_type, clinical_date, title
      FROM synthetic_case_visible_history
      WHERE workspace_id = ? AND case_id = ?
      ORDER BY sequence
      LIMIT ? OFFSET ?
    `).all(
      input.workspaceId,
      input.caseId,
      input.pageSize,
      (input.page - 1) * input.pageSize,
    ))
    return syntheticSourceHistoryListSchema.parse({
      items: rows.map(visibleHistoryItem),
      page: input.page,
      pageSize: input.pageSize,
      total,
    })
  }

  listRecentVisibleHistory(input: {
    caseId: string
    limit: number
    workspaceId: string
  }): SyntheticSourceHistoryList['items'] {
    const rows = z.array(historyRowSchema).parse(this.#database.driver.prepare(`
      SELECT source_reference, resource_type, clinical_date, title
      FROM synthetic_case_visible_history
      WHERE workspace_id = ? AND case_id = ?
      ORDER BY sequence DESC
      LIMIT ?
    `).all(input.workspaceId, input.caseId, input.limit))
    return rows.toReversed().map(visibleHistoryItem)
  }

  getVisibleResource(
    workspaceId: string,
    caseIdValue: string,
    sourceReferenceValue: string,
  ): SyntheticSourceResourceDetail | undefined {
    const row = this.#database.driver.prepare(`
      SELECT source_reference, resource_json
      FROM synthetic_case_visible_resource
      WHERE workspace_id = ? AND case_id = ? AND source_reference = ?
    `).get(workspaceId, caseIdValue, sourceReferenceValue)
    if (row === undefined) return undefined
    const parsed = visibleResourceRowSchema.parse(row)
    return syntheticSourceResourceDetailSchema.parse({
      caseId: caseIdValue,
      resource: JSON.parse(parsed.resource_json),
      sourceKind: 'synthea-r4-external',
      sourceReference: parsed.source_reference,
    })
  }

  getTruthForSimulator(workspaceId: string, caseIdValue: string): SyntheticCaseTruth | undefined {
    const row = this.#database.driver.prepare(`
      SELECT index_encounter_reference, hidden_resource_references_json,
        hidden_resources_json, source_hash
      FROM synthetic_case_truth
      WHERE workspace_id = ? AND case_id = ?
    `).get(workspaceId, caseIdValue)
    if (row === undefined) return undefined
    const parsed = truthRowSchema.parse(row)
    return syntheticCaseTruthSchema.parse({
      hiddenResourceReferences: JSON.parse(parsed.hidden_resource_references_json),
      hiddenResources: JSON.parse(parsed.hidden_resources_json),
      indexEncounterReference: parsed.index_encounter_reference,
      sourceHash: parsed.source_hash,
    })
  }

  getVisibleResourcesForSimulator(
    workspaceId: string,
    caseIdValue: string,
  ): Array<{ resource: z.infer<typeof resourceSchema>; sourceReference: string }> {
    const rows = z.array(z.object({
      resource_json: z.string().min(1),
      source_reference: z.string().min(1),
    }).strict()).parse(this.#database.driver.prepare(`
      SELECT source_reference, resource_json
      FROM synthetic_case_visible_resource
      WHERE workspace_id = ? AND case_id = ?
      ORDER BY source_reference
    `).all(workspaceId, caseIdValue))
    return rows.map(row => ({
      resource: resourceSchema.parse(JSON.parse(row.resource_json)),
      sourceReference: row.source_reference,
    }))
  }

  #mapCase(row: z.infer<typeof caseRowSchema>): SyntheticCaseInstance {
    return syntheticCaseInstanceSchema.parse({
      activeBriefRevision: row.active_brief_revision,
      caseId: row.case_id,
      caseType: row.case_type,
      createdAt: row.created_at,
      profileId: row.profile_id,
      profileRevision: row.profile_revision,
      revision: row.revision,
      sourceHash: row.source_hash,
      status: row.status,
      updatedAt: row.updated_at,
      visibleHistoryCount: row.visible_history_count,
      workspaceId: row.workspace_id,
    })
  }
}
