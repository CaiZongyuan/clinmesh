import {
  laboratoryServicePublicationJobSchema,
  type LaboratoryServicePublicationJob,
} from '@clinmesh/contracts/his'
import { z } from 'zod'
import type { ActorContext } from '../../application/command-executor.ts'
import type { ClinMeshDatabase } from './database.ts'

const actorContextSchema = z.object({
  actorId: z.string().min(1),
  epoch: z.string().min(1),
  locationId: z.string().min(1).optional(),
  organizationId: z.string().min(1).optional(),
  practitionerId: z.string().min(1).optional(),
  practitionerRoleId: z.string().min(1).optional(),
  roleCode: z.string().min(1),
  scenarioRunId: z.string().min(1),
  workspaceId: z.string().min(1),
}).strict()

const jobRowSchema = z.object({
  actor_context_json: z.string(),
  concept_ids_json: z.string(),
  created_at: z.iso.datetime({ offset: true }),
  created_by_actor_id: z.string().min(1),
  epoch: z.string().min(1),
  error_code: z.string().min(1).nullable(),
  error_message: z.string().min(1).nullable(),
  finished_at: z.iso.datetime({ offset: true }).nullable(),
  job_id: z.string().min(1),
  model_id: z.string().min(1),
  published_service_ids_json: z.string(),
  reference_release_id: z.string().min(1),
  started_at: z.iso.datetime({ offset: true }).nullable(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  updated_at: z.iso.datetime({ offset: true }),
  workspace_id: z.string().min(1),
}).strict()

const candidateRowSchema = z.object({
  concept_id: z.string().min(1),
  error_code: z.string().min(1).nullable(),
  error_message: z.string().min(1).nullable(),
  published_service_id: z.string().min(1).nullable(),
  status: z.enum(['publishing', 'published', 'failed']),
  version: z.number().int().positive(),
}).strict()

const selectJob = `
  SELECT workspace_id, epoch, job_id, reference_release_id, concept_ids_json,
    status, model_id, actor_context_json, created_by_actor_id,
    published_service_ids_json, error_code, error_message,
    created_at, started_at, finished_at, updated_at
  FROM laboratory_service_publication_job
`

function parseActorContext(value: string): ActorContext {
  const context = actorContextSchema.parse(JSON.parse(value))
  return {
    actorId: context.actorId,
    epoch: context.epoch,
    roleCode: context.roleCode,
    scenarioRunId: context.scenarioRunId,
    workspaceId: context.workspaceId,
    ...(context.locationId === undefined ? {} : { locationId: context.locationId }),
    ...(context.organizationId === undefined ? {} : { organizationId: context.organizationId }),
    ...(context.practitionerId === undefined ? {} : { practitionerId: context.practitionerId }),
    ...(context.practitionerRoleId === undefined
      ? {}
      : { practitionerRoleId: context.practitionerRoleId }),
  }
}

export interface ClaimedLaboratoryServicePublicationJob extends LaboratoryServicePublicationJob {
  actorContext: ActorContext
  epoch: string
  model: string
  status: 'running'
}

export interface LaboratoryServicePublicationCandidateState {
  conceptId: string
  error: { code: string; message: string } | null
  publishedServiceId: string | null
  status: 'failed' | 'published' | 'publishing'
  version: number
}

export class LaboratoryServicePublicationVersionError extends Error {
  constructor() {
    super('Laboratory Service candidate version changed')
    this.name = 'LaboratoryServicePublicationVersionError'
  }
}

export class LaboratoryServicePublicationRepository {
  readonly #database: ClinMeshDatabase

  constructor(database: ClinMeshDatabase) {
    this.#database = database
  }

  create(
    job: LaboratoryServicePublicationJob,
    entries: readonly { conceptId: string; expectedVersion: number }[],
    context: ActorContext,
    model: string,
  ): void {
    const parsed = laboratoryServicePublicationJobSchema.parse(job)
    this.#database.driver.prepare(`
      INSERT INTO laboratory_service_publication_job (
        workspace_id, epoch, job_id, reference_release_id, concept_ids_json,
        status, model_id, actor_context_json, created_by_actor_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
    `).run(
      parsed.workspaceId,
      context.epoch,
      parsed.jobId,
      parsed.referenceReleaseId,
      JSON.stringify(parsed.conceptIds),
      model,
      JSON.stringify(actorContextSchema.parse(context)),
      context.actorId,
      parsed.createdAt,
      parsed.updatedAt,
    )
    const lookup = this.#database.driver.prepare(`
      SELECT version FROM laboratory_service_publication_candidate
      WHERE workspace_id = ? AND epoch = ? AND reference_release_id = ? AND concept_id = ?
    `)
    const insert = this.#database.driver.prepare(`
      INSERT INTO laboratory_service_publication_candidate (
        workspace_id, epoch, reference_release_id, concept_id,
        status, version, job_id, updated_at
      ) VALUES (?, ?, ?, ?, 'publishing', 1, ?, ?)
    `)
    const update = this.#database.driver.prepare(`
      UPDATE laboratory_service_publication_candidate
      SET status = 'publishing', version = version + 1, job_id = ?,
        published_service_id = NULL, error_code = NULL, error_message = NULL,
        updated_at = ?
      WHERE workspace_id = ? AND epoch = ? AND reference_release_id = ?
        AND concept_id = ? AND version = ?
    `)
    for (const entry of entries) {
      const current = z.object({ version: z.number().int().positive() }).optional().parse(
        lookup.get(
          parsed.workspaceId,
          context.epoch,
          parsed.referenceReleaseId,
          entry.conceptId,
        ),
      )
      if (current === undefined) {
        if (entry.expectedVersion !== 0) throw new LaboratoryServicePublicationVersionError()
        insert.run(
          parsed.workspaceId,
          context.epoch,
          parsed.referenceReleaseId,
          entry.conceptId,
          parsed.jobId,
          parsed.updatedAt,
        )
        continue
      }
      const changed = update.run(
        parsed.jobId,
        parsed.updatedAt,
        parsed.workspaceId,
        context.epoch,
        parsed.referenceReleaseId,
        entry.conceptId,
        entry.expectedVersion,
      )
      if (changed.changes !== 1) throw new LaboratoryServicePublicationVersionError()
    }
  }

  get(workspaceId: string, epoch: string, jobId: string): LaboratoryServicePublicationJob | undefined {
    const row = this.#database.driver.prepare(`${selectJob}
      WHERE workspace_id = ? AND epoch = ? AND job_id = ?
    `).get(workspaceId, epoch, jobId)
    return row === undefined ? undefined : this.#publicJob(jobRowSchema.parse(row))
  }

  candidateStates(
    workspaceId: string,
    epoch: string,
    referenceReleaseId: string,
    conceptIds: readonly string[],
  ): Map<string, LaboratoryServicePublicationCandidateState> {
    if (conceptIds.length === 0) return new Map()
    const rows = z.array(candidateRowSchema).parse(this.#database.driver.prepare(`
      SELECT concept_id, status, version, published_service_id, error_code, error_message
      FROM laboratory_service_publication_candidate
      WHERE workspace_id = ? AND epoch = ? AND reference_release_id = ?
        AND concept_id IN (${conceptIds.map(() => '?').join(', ')})
    `).all(workspaceId, epoch, referenceReleaseId, ...conceptIds))
    return new Map(rows.map(row => [row.concept_id, {
      conceptId: row.concept_id,
      error: row.error_code === null || row.error_message === null
        ? null
        : { code: row.error_code, message: row.error_message },
      publishedServiceId: row.published_service_id,
      status: row.status,
      version: row.version,
    }]))
  }

  requeueInterrupted(now: string): number {
    const jobs = this.#database.driver.prepare(`
      UPDATE laboratory_service_publication_job
      SET status = 'queued', started_at = NULL, updated_at = ?
      WHERE status = 'running'
    `).run(now).changes
    this.#database.driver.prepare(`
      UPDATE laboratory_service_publication_candidate
      SET status = 'publishing', updated_at = ?
      WHERE job_id IN (
        SELECT job_id FROM laboratory_service_publication_job WHERE status = 'queued'
      )
    `).run(now)
    return jobs
  }

  claimNext(now: string): ClaimedLaboratoryServicePublicationJob | undefined {
    return this.#database.driver.transaction(() => {
      const row = this.#database.driver.prepare(`${selectJob}
        WHERE status = 'queued'
        ORDER BY created_at, job_id
        LIMIT 1
      `).get()
      if (row === undefined) return undefined
      const candidate = jobRowSchema.parse(row)
      const update = this.#database.driver.prepare(`
        UPDATE laboratory_service_publication_job
        SET status = 'running', started_at = ?, updated_at = ?
        WHERE workspace_id = ? AND epoch = ? AND job_id = ? AND status = 'queued'
      `).run(now, now, candidate.workspace_id, candidate.epoch, candidate.job_id)
      if (update.changes !== 1) return undefined
      const job = this.#publicJob({
        ...candidate,
        started_at: now,
        status: 'running',
        updated_at: now,
      })
      return {
        ...job,
        actorContext: parseActorContext(candidate.actor_context_json),
        epoch: candidate.epoch,
        model: candidate.model_id,
        status: 'running' as const,
      }
    })()
  }

  requeue(
    job: ClaimedLaboratoryServicePublicationJob,
    now: string,
  ): LaboratoryServicePublicationJob {
    const update = this.#database.driver.prepare(`
      UPDATE laboratory_service_publication_job
      SET status = 'queued', started_at = NULL, updated_at = ?
      WHERE workspace_id = ? AND epoch = ? AND job_id = ? AND status = 'running'
    `).run(now, job.workspaceId, job.epoch, job.jobId)
    if (update.changes !== 1) throw new Error('Laboratory Service publication job changed')
    this.#database.driver.prepare(`
      UPDATE laboratory_service_publication_candidate
      SET status = 'publishing', updated_at = ?
      WHERE workspace_id = ? AND epoch = ? AND reference_release_id = ?
        AND job_id = ?
    `).run(now, job.workspaceId, job.epoch, job.referenceReleaseId, job.jobId)
    return this.get(job.workspaceId, job.epoch, job.jobId)!
  }

  succeed(
    job: ClaimedLaboratoryServicePublicationJob,
    publishedServiceIds: string[],
    rootServiceIds: ReadonlyMap<string, string>,
    now: string,
  ): LaboratoryServicePublicationJob {
    const jobUpdate = this.#database.driver.prepare(`
      UPDATE laboratory_service_publication_job
      SET status = 'succeeded', published_service_ids_json = ?,
        error_code = NULL, error_message = NULL, finished_at = ?, updated_at = ?
      WHERE workspace_id = ? AND epoch = ? AND job_id = ? AND status = 'running'
    `).run(
      JSON.stringify(publishedServiceIds),
      now,
      now,
      job.workspaceId,
      job.epoch,
      job.jobId,
    )
    if (jobUpdate.changes !== 1) throw new Error('Laboratory Service publication job changed')
    const updateCandidate = this.#database.driver.prepare(`
      UPDATE laboratory_service_publication_candidate
      SET status = 'published', published_service_id = ?,
        error_code = NULL, error_message = NULL, updated_at = ?
      WHERE workspace_id = ? AND epoch = ? AND reference_release_id = ?
        AND concept_id = ? AND job_id = ? AND status = 'publishing'
    `)
    for (const conceptId of job.conceptIds) {
      const serviceId = rootServiceIds.get(conceptId)
      if (serviceId === undefined) throw new Error('Published root Laboratory Service is missing')
      const updated = updateCandidate.run(
        serviceId,
        now,
        job.workspaceId,
        job.epoch,
        job.referenceReleaseId,
        conceptId,
        job.jobId,
      )
      if (updated.changes !== 1) throw new Error('Laboratory Service candidate changed')
    }
    return this.get(job.workspaceId, job.epoch, job.jobId)!
  }

  fail(
    job: ClaimedLaboratoryServicePublicationJob,
    error: { code: string; message: string },
    now: string,
  ): LaboratoryServicePublicationJob {
    const jobUpdate = this.#database.driver.prepare(`
      UPDATE laboratory_service_publication_job
      SET status = 'failed', error_code = ?, error_message = ?,
        finished_at = ?, updated_at = ?
      WHERE workspace_id = ? AND epoch = ? AND job_id = ? AND status = 'running'
    `).run(error.code, error.message, now, now, job.workspaceId, job.epoch, job.jobId)
    if (jobUpdate.changes !== 1) throw new Error('Laboratory Service publication job changed')
    this.#database.driver.prepare(`
      UPDATE laboratory_service_publication_candidate
      SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?
      WHERE workspace_id = ? AND epoch = ? AND reference_release_id = ?
        AND job_id = ? AND status = 'publishing'
    `).run(
      error.code,
      error.message,
      now,
      job.workspaceId,
      job.epoch,
      job.referenceReleaseId,
      job.jobId,
    )
    return this.get(job.workspaceId, job.epoch, job.jobId)!
  }

  #publicJob(row: z.infer<typeof jobRowSchema>): LaboratoryServicePublicationJob {
    return laboratoryServicePublicationJobSchema.parse({
      conceptIds: JSON.parse(row.concept_ids_json),
      createdAt: row.created_at,
      error: row.error_code === null || row.error_message === null
        ? null
        : { code: row.error_code, message: row.error_message },
      finishedAt: row.finished_at,
      jobId: row.job_id,
      publishedServiceIds: JSON.parse(row.published_service_ids_json),
      referenceReleaseId: row.reference_release_id,
      startedAt: row.started_at,
      status: row.status,
      updatedAt: row.updated_at,
      workspaceId: row.workspace_id,
    })
  }
}
