import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { refundAttemptSchema, refundSourceKindSchema } from '@clinmesh/contracts/refunds'
import type { paymentSimulatorRuleSchema } from '@clinmesh/contracts/his'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { RepositoryContext } from '../infrastructure/sqlite/fhir-repository.ts'
import { WorkflowError } from './workflow-error.ts'
import { paymentChannelPlan } from './payment-channel.ts'

export type RefundSource = { kind: z.infer<typeof refundSourceKindSchema>; id: string; amountFen: number }
const rowSchema = refundAttemptSchema.extend({ recoveryOutcome: z.enum(['success', 'declined', 'ambiguous']) })
const select = `SELECT refund.refund_id AS refundId,refund.source_kind AS sourceKind,refund.source_id AS sourceId,
  refund.basis_id AS basisId,refund.owner_kind AS ownerKind,refund.owner_id AS ownerId,refund.amount_fen AS amountFen,
  refund.outcome AS initialOutcome,COALESCE(resolution.outcome,refund.outcome) AS outcome,
  refund.recovery_outcome AS recoveryOutcome,refund.correlation_id AS correlationId,refund.created_at AS createdAt,
  resolution.resolved_at AS resolvedAt,CASE WHEN resolution.refund_id IS NULL THEN 1 ELSE 2 END AS version
  FROM refund_transaction refund LEFT JOIN refund_resolution resolution USING(workspace_id,epoch,refund_id)
  WHERE refund.workspace_id=? AND refund.epoch=?`

/** Money only: callers validate source identity, correction allowance and authorization inside their Command. */
export class RefundLedger {
  constructor(readonly database: ClinMeshDatabase) {}
  balance(context: RepositoryContext, source: RefundSource) {
    const row = z.object({ refundedFen: z.number().int().nonnegative(), reservedFen: z.number().int().nonnegative(), version: z.number().int().positive() }).parse(
      this.database.driver.prepare(`SELECT
        COALESCE(SUM(CASE WHEN COALESCE(r.outcome,t.outcome)='success' THEN t.amount_fen ELSE 0 END),0) AS refundedFen,
        COALESCE(SUM(CASE WHEN COALESCE(r.outcome,t.outcome)='ambiguous' THEN t.amount_fen ELSE 0 END),0) AS reservedFen,
        1+COUNT(*)+COUNT(r.refund_id) AS version
        FROM refund_transaction t LEFT JOIN refund_resolution r USING(workspace_id,epoch,refund_id)
        WHERE t.workspace_id=? AND t.epoch=? AND t.source_kind=? AND t.source_id=?`)
        .get(context.workspaceId, context.epoch, source.kind, source.id),
    )
    return { ...row, refundableFen: Math.max(0, source.amountFen - row.refundedFen - row.reservedFen) }
  }
  basisBalance(context: RepositoryContext, basisId: string) {
    return z.object({ refundedFen: z.number().int().nonnegative(), reservedFen: z.number().int().nonnegative() }).parse(
      this.database.driver.prepare(`SELECT
        COALESCE(SUM(CASE WHEN COALESCE(r.outcome,t.outcome)='success' THEN t.amount_fen ELSE 0 END),0) AS refundedFen,
        COALESCE(SUM(CASE WHEN COALESCE(r.outcome,t.outcome)='ambiguous' THEN t.amount_fen ELSE 0 END),0) AS reservedFen
        FROM refund_transaction t LEFT JOIN refund_resolution r USING(workspace_id,epoch,refund_id)
        WHERE t.workspace_id=? AND t.epoch=? AND t.basis_id=?`).get(context.workspaceId, context.epoch, basisId),
    )
  }
  attempt(context: RepositoryContext, refundId: string) {
    return rowSchema.optional().parse(this.database.driver.prepare(`${select} AND refund.refund_id=?`).get(context.workspaceId, context.epoch, refundId))
  }
  attempts(context: RepositoryContext, ownerKind: 'outpatient' | 'inpatient', ownerId: string) {
    return z.array(refundAttemptSchema).parse(this.database.driver.prepare(`${select} AND refund.owner_kind=? AND refund.owner_id=? ORDER BY refund.created_at DESC,refund.refund_id DESC`)
      .all(context.workspaceId, context.epoch, ownerKind, ownerId).map(row => { const { recoveryOutcome: _recovery, ...attempt } = rowSchema.parse(row); return attempt }))
  }
  create(context: RepositoryContext, input: { source: RefundSource; basisId: string; ownerKind: 'outpatient' | 'inpatient'; ownerId: string; amountFen: number; simulatorRule: z.infer<typeof paymentSimulatorRuleSchema>; createdAt: string }) {
    const amount = z.number().int().positive().safe().parse(input.amountFen)
    if (amount > this.balance(context, input.source).refundableFen) throw new WorkflowError('WORKFLOW_CONFLICT', '退款超过原交易可退余额')
    const { outcome, recoveryOutcome: recovery } = paymentChannelPlan(this.database, context, input.simulatorRule)
    const refundId = uuidv7()
    this.database.driver.prepare(`INSERT INTO refund_transaction(workspace_id,epoch,refund_id,source_kind,source_id,basis_id,owner_kind,owner_id,amount_fen,outcome,recovery_outcome,correlation_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(context.workspaceId, context.epoch, refundId, input.source.kind, input.source.id, input.basisId, input.ownerKind, input.ownerId, amount, outcome, recovery, `sim-refund-${refundId}`, input.createdAt)
    const { recoveryOutcome: _recovery, ...attempt } = rowSchema.parse(this.attempt(context, refundId))
    return attempt
  }
  recover(context: RepositoryContext, refundId: string, expectedVersion: number, resolvedAt: string) {
    const attempt = this.attempt(context, refundId)
    if (attempt === undefined || attempt.version !== expectedVersion) throw new WorkflowError('WORKFLOW_CONFLICT', '原退款版本已变化，请刷新账单')
    if (attempt.outcome === 'ambiguous' && attempt.recoveryOutcome !== 'ambiguous') {
      this.database.driver.prepare('INSERT INTO refund_resolution(workspace_id,epoch,refund_id,outcome,resolved_at) VALUES(?,?,?,?,?)')
        .run(context.workspaceId, context.epoch, refundId, attempt.recoveryOutcome, resolvedAt)
    }
    const { recoveryOutcome: _recovery, ...result } = rowSchema.parse(this.attempt(context, refundId))
    return result
  }
}
