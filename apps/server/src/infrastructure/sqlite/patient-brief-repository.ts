import {
  patientBriefJobSchema,
  patientBriefRevisionListSchema,
  patientBriefRevisionSchema,
  type PatientBriefContent,
  type PatientBriefJob,
  type PatientBriefRevision,
  type SyntheticCaseInstance,
} from '@clinmesh/contracts/scenario'
import { z } from 'zod'
import type { ActorContext } from '../../application/command-executor.ts'
import type { ClinMeshDatabase } from './database.ts'
import type { SyntheticCaseRepository } from './synthetic-case-repository.ts'

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
  case_id: z.string().min(1),
  created_at: z.iso.datetime({ offset: true }),
  created_by_actor_id: z.string().min(1),
  error_code: z.string().min(1).nullable(),
  error_message: z.string().min(1).nullable(),
  finished_at: z.iso.datetime({ offset: true }).nullable(),
  job_id: z.string().min(1),
  model_id: z.string().min(1),
  result_revision: z.number().int().positive().nullable(),
  started_at: z.iso.datetime({ offset: true }).nullable(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  updated_at: z.iso.datetime({ offset: true }),
  workspace_id: z.string().min(1),
}).strict()

const revisionRowSchema = z.object({
  case_id: z.string().min(1),
  content_json: z.string(),
  created_at: z.iso.datetime({ offset: true }),
  input_hash: z.string().regex(/^[a-f0-9]{64}$/),
  model_id: z.string().min(1),
  output_hash: z.string().regex(/^[a-f0-9]{64}$/),
  prompt_hash: z.string().regex(/^[a-f0-9]{64}$/),
  prompt_version: z.string().min(1),
  revision: z.number().int().positive(),
  workspace_id: z.string().min(1),
}).strict()

const selectJob = `
  SELECT workspace_id, job_id, case_id, status, model_id,
    actor_context_json, created_by_actor_id, result_revision,
    error_code, error_message, created_at, started_at, finished_at, updated_at
  FROM patient_brief_job
`

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

export interface ClaimedPatientBriefJob extends PatientBriefJob {
  actorContext: ActorContext
  createdByActorId: string
  model: string
  status: 'running'
}

export class PatientBriefRepository {
  readonly #cases: SyntheticCaseRepository
  readonly #database: ClinMeshDatabase

  constructor(database: ClinMeshDatabase, cases: SyntheticCaseRepository) {
    this.#cases = cases
    this.#database = database
  }

  create(job: PatientBriefJob, context: ActorContext, model: string): void {
    const parsed = patientBriefJobSchema.parse(job)
    this.#database.driver.prepare(`
      INSERT INTO patient_brief_job (
        workspace_id, job_id, case_id, status, model_id,
        actor_context_json, created_by_actor_id, created_at, updated_at
      ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)
    `).run(
      parsed.workspaceId,
      parsed.jobId,
      parsed.caseId,
      model,
      JSON.stringify(actorContextSchema.parse(context)),
      context.actorId,
      parsed.createdAt,
      parsed.updatedAt,
    )
  }

  get(workspaceId: string, jobId: string): PatientBriefJob | undefined {
    const row = this.#database.driver.prepare(`${selectJob}
      WHERE workspace_id = ? AND job_id = ?
    `).get(workspaceId, jobId)
    return row === undefined ? undefined : this.#publicJob(jobRowSchema.parse(row))
  }

  requeueInterrupted(now: string): number {
    return this.#database.driver.prepare(`
      UPDATE patient_brief_job
      SET status = 'queued', started_at = NULL, updated_at = ?
      WHERE status = 'running'
    `).run(now).changes
  }

  claimNext(now: string): ClaimedPatientBriefJob | undefined {
    return this.#database.driver.transaction(() => {
      const row = this.#database.driver.prepare(`${selectJob}
        WHERE status = 'queued'
        ORDER BY created_at, job_id
        LIMIT 1
      `).get()
      if (row === undefined) return undefined
      const candidate = jobRowSchema.parse(row)
      const updated = this.#database.driver.prepare(`
        UPDATE patient_brief_job
        SET status = 'running', started_at = ?, updated_at = ?
        WHERE workspace_id = ? AND job_id = ? AND status = 'queued'
      `).run(now, now, candidate.workspace_id, candidate.job_id)
      if (updated.changes !== 1) return undefined
      return {
        ...this.#publicJob({
          ...candidate,
          started_at: now,
          status: 'running',
          updated_at: now,
        }),
        actorContext: parseActorContext(JSON.parse(candidate.actor_context_json)),
        createdByActorId: candidate.created_by_actor_id,
        model: candidate.model_id,
        status: 'running' as const,
      }
    })()
  }

  succeed(
    job: ClaimedPatientBriefJob,
    input: {
      content: PatientBriefContent
      inputHash: string
      model: string
      outputHash: string
      promptHash: string
      promptVersion: string
    },
    now: string,
  ): { job: PatientBriefJob; revision: PatientBriefRevision; syntheticCase: SyntheticCaseInstance } {
    return this.#database.driver.transaction(() => {
      const nextRevision = z.object({ revision: z.number().int().positive() }).parse(
        this.#database.driver.prepare(`
          SELECT coalesce(MAX(revision), 0) + 1 AS revision
          FROM patient_brief_revision
          WHERE workspace_id = ? AND case_id = ?
        `).get(job.workspaceId, job.caseId),
      ).revision
      const revision = patientBriefRevisionSchema.parse({
        caseId: job.caseId,
        content: input.content,
        createdAt: now,
        inputHash: input.inputHash,
        model: input.model,
        outputHash: input.outputHash,
        promptHash: input.promptHash,
        promptVersion: input.promptVersion,
        revision: nextRevision,
        workspaceId: job.workspaceId,
      })
      this.#database.driver.prepare(`
        INSERT INTO patient_brief_revision (
          workspace_id, case_id, revision, content_json, model_id,
          prompt_version, prompt_hash, input_hash, output_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        revision.workspaceId,
        revision.caseId,
        revision.revision,
        JSON.stringify(revision.content),
        revision.model,
        revision.promptVersion,
        revision.promptHash,
        revision.inputHash,
        revision.outputHash,
        revision.createdAt,
      )
      const caseUpdate = this.#database.driver.prepare(`
        UPDATE synthetic_case_instance
        SET active_brief_revision = coalesce(active_brief_revision, ?),
          status = CASE WHEN status = 'brief-pending' THEN 'brief-ready' ELSE status END,
          revision = revision + 1, updated_at = ?
        WHERE workspace_id = ? AND case_id = ?
          AND status IN ('brief-pending', 'brief-ready')
      `).run(nextRevision, now, job.workspaceId, job.caseId)
      if (caseUpdate.changes !== 1) throw new Error('The Synthetic Case cannot accept a Brief')
      const jobUpdate = this.#database.driver.prepare(`
        UPDATE patient_brief_job
        SET status = 'succeeded', result_revision = ?, error_code = NULL,
          error_message = NULL, finished_at = ?, updated_at = ?
        WHERE workspace_id = ? AND job_id = ? AND status = 'running'
      `).run(nextRevision, now, now, job.workspaceId, job.jobId)
      if (jobUpdate.changes !== 1) throw new Error('The Patient Brief job is no longer running')
      return {
        job: this.get(job.workspaceId, job.jobId)!,
        revision,
        syntheticCase: this.#cases.get(job.workspaceId, job.caseId)!,
      }
    })()
  }

  fail(
    job: ClaimedPatientBriefJob,
    error: { code: string; message: string },
    now: string,
  ): PatientBriefJob {
    const update = this.#database.driver.prepare(`
      UPDATE patient_brief_job
      SET status = 'failed', error_code = ?, error_message = ?,
        finished_at = ?, updated_at = ?
      WHERE workspace_id = ? AND job_id = ? AND status = 'running'
    `).run(error.code, error.message, now, now, job.workspaceId, job.jobId)
    if (update.changes !== 1) throw new Error('The Patient Brief job is no longer running')
    return this.get(job.workspaceId, job.jobId)!
  }

  requeue(job: ClaimedPatientBriefJob, now: string): PatientBriefJob {
    const update = this.#database.driver.prepare(`
      UPDATE patient_brief_job
      SET status = 'queued', started_at = NULL, updated_at = ?
      WHERE workspace_id = ? AND job_id = ? AND status = 'running'
    `).run(now, job.workspaceId, job.jobId)
    if (update.changes !== 1) throw new Error('The Patient Brief job is no longer running')
    return this.get(job.workspaceId, job.jobId)!
  }

  listRevisions(workspaceId: string, caseId: string) {
    const syntheticCase = this.#cases.get(workspaceId, caseId)
    if (syntheticCase === undefined) return undefined
    const rows = z.array(revisionRowSchema).parse(this.#database.driver.prepare(`
      SELECT workspace_id, case_id, revision, content_json, model_id,
        prompt_version, prompt_hash, input_hash, output_hash, created_at
      FROM patient_brief_revision
      WHERE workspace_id = ? AND case_id = ?
      ORDER BY revision DESC
    `).all(workspaceId, caseId))
    return patientBriefRevisionListSchema.parse({
      activeRevision: syntheticCase.activeBriefRevision,
      items: rows.map(row => this.#mapRevision(row)),
    })
  }

  selectRevision(input: {
    briefRevision: number
    caseId: string
    expectedCaseRevision: number
    now: string
    workspaceId: string
  }): SyntheticCaseInstance | undefined {
    const exists = this.#database.driver.prepare(`
      SELECT 1 AS present FROM patient_brief_revision
      WHERE workspace_id = ? AND case_id = ? AND revision = ?
    `).get(input.workspaceId, input.caseId, input.briefRevision)
    if (exists === undefined) return undefined
    const update = this.#database.driver.prepare(`
      UPDATE synthetic_case_instance
      SET active_brief_revision = ?, status = 'brief-ready',
        revision = revision + 1, updated_at = ?
      WHERE workspace_id = ? AND case_id = ? AND revision = ?
        AND status IN ('brief-pending', 'brief-ready')
    `).run(
      input.briefRevision,
      input.now,
      input.workspaceId,
      input.caseId,
      input.expectedCaseRevision,
    )
    return update.changes === 1 ? this.#cases.get(input.workspaceId, input.caseId) : undefined
  }

  #publicJob(row: z.infer<typeof jobRowSchema>): PatientBriefJob {
    return patientBriefJobSchema.parse({
      caseId: row.case_id,
      createdAt: row.created_at,
      error: row.error_code === null || row.error_message === null
        ? null
        : { code: row.error_code, message: row.error_message },
      finishedAt: row.finished_at,
      jobId: row.job_id,
      resultRevision: row.result_revision,
      startedAt: row.started_at,
      status: row.status,
      updatedAt: row.updated_at,
      workspaceId: row.workspace_id,
    })
  }

  #mapRevision(row: z.infer<typeof revisionRowSchema>): PatientBriefRevision {
    return patientBriefRevisionSchema.parse({
      caseId: row.case_id,
      content: JSON.parse(row.content_json),
      createdAt: row.created_at,
      inputHash: row.input_hash,
      model: row.model_id,
      outputHash: row.output_hash,
      promptHash: row.prompt_hash,
      promptVersion: row.prompt_version,
      revision: row.revision,
      workspaceId: row.workspace_id,
    })
  }
}
