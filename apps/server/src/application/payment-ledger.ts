import { z } from 'zod'
import { paymentRecordedTendersSchema } from '@clinmesh/contracts/his'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { RepositoryContext } from '../infrastructure/sqlite/fhir-repository.ts'

const outcomeSchema = z.enum(['ambiguous', 'declined', 'success'])
const attemptRowSchema = z.object({
  amount_fen: z.number().int().nonnegative(),
  charge_item_id: z.string(),
  correlation_id: z.string(),
  created_at: z.string(),
  initial_outcome: outcomeSchema,
  outcome: outcomeSchema,
  payment_id: z.string(),
  preview_id: z.string(),
  resolved_at: z.string().nullable(),
})

/** Shared money facts. Clinical release remains owned by the originating workflow. */
export class PaymentLedger {
  constructor(private readonly database: ClinMeshDatabase) {}

  balance(context: RepositoryContext, chargeItemId: string) {
    return z.object({ paidFen: z.number().int().nonnegative(), unresolved: z.number().int().nonnegative() }).parse(
      this.database.driver.prepare(`
        SELECT COALESCE(SUM(CASE WHEN COALESCE(resolution.outcome, payment.outcome) = 'success'
          THEN allocation.amount_fen ELSE 0 END), 0) AS paidFen,
          COALESCE(SUM(CASE WHEN COALESCE(resolution.outcome, payment.outcome) = 'ambiguous'
          THEN 1 ELSE 0 END), 0) AS unresolved
        FROM payment_allocation AS allocation
        JOIN payment_transaction AS payment USING (workspace_id, epoch, payment_id)
        LEFT JOIN payment_resolution AS resolution USING (workspace_id, epoch, payment_id)
        WHERE allocation.workspace_id = ? AND allocation.epoch = ? AND allocation.charge_item_id = ?
      `).get(context.workspaceId, context.epoch, chargeItemId),
    )
  }

  allocate(context: RepositoryContext, paymentId: string, chargeItemId: string, tenders: z.infer<typeof paymentRecordedTendersSchema>) {
    const amount = tenders.reduce((sum, tender) => sum + tender.amountFen, 0)
    this.database.driver.prepare(`INSERT INTO payment_allocation
      (workspace_id, epoch, payment_id, charge_item_id, amount_fen) VALUES (?, ?, ?, ?, ?)
    `).run(context.workspaceId, context.epoch, paymentId, chargeItemId, amount)
    const insert = this.database.driver.prepare(`INSERT INTO payment_tender
      (workspace_id, epoch, payment_id, method, amount_fen, position) VALUES (?, ?, ?, ?, ?, ?)
    `)
    tenders.forEach((tender, position) => insert.run(context.workspaceId, context.epoch, paymentId, tender.method, tender.amountFen, position))
  }

  attempts(context: RepositoryContext, caseId: string) {
    const rows = z.array(attemptRowSchema).parse(this.database.driver.prepare(`
      SELECT payment.*, payment.outcome AS initial_outcome,
        COALESCE(resolution.outcome, payment.outcome) AS outcome,
        allocation.charge_item_id, resolution.resolved_at
      FROM payment_transaction AS payment
      JOIN payment_allocation AS allocation USING (workspace_id, epoch, payment_id)
      LEFT JOIN payment_resolution AS resolution USING (workspace_id, epoch, payment_id)
      WHERE payment.workspace_id = ? AND payment.epoch = ? AND payment.case_id = ?
      ORDER BY payment.created_at, payment.payment_id
    `).all(context.workspaceId, context.epoch, caseId))
    return rows.map(row => ({
      amountFen: row.amount_fen,
      chargeItemId: row.charge_item_id,
      correlationId: row.correlation_id,
      createdAt: row.created_at,
      initialOutcome: row.initial_outcome,
      outcome: row.outcome,
      paymentId: row.payment_id,
      previewId: row.preview_id,
      resolvedAt: row.resolved_at,
      tenders: paymentRecordedTendersSchema.parse(this.database.driver.prepare(`
        SELECT method, amount_fen AS amountFen FROM payment_tender
        WHERE workspace_id = ? AND epoch = ? AND payment_id = ? ORDER BY position
      `).all(context.workspaceId, context.epoch, row.payment_id)),
      version: row.resolved_at === null ? 1 : 2,
    }))
  }
}
