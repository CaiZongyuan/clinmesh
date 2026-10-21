import { consultationReplyAttemptSchema, consultationReplyErrorCodeSchema } from '@clinmesh/contracts/his'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { ActorContext } from './command-executor.ts'

const attemptRowSchema = z.object({
  attempt_id: z.string().min(1),
  doctor_turn_id: z.string().min(1),
  encounter_id: z.string().min(1),
  status: consultationReplyAttemptSchema.shape.status,
  started_at: z.iso.datetime(),
  deadline_at: z.iso.datetime(),
  error_code: consultationReplyErrorCodeSchema.nullable(),
}).strict()

export type ConsultationReplyAttempt = z.infer<typeof attemptRowSchema>

/** Intent identity is separate from the trusted doctor turn that owns the execution. */
export class ConsultationReplyAttempts {
  readonly #database: ClinMeshDatabase

  constructor(database: ClinMeshDatabase) {
    this.#database = database
    // Saving the answer and completing the attempt are separate short transactions.
    database.driver.prepare(`UPDATE consultation_reply_attempt AS a
      SET status = 'succeeded', error_code = NULL WHERE status = 'executing' AND EXISTS (
        SELECT 1 FROM consultation_turn doctor
        WHERE doctor.workspace_id = a.workspace_id AND doctor.epoch = a.epoch AND doctor.turn_id = a.doctor_turn_id
          AND (SELECT reply.speaker FROM consultation_turn reply
            WHERE reply.workspace_id = doctor.workspace_id AND reply.epoch = doctor.epoch
              AND reply.case_id = doctor.case_id AND reply.sequence > doctor.sequence AND reply.kind = 'text'
            ORDER BY reply.sequence LIMIT 1) = 'patient'
      )`).run()
    // There is no provider result lookup: interrupted executions cannot be resumed implicitly.
    database.driver.prepare(`UPDATE consultation_reply_attempt
      SET status = 'unknown', error_code = 'CONSULTATION_REPLY_UNKNOWN' WHERE status = 'executing'
        AND COALESCE(error_code, '') <> 'MODEL_CONTROL_BLOCKED'`).run()
  }

  accept(input: {
    context: ActorContext
    operation: 'ask' | 'retry'
    idempotencyKey: string
    encounterId: string
    doctorTurnId: string
    previouslyAccepted: boolean
  }): { attempt: ConsultationReplyAttempt; start: boolean } {
    const { context } = input
    return this.#database.driver.transaction(() => {
      const existing = attemptRowSchema.optional().parse(this.#database.driver.prepare(`
        SELECT a.attempt_id, a.doctor_turn_id, a.encounter_id, a.status, a.started_at, a.deadline_at, a.error_code
        FROM consultation_reply_intent i JOIN consultation_reply_attempt a
          ON a.workspace_id = i.workspace_id AND a.epoch = i.epoch AND a.attempt_id = i.attempt_id
        WHERE i.workspace_id = ? AND i.epoch = ? AND i.actor_id = ? AND i.operation = ? AND i.idempotency_key = ?
      `).get(context.workspaceId, context.epoch, context.actorId, input.operation, input.idempotencyKey))
      if (existing !== undefined) {
        if (existing.doctor_turn_id !== input.doctorTurnId || existing.encounter_id !== input.encounterId) {
          throw new Error('The reply intention has an inconsistent doctor turn')
        }
        return { attempt: existing, start: false }
      }
      let attempt = input.previouslyAccepted ? undefined : attemptRowSchema.optional().parse(this.#database.driver.prepare(`
        SELECT attempt_id, doctor_turn_id, encounter_id, status, started_at, deadline_at, error_code
        FROM consultation_reply_attempt
        WHERE workspace_id = ? AND epoch = ? AND doctor_turn_id = ? AND status = 'executing'
      `).get(context.workspaceId, context.epoch, input.doctorTurnId))
      const start = attempt === undefined && !input.previouslyAccepted
      if (attempt === undefined) {
        const started = new Date()
        attempt = {
          attempt_id: randomUUID(), doctor_turn_id: input.doctorTurnId, encounter_id: input.encounterId,
          status: start ? 'executing' : 'unknown', started_at: started.toISOString(),
          deadline_at: new Date(started.getTime() + 30_000).toISOString(),
          error_code: start ? null : 'CONSULTATION_REPLY_UNKNOWN',
        }
        this.#database.driver.prepare(`INSERT INTO consultation_reply_attempt
          (workspace_id, epoch, attempt_id, encounter_id, doctor_turn_id, status, started_at, deadline_at, error_code)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(context.workspaceId, context.epoch, attempt.attempt_id, attempt.encounter_id,
          attempt.doctor_turn_id, attempt.status, attempt.started_at, attempt.deadline_at, attempt.error_code)
      }
      this.#database.driver.prepare(`INSERT INTO consultation_reply_intent
        (workspace_id, epoch, actor_id, operation, idempotency_key, attempt_id) VALUES (?, ?, ?, ?, ?, ?)
      `).run(context.workspaceId, context.epoch, context.actorId, input.operation, input.idempotencyKey, attempt.attempt_id)
      return { attempt, start }
    }).immediate()
  }

  finish(context: ActorContext, attemptId: string, status: 'succeeded' | 'failed' | 'unknown' | 'blocked',
    errorCode: z.infer<typeof consultationReplyErrorCodeSchema> | null): void {
    this.#database.driver.prepare(`UPDATE consultation_reply_attempt SET status = ?, error_code = ?
      WHERE workspace_id = ? AND epoch = ? AND attempt_id = ? AND status = 'executing'
    `).run(status === 'blocked' ? 'executing' : status, errorCode, context.workspaceId, context.epoch, attemptId)
  }
}

export function consultationReplyProjection(database: ClinMeshDatabase, context: Pick<ActorContext, 'workspaceId' | 'epoch'>,
  doctorTurnId: string) {
  const row = attemptRowSchema.optional().parse(database.driver.prepare(`
    SELECT attempt_id, doctor_turn_id, encounter_id, status, started_at, deadline_at, error_code
    FROM consultation_reply_attempt WHERE workspace_id = ? AND epoch = ? AND doctor_turn_id = ?
    ORDER BY started_at DESC, rowid DESC LIMIT 1
  `).get(context.workspaceId, context.epoch, doctorTurnId))
  return row === undefined ? undefined : consultationReplyAttemptSchema.parse({
    doctorTurnId: row.doctor_turn_id, status: row.error_code === 'MODEL_CONTROL_BLOCKED' && row.status === 'executing' ? 'blocked' : row.status, startedAt: row.started_at, deadlineAt: row.deadline_at,
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
  })
}
