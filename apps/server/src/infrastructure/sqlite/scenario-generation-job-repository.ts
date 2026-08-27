import {
  scenarioDatasetSchema,
  scenarioGenerationJobSchema,
  scenarioGenerationRequestSchema,
  type ScenarioDataset,
  type ScenarioGenerationJob,
} from '@clinmesh/contracts/scenario'
import { z } from 'zod'
import type { ActorContext } from '../../application/command-executor.ts'
import type { ClinMeshDatabase } from './database.ts'

const scenarioGenerationJobRowSchema = z.object({
  actor_context_json: z.string(),
  created_at: z.iso.datetime({ offset: true }),
  created_by_actor_id: z.string().min(1),
  dataset_id: z.string().min(1).nullable(),
  error_code: z.string().min(1).nullable(),
  error_message: z.string().min(1).nullable(),
  finished_at: z.iso.datetime({ offset: true }).nullable(),
  job_id: z.string().min(1),
  request_json: z.string(),
  started_at: z.iso.datetime({ offset: true }).nullable(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  updated_at: z.iso.datetime({ offset: true }),
  workspace_id: z.string().min(1),
}).strict()

type ScenarioGenerationJobRow = z.infer<typeof scenarioGenerationJobRowSchema>

const selectJob = `
  SELECT workspace_id, job_id, request_json, status,
    result_dataset_id AS dataset_id, actor_context_json,
    error_code, error_message, created_by_actor_id, created_at, started_at,
    finished_at, updated_at
  FROM scenario_generation_job
`

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

function parseActorContext(value: unknown): ActorContext {
  const context = actorContextSchema.parse(value)
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

export interface ClaimedScenarioGenerationJob extends ScenarioGenerationJob {
  actorContext: ActorContext
  createdByActorId: string
  status: 'running'
}

function publicJob(job: ClaimedScenarioGenerationJob): ScenarioGenerationJob {
  return {
    createdAt: job.createdAt,
    datasetId: job.datasetId,
    error: job.error,
    finishedAt: job.finishedAt,
    jobId: job.jobId,
    request: job.request,
    startedAt: job.startedAt,
    status: job.status,
    updatedAt: job.updatedAt,
    workspaceId: job.workspaceId,
  }
}

export class ScenarioGenerationJobRepository {
  readonly #database: ClinMeshDatabase

  constructor(database: ClinMeshDatabase) {
    this.#database = database
  }

  create(job: ScenarioGenerationJob, context: ActorContext): void {
    const actorContext = parseActorContext(context)
    if (actorContext.workspaceId !== job.workspaceId) {
      throw new Error('Scenario generation job Actor Context belongs to another Workspace')
    }
    this.#database.driver.prepare(`
      INSERT INTO scenario_generation_job (
        workspace_id, job_id, request_json, status,
        result_dataset_id, dataset_workspace_id, dataset_id,
        error_code, error_message, created_by_actor_id, actor_context_json,
        created_at, started_at, finished_at, updated_at
      ) VALUES (?, ?, ?, 'queued', NULL, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, NULL, ?)
    `).run(
      job.workspaceId,
      job.jobId,
      JSON.stringify(job.request),
      context.actorId,
      JSON.stringify(actorContext),
      job.createdAt,
      job.updatedAt,
    )
  }

  get(workspaceId: string, jobId: string): ScenarioGenerationJob | undefined {
    const result = this.#database.driver.prepare(`${selectJob}
      WHERE workspace_id = ? AND job_id = ?
    `).get(workspaceId, jobId)
    return result === undefined ? undefined : this.#map(scenarioGenerationJobRowSchema.parse(result))
  }

  requeueInterrupted(now: string): number {
    return this.#database.driver.prepare(`
      UPDATE scenario_generation_job
      SET status = 'queued', started_at = NULL, updated_at = ?
      WHERE status = 'running'
    `).run(now).changes
  }

  claimNext(now: string): ClaimedScenarioGenerationJob | undefined {
    const claim = this.#database.driver.transaction(() => {
      const result = this.#database.driver.prepare(`${selectJob}
        WHERE status = 'queued'
        ORDER BY created_at, job_id
        LIMIT 1
      `).get()
      if (result === undefined) return undefined
      const candidate = scenarioGenerationJobRowSchema.parse(result)
      const update = this.#database.driver.prepare(`
        UPDATE scenario_generation_job
        SET status = 'running', started_at = ?, updated_at = ?
        WHERE workspace_id = ? AND job_id = ? AND status = 'queued'
      `).run(now, now, candidate.workspace_id, candidate.job_id)
      if (update.changes !== 1) return undefined
      return {
        ...this.#map({
          ...candidate,
          started_at: now,
          status: 'running',
          updated_at: now,
        }),
        actorContext: parseActorContext(JSON.parse(candidate.actor_context_json)),
        createdByActorId: candidate.created_by_actor_id,
        status: 'running' as const,
      }
    })
    return claim()
  }

  completeWithDataset(
    job: ClaimedScenarioGenerationJob,
    dataset: ScenarioDataset,
    now: string,
  ): ScenarioGenerationJob {
    scenarioDatasetSchema.parse(dataset)
    const completed = scenarioGenerationJobSchema.parse({
      ...publicJob(job),
      datasetId: dataset.datasetId,
      error: null,
      finishedAt: now,
      status: 'succeeded',
      updatedAt: now,
    })
    const complete = this.#database.driver.transaction(() => {
      this.#database.driver.prepare(`
        INSERT INTO scenario_dataset (
          workspace_id, dataset_id, name, provider_id, version, content_json,
          content_hash, diagnostics_json, created_by_actor_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        dataset.workspaceId,
        dataset.datasetId,
        dataset.name,
        dataset.providerId,
        dataset.version,
        JSON.stringify(dataset.content),
        dataset.contentHash,
        JSON.stringify(dataset.diagnostics),
        job.createdByActorId,
        dataset.createdAt,
        dataset.updatedAt,
      )
      const update = this.#database.driver.prepare(`
        UPDATE scenario_generation_job
        SET status = 'succeeded', result_dataset_id = ?,
          dataset_workspace_id = ?, dataset_id = ?, finished_at = ?, updated_at = ?
        WHERE workspace_id = ? AND job_id = ? AND status = 'running'
      `).run(
        dataset.datasetId,
        dataset.workspaceId,
        dataset.datasetId,
        now,
        now,
        job.workspaceId,
        job.jobId,
      )
      if (update.changes !== 1) throw new Error('The Scenario generation job is no longer running')
    })
    complete()
    return completed
  }

  fail(
    job: ClaimedScenarioGenerationJob,
    error: { code: string; message: string },
    now: string,
  ): ScenarioGenerationJob {
    const failed = scenarioGenerationJobSchema.parse({
      ...publicJob(job),
      error,
      finishedAt: now,
      status: 'failed',
      updatedAt: now,
    })
    const update = this.#database.driver.prepare(`
      UPDATE scenario_generation_job
      SET status = 'failed', error_code = ?, error_message = ?, finished_at = ?, updated_at = ?
      WHERE workspace_id = ? AND job_id = ? AND status = 'running'
    `).run(error.code, error.message, now, now, job.workspaceId, job.jobId)
    if (update.changes !== 1) throw new Error('The Scenario generation job is no longer running')
    return failed
  }

  requeue(job: ClaimedScenarioGenerationJob, now: string): ScenarioGenerationJob {
    const queued = scenarioGenerationJobSchema.parse({
      ...publicJob(job),
      startedAt: null,
      status: 'queued',
      updatedAt: now,
    })
    const update = this.#database.driver.prepare(`
      UPDATE scenario_generation_job
      SET status = 'queued', started_at = NULL, updated_at = ?
      WHERE workspace_id = ? AND job_id = ? AND status = 'running'
    `).run(now, job.workspaceId, job.jobId)
    if (update.changes !== 1) throw new Error('The Scenario generation job is no longer running')
    return queued
  }

  #map(row: ScenarioGenerationJobRow): ScenarioGenerationJob {
    return scenarioGenerationJobSchema.parse({
      createdAt: row.created_at,
      datasetId: row.dataset_id,
      error: row.error_code === null || row.error_message === null
        ? null
        : { code: row.error_code, message: row.error_message },
      finishedAt: row.finished_at,
      jobId: row.job_id,
      request: scenarioGenerationRequestSchema.parse(JSON.parse(row.request_json)),
      startedAt: row.started_at,
      status: row.status,
      updatedAt: row.updated_at,
      workspaceId: row.workspace_id,
    })
  }
}
