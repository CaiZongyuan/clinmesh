import { z } from 'zod'
import { paymentAllocationSchema, paymentRecordedTendersSchema } from '@clinmesh/contracts/his'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { RepositoryContext } from '../infrastructure/sqlite/fhir-repository.ts'

const outcomeSchema = z.enum(['ambiguous', 'declined', 'success'])
const attemptRowSchema = z.object({
  amount_fen: z.number().int().nonnegative(),
  correlation_id: z.string(),
  created_at: z.string(),
  initial_outcome: outcomeSchema,
  outcome: outcomeSchema,
  payment_id: z.string(),
  preview_id: z.string(),
  resolved_at: z.string().nullable(),
})
const attemptSelect = `
  SELECT payment.amount_fen, payment.correlation_id, payment.created_at, payment.payment_id, payment.preview_id,
    payment.outcome AS initial_outcome,
    COALESCE(resolution.outcome, payment.outcome) AS outcome,
    resolution.resolved_at
  FROM collection_transaction AS payment
  LEFT JOIN collection_resolution AS resolution USING (workspace_id, epoch, payment_id)
  WHERE payment.workspace_id = ? AND payment.epoch = ? AND payment.owner_kind = 'outpatient'
`

function paymentAttempt(row: z.infer<typeof attemptRowSchema>) {
  return {
    amountFen: row.amount_fen,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
    initialOutcome: row.initial_outcome,
    outcome: row.outcome,
    paymentId: row.payment_id,
    previewId: row.preview_id,
    resolvedAt: row.resolved_at,
    version: row.resolved_at === null ? 1 : 2,
  }
}

/** Outpatient allocation and bill projection. Collection facts belong to PaymentCollection. */
export class PaymentLedger {
  constructor(private readonly database: ClinMeshDatabase) {}

  balance(context: RepositoryContext, chargeItemId: string) {
    return z.object({ paidFen: z.number().int().nonnegative(), unresolved: z.number().int().nonnegative() }).parse(
      this.database.driver.prepare(`
        SELECT COALESCE(SUM(CASE WHEN COALESCE(resolution.outcome, payment.outcome) = 'success'
          THEN allocation.amount_fen ELSE 0 END), 0) - (
          SELECT COALESCE(SUM(refund.amount_fen),0) FROM refund_transaction refund
          LEFT JOIN refund_resolution result USING(workspace_id,epoch,refund_id)
          WHERE refund.workspace_id=? AND refund.epoch=? AND refund.basis_id=?
            AND COALESCE(result.outcome,refund.outcome)='success'
        ) AS paidFen,
          COALESCE(SUM(CASE WHEN COALESCE(resolution.outcome, payment.outcome) = 'ambiguous'
          THEN 1 ELSE 0 END), 0) + (
            SELECT COUNT(*) FROM refund_transaction refund
            LEFT JOIN refund_resolution result USING(workspace_id,epoch,refund_id)
            WHERE refund.workspace_id=? AND refund.epoch=? AND refund.basis_id=?
              AND COALESCE(result.outcome,refund.outcome)='ambiguous'
          ) AS unresolved
        FROM outpatient_payment_allocation AS allocation
        JOIN collection_transaction AS payment USING (workspace_id, epoch, payment_id)
        LEFT JOIN collection_resolution AS resolution USING (workspace_id, epoch, payment_id)
        WHERE allocation.workspace_id = ? AND allocation.epoch = ? AND allocation.charge_item_id = ?
      `).get(
        context.workspaceId, context.epoch, `outpatient-charge:${chargeItemId}`,
        context.workspaceId, context.epoch, `outpatient-charge:${chargeItemId}`,
        context.workspaceId, context.epoch, chargeItemId,
      ),
    )
  }

  allocate(context: RepositoryContext, paymentId: string, caseId: string, chargeItemId: string, amountFen: number, position = 0) {
    this.database.driver.prepare(`INSERT INTO outpatient_payment_allocation
      (workspace_id, epoch, payment_id, case_id, charge_item_id, amount_fen, position) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(context.workspaceId, context.epoch, paymentId, caseId, chargeItemId, amountFen, position)
  }

  #allocations(context: RepositoryContext, paymentIds: string[]) {
    const grouped = new Map<string, Array<z.infer<typeof paymentAllocationSchema>>>()
    if (paymentIds.length === 0) return grouped
    const rows = z.array(paymentAllocationSchema.extend({ paymentId: z.string() })).parse(this.database.driver.prepare(`
      SELECT payment_id AS paymentId, charge_item_id AS chargeItemId, amount_fen AS amountFen
      FROM outpatient_payment_allocation WHERE workspace_id=? AND epoch=? AND payment_id IN (${paymentIds.map(() => '?').join(',')})
      ORDER BY position
    `).all(context.workspaceId, context.epoch, ...paymentIds))
    for (const { paymentId, ...allocation } of rows) {
      const items = grouped.get(paymentId) ?? []
      items.push(allocation)
      grouped.set(paymentId, items)
    }
    return grouped
  }

  attempt(context: RepositoryContext, paymentId: string) {
    const row = attemptRowSchema.optional().parse(
      this.database.driver.prepare(`${attemptSelect} AND payment.payment_id = ?`)
        .get(context.workspaceId, context.epoch, paymentId),
    )
    return row === undefined ? undefined : { ...paymentAttempt(row), allocations: this.#allocations(context, [paymentId]).get(paymentId) ?? [] }
  }

  attempts(context: RepositoryContext, caseId: string, page = 1, pageSize = 20) {
    const scope = [context.workspaceId, context.epoch, caseId]
    const total = z.object({ total: z.number().int().nonnegative() }).parse(this.database.driver.prepare(`
      SELECT COUNT(*) AS total FROM collection_transaction WHERE workspace_id = ? AND epoch = ? AND owner_id = ? AND owner_kind = 'outpatient'
    `).get(...scope)).total
    const rows = z.array(attemptRowSchema).parse(this.database.driver.prepare(`
      ${attemptSelect} AND payment.owner_id = ?
      ORDER BY payment.created_at DESC, payment.payment_id DESC LIMIT ? OFFSET ?
    `).all(...scope, pageSize, (page - 1) * pageSize))
    const allocations = this.#allocations(context, rows.map(row => row.payment_id))
    const tenders = new Map<string, Array<{ method: 'cash' | 'bank-card' | 'mobile'; amountFen: number }>>()
    if (rows.length > 0) {
      const tenderRows = z.array(z.object({
        paymentId: z.string(), method: z.enum(['cash', 'bank-card', 'mobile']), amountFen: z.number().int().nonnegative(),
      })).parse(this.database.driver.prepare(`
        SELECT payment_id AS paymentId, method, amount_fen AS amountFen FROM collection_tender
        WHERE workspace_id = ? AND epoch = ? AND payment_id IN (${rows.map(() => '?').join(', ')}) ORDER BY position
      `).all(context.workspaceId, context.epoch, ...rows.map(row => row.payment_id)))
      for (const { paymentId, ...tender } of tenderRows) {
        const recorded = tenders.get(paymentId) ?? []
        recorded.push(tender)
        tenders.set(paymentId, recorded)
      }
    }
    return { items: rows.map(row => {
      const items = allocations.get(row.payment_id) ?? []
      const recordedTenders = paymentRecordedTendersSchema.parse(tenders.get(row.payment_id) ?? [])
      if (items.length === 0 || items.reduce((sum, item) => sum + item.amountFen, 0) !== row.amount_fen) {
        throw new Error('Collection allocations do not match the original payment')
      }
      return items.length === 1
        ? { ...paymentAttempt(row), chargeItemId: items[0]!.chargeItemId, tenders: recordedTenders }
        : { ...paymentAttempt(row), kind: 'multi-charge' as const, allocations: items, tenders: recordedTenders }
    }), page, pageSize, total }
  }
}
