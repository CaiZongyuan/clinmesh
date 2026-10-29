import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { paymentRecordedTendersSchema, type paymentSimulatorRuleSchema } from '@clinmesh/contracts/his'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { RepositoryContext } from '../infrastructure/sqlite/fhir-repository.ts'
import { paymentChannelPlan } from './payment-channel.ts'
import { WorkflowError } from './workflow-error.ts'

const outcomeSchema = z.enum(['success', 'declined', 'ambiguous'])
const attemptSchema = z.object({
  paymentId: z.string(), ownerKind: z.enum(['outpatient', 'inpatient']), ownerId: z.string(),
  patientId: z.string(), encounterId: z.string(),
  purpose: z.enum(['outpatient-charge', 'inpatient-deposit', 'inpatient-supplement']),
  previewId: z.string(), amountFen: z.number().int().nonnegative().safe(),
  initialOutcome: outcomeSchema, outcome: outcomeSchema, recoveryOutcome: outcomeSchema,
  correlationId: z.string(), createdAt: z.string(), resolvedAt: z.string().nullable(), version: z.number().int().positive(),
})

/** Money facts only. Business owners authorize, allocate and release inside their Command transaction. */
export class PaymentCollection {
  constructor(private readonly database: ClinMeshDatabase) {}

  #assertTransaction() {
    if (!this.database.driver.inTransaction) throw new WorkflowError('WORKFLOW_CONFLICT', '收款交易必须在原业务 Command 事务内执行')
  }

  create(context: RepositoryContext, input: {
    owner: { kind: 'outpatient' | 'inpatient'; id: string }
    purpose: z.infer<typeof attemptSchema>['purpose']
    previewId: string; amountFen: number; tenders: z.infer<typeof paymentRecordedTendersSchema>
    simulatorRule: z.infer<typeof paymentSimulatorRuleSchema>; createdAt: string
  }) {
    this.#assertTransaction()
    const identity = z.object({ patientId: z.string(), encounterId: z.string(), outpatientId: z.string().nullable() }).optional().parse(
      this.database.driver.prepare(`SELECT patient_id AS patientId,encounter_id AS encounterId,outpatient_case_id AS outpatientId
        FROM clinical_request_context WHERE workspace_id=? AND epoch=? AND case_id=?`)
        .get(context.workspaceId, context.epoch, input.owner.id),
    )
    if (identity === undefined || (identity.outpatientId !== null) !== (input.owner.kind === 'outpatient')
      || (input.purpose === 'outpatient-charge') !== (input.owner.kind === 'outpatient')) {
      throw new WorkflowError('WORKFLOW_CONFLICT', '收款必须绑定原就诊及资金用途')
    }
    if (input.tenders.reduce((sum, item) => sum + item.amountFen, 0) !== input.amountFen) {
      throw new WorkflowError('WORKFLOW_CONFLICT', '支付方式金额必须等于本次收款金额')
    }
    const { outcome, recoveryOutcome } = paymentChannelPlan(this.database, context, input.simulatorRule)
    const paymentId = uuidv7()
    this.database.driver.prepare(`INSERT INTO collection_transaction
      (workspace_id,epoch,payment_id,owner_kind,owner_id,patient_id,encounter_id,purpose,preview_id,
        amount_fen,outcome,recovery_outcome,correlation_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(context.workspaceId, context.epoch, paymentId, input.owner.kind, input.owner.id, identity.patientId, identity.encounterId,
        input.purpose, input.previewId, input.amountFen, outcome, recoveryOutcome, `sim-${paymentId}`, input.createdAt)
    const insert = this.database.driver.prepare('INSERT INTO collection_tender VALUES(?,?,?,?,?,?)')
    input.tenders.forEach((tender, position) => insert.run(context.workspaceId, context.epoch, paymentId, tender.method, tender.amountFen, position))
    return this.attempt(context, paymentId)!
  }

  attempt(context: RepositoryContext, paymentId: string) {
    return attemptSchema.optional().parse(this.database.driver.prepare(`SELECT
      payment.payment_id AS paymentId,payment.owner_kind AS ownerKind,payment.owner_id AS ownerId,
      payment.patient_id AS patientId,payment.encounter_id AS encounterId,payment.purpose,payment.preview_id AS previewId,
      payment.amount_fen AS amountFen,payment.outcome AS initialOutcome,COALESCE(resolution.outcome,payment.outcome) AS outcome,
      payment.recovery_outcome AS recoveryOutcome,payment.correlation_id AS correlationId,payment.created_at AS createdAt,
      resolution.resolved_at AS resolvedAt,CASE WHEN resolution.payment_id IS NULL THEN 1 ELSE 2 END AS version
      FROM collection_transaction AS payment LEFT JOIN collection_resolution AS resolution USING(workspace_id,epoch,payment_id)
      WHERE payment.workspace_id=? AND payment.epoch=? AND payment.payment_id=?`).get(context.workspaceId, context.epoch, paymentId))
  }

  tenders(context: RepositoryContext, paymentId: string) {
    return paymentRecordedTendersSchema.parse(this.database.driver.prepare(`SELECT method,amount_fen AS amountFen
      FROM collection_tender WHERE workspace_id=? AND epoch=? AND payment_id=? ORDER BY position`)
      .all(context.workspaceId, context.epoch, paymentId))
  }

  recover(context: RepositoryContext, paymentId: string, expectedVersion: number, resolvedAt: string) {
    this.#assertTransaction()
    const payment = this.attempt(context, paymentId)
    if (payment === undefined || payment.version !== expectedVersion) {
      throw new WorkflowError('WORKFLOW_CONFLICT', '原收款版本已变化，请刷新账单')
    }
    if (payment.outcome !== 'ambiguous' || payment.recoveryOutcome === 'ambiguous') return { payment, changed: false }
    this.database.driver.prepare(`INSERT INTO collection_resolution(workspace_id,epoch,payment_id,outcome,resolved_at)
      VALUES(?,?,?,?,?)`).run(context.workspaceId, context.epoch, paymentId, payment.recoveryOutcome, resolvedAt)
    return { payment: { ...payment, outcome: payment.recoveryOutcome, resolvedAt, version: 2 }, changed: true }
  }
}
