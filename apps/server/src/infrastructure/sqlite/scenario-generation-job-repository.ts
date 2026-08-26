import {
  scenarioDatasetSchema,
  scenarioGenerationJobSchema,
  scenarioGenerationRequestSchema,
  type ScenarioDataset,
  type ScenarioGenerationJob,
} from '@clinmesh/contracts/scenario'
import type { ClinMeshDatabase } from './database.ts'

interface ScenarioGenerationJobRow {
  created_at: string
  created_by_actor_id: string
  dataset_id: string | null
  error_code: string | null
  error_message: string | null
  finished_at: string | null
  job_id: string
  request_json: string
  started_at: string | null
  status: ScenarioGenerationJob['status']
  updated_at: string
  workspace_id: string
}

const selectJob = `
  SELECT workspace_id, job_id, request_json, status, dataset_id,
    error_code, error_message, created_by_actor_id, created_at, started_at,
    finished_at, updated_at
  FROM scenario_generation_job
`

export interface ClaimedScenarioGenerationJob extends ScenarioGenerationJob {
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

  create(job: ScenarioGenerationJob, actorId: string): void {
    this.#database.driver.prepare(`
      INSERT INTO scenario_generation_job (
        workspace_id, job_id, request_json, status,
        dataset_id, error_code, error_message, created_by_actor_id, created_at,
        started_at, finished_at, updated_at
      ) VALUES (?, ?, ?, 'queued', NULL, NULL, NULL, ?, ?, NULL, NULL, ?)
    `).run(
      job.workspaceId,
      job.jobId,
      JSON.stringify(job.request),
      actorId,
      job.createdAt,
      job.updatedAt,
    )
  }

  get(workspaceId: string, jobId: string): ScenarioGenerationJob | undefined {
    const row = this.#database.driver.prepare(`${selectJob}
      WHERE workspace_id = ? AND job_id = ?
    `).get(workspaceId, jobId) as ScenarioGenerationJobRow | undefined
    return row === undefined ? undefined : this.#map(row)
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
      const candidate = this.#database.driver.prepare(`${selectJob}
        WHERE status = 'queued'
        ORDER BY created_at, job_id
        LIMIT 1
      `).get() as ScenarioGenerationJobRow | undefined
      if (candidate === undefined) return undefined
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
        SET status = 'succeeded', dataset_id = ?, finished_at = ?, updated_at = ?
        WHERE workspace_id = ? AND job_id = ? AND status = 'running'
      `).run(dataset.datasetId, now, now, job.workspaceId, job.jobId)
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
