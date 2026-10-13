import { z } from 'zod'
import {
  doctorRecommendationStateSchema, type DoctorRecommendationKind, type DoctorRecommendationState,
  type GenerateDoctorRecommendationsRequest,
} from '@clinmesh/contracts/doctor-recommendations'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import type { ActorContext, CommandExecutor } from './command-executor.ts'
import type { WorkflowService } from './workflow-service.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'
import { WorkflowError } from './workflow-error.ts'

const stateRowSchema = z.object({
  generation: z.number().int().positive(), input_fingerprint: z.string(),
  state_json: z.string(), status: z.string(),
})

export class DoctorRecommendationsService {
  constructor(private readonly options: { database: ClinMeshDatabase; workflow: WorkflowService; commands: CommandExecutor }) {}

  #input(context: ActorContext, caseId: string) {
    const detail = doctorCaseDetailSchema.parse(this.options.workflow.doctorRecommendationCase(context, caseId))
    const catalog = this.options.workflow.clinicalCatalog(context)
    const snapshot = { context, detail, catalog }
    return { snapshot, inputFingerprint: canonicalJsonHash(snapshot) }
  }

  #key(context: ActorContext, caseId: string, kind: DoctorRecommendationKind) {
    return [context.workspaceId, context.epoch, context.actorId, canonicalJsonHash(context), caseId, kind] as const
  }

  #row(context: ActorContext, caseId: string, kind: DoctorRecommendationKind) {
    return stateRowSchema.optional().parse(this.options.database.driver.prepare(`
      SELECT generation, input_fingerprint, state_json, status FROM doctor_recommendation_state
      WHERE workspace_id = ? AND epoch = ? AND actor_id = ? AND context_key = ? AND case_id = ? AND kind = ?
    `).get(...this.#key(context, caseId, kind)))
  }

  read(context: ActorContext, caseId: string, kind: DoctorRecommendationKind) {
    const { snapshot, inputFingerprint } = this.#input(context, caseId)
    const row = this.#row(context, caseId, kind)
    if (row !== undefined) {
      const state = doctorRecommendationStateSchema.parse(JSON.parse(row.state_json))
      return { ...state, inputFingerprint, encounterVersion: snapshot.detail.encounter.versionId,
        stale: row.input_fingerprint !== inputFingerprint }
    }
    return doctorRecommendationStateSchema.parse({
      caseId, kind, encounterId: snapshot.detail.encounter.id, encounterVersion: snapshot.detail.encounter.versionId,
      inputFingerprint, status: 'idle', generation: 0, stale: false, items: [],
      guidelines: [], caseEvidence: [], missingInformation: [],
    })
  }

  generate(context: ActorContext, caseId: string, kind: DoctorRecommendationKind,
    request: GenerateDoctorRecommendationsRequest, idempotencyKey: string) {
    const { snapshot, inputFingerprint } = this.#input(context, caseId)
    const encounterReference = `Encounter/${snapshot.detail.encounter.id}`
    if (Object.keys(request.expectedVersions).length !== 1 || request.expectedVersions[encounterReference] === undefined) {
      throw new WorkflowError('WORKFLOW_CONFLICT', 'The current Encounter expected version is required')
    }
    return this.options.commands.execute({ context, operation: 'doctor.recommendations.generate',
      contextRequirement: 'current', expectedVersions: request.expectedVersions, idempotencyKey,
      input: { caseId, kind, ...request.input }, dataSchema: doctorRecommendationStateSchema,
      authorize: () => { this.options.workflow.doctorRecommendationCase(context, caseId) },
    }, transaction => {
      if (request.input.expectedInputFingerprint !== inputFingerprint) {
        throw new WorkflowError('WORKFLOW_CONFLICT', 'The recommendation input changed; read the current state')
      }
      const previous = this.#row(context, caseId, kind)
      if (!request.input.refresh && previous?.input_fingerprint === inputFingerprint) {
        return { data: this.read(context, caseId, kind), effects: [] }
      }
      const generation = (previous?.generation ?? 0) + 1
      const state: DoctorRecommendationState = {
        caseId, kind, encounterId: snapshot.detail.encounter.id, encounterVersion: snapshot.detail.encounter.versionId,
        inputFingerprint, generation, status: 'pending', stale: false, items: [], guidelines: [], caseEvidence: [], missingInformation: [],
      }
      const key = this.#key(context, caseId, kind)
      this.options.database.driver.prepare(`INSERT INTO doctor_recommendation_state
        (workspace_id, epoch, actor_id, context_key, case_id, kind, generation, input_fingerprint,
          actor_context_json, input_json, state_json, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        ON CONFLICT (workspace_id, epoch, actor_id, context_key, case_id, kind) DO UPDATE SET
          generation = excluded.generation, input_fingerprint = excluded.input_fingerprint,
          actor_context_json = excluded.actor_context_json, input_json = excluded.input_json,
          state_json = excluded.state_json, status = excluded.status, updated_at = excluded.updated_at
      `).run(...key, generation, inputFingerprint, JSON.stringify(context), JSON.stringify(snapshot), JSON.stringify(state), new Date().toISOString())
      transaction.enqueue({ kind: 'doctor.generate-recommendations',
        dedupKey: `doctor-recommendations:${key[3]}:${caseId}:${kind}:${generation}`,
        payload: { actorId: context.actorId, contextKey: key[3], caseId, kind, generation },
      })
      return { data: state, effects: [{ kind: 'updated', reference: `DoctorRecommendations/${caseId}:${kind}`, versionId: String(generation) }] }
    })
  }
}
