import { createHash, randomUUID } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import { inpatientFinancialAdjustmentInputSchema, inpatientFinancialSchema, inpatientFinancialResponseSchema,
  inpatientFinancialRefundPreviewInputSchema, inpatientFinancialRefundPreviewResponseSchema,
  inpatientFinancialRefundConfirmInputSchema, inpatientFinancialRefundRecoverInputSchema } from '@clinmesh/contracts/inpatient-finance'
import { refundResponseSchema } from '@clinmesh/contracts/refunds'
import type { ActorContext } from './command-executor.ts'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import { RefundLedger, type RefundSource } from './refund-ledger.ts'
import { paymentChannelPlan } from './payment-channel.ts'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const adjustmentRow = z.object({ adjustmentId: z.string(), chargeId: z.string(), settlementId: z.string(), amountFen: z.number().int().positive().safe(),
  reason: z.string(), actorId: z.string(), practitionerRoleId: z.string(), createdAt: z.string() })

/** Later financial changes never mutate the first settlement or the clinical/record owners. */
export class InpatientFinancialAdjustments {
  readonly ledger: RefundLedger
  constructor(readonly owner: InpatientService) { this.ledger = new RefundLedger(owner.database) }

  #authorize(context: ActorContext) {
    this.owner.assertReadRole(context, ['cashier'])
    const run = z.object({ status: z.enum(['active', 'completed', 'closed']) }).parse(this.owner.database.driver.prepare(
      'SELECT status FROM scenario_run WHERE workspace_id=? AND epoch=? AND scenario_run_id=?').get(context.workspaceId, context.epoch, context.scenarioRunId))
    if (run.status === 'closed' || (run.status === 'completed' && context.agentGrantId !== undefined))
      throw new InpatientError('INPATIENT_FINANCIAL_CONTEXT_FORBIDDEN', '当前场景不允许新的财务更正', 403)
  }
  #sources(context: ActorContext, admissionId: string): RefundSource[] {
    const deposits = z.array(z.object({ id: z.string(), amountFen: z.number().int().positive().safe() })).parse(this.owner.database.driver.prepare(
      'SELECT transaction_id AS id,amount_fen AS amountFen FROM inpatient_deposit WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY transaction_id')
      .all(context.workspaceId, context.epoch, admissionId)).map(row => ({ ...row, kind: 'inpatient-deposit' as const }))
    const supplements = z.array(z.object({ id: z.string(), amountFen: z.number().int().positive().safe() })).parse(this.owner.database.driver.prepare(
      "SELECT transaction_id AS id,amount_fen AS amountFen FROM inpatient_settlement_transaction WHERE workspace_id=? AND epoch=? AND admission_id=? AND kind='supplement' ORDER BY transaction_id")
      .all(context.workspaceId, context.epoch, admissionId)).map(row => ({ ...row, kind: 'inpatient-supplement' as const }))
    return [...deposits, ...supplements]
  }
  #snapshot(context: ActorContext, admissionId: string) {
    const admission = this.owner.readAdmissionBinding(context, admissionId)
    if (admission.financialStatus !== 'settled' || !['departed', 'cleared'].includes(admission.status))
      throw new InpatientError('INPATIENT_FINANCIAL_SETTLEMENT_REQUIRED', '首次结算完成后才能办理后续财务更正')
    const frozen = this.owner.discharge.snapshot(context, admissionId)
    if (!frozen.settlement) throw new InpatientError('INPATIENT_FINANCIAL_SETTLEMENT_REQUIRED', '缺少首次冻结结算')
    const rows = z.array(adjustmentRow).parse(this.owner.database.driver.prepare(`SELECT adjustment_id AS adjustmentId,charge_id AS chargeId,
      settlement_id AS settlementId,amount_fen AS amountFen,reason,actor_id AS actorId,practitioner_role_id AS practitionerRoleId,created_at AS createdAt
      FROM inpatient_financial_adjustment WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY created_at,adjustment_id`).all(context.workspaceId, context.epoch, admissionId))
    const adjustmentIds = new Set(rows.map(row => row.adjustmentId))
    const refunds = this.ledger.attempts(context, 'inpatient', admissionId).filter(refund => adjustmentIds.has(refund.basisId))
    const adjustments = rows.map(row => {
      const balance = this.ledger.basisBalance(context, row.adjustmentId)
      return { ...row, ...balance, status: balance.reservedFen > 0 ? 'unknown' as const : balance.refundedFen === row.amountFen ? 'completed' as const : 'pending' as const }
    })
    const charges = frozen.charges.map(charge => {
      const adjustedFen = rows.filter(row => row.chargeId === charge.id).reduce((sum, row) => sum + row.amountFen, 0)
      return { chargeId: charge.id, label: charge.label, originalFen: charge.amountFen, adjustedFen, currentFen: charge.amountFen - adjustedFen }
    })
    const currentChargesFen = charges.reduce((sum, charge) => sum + charge.currentFen, 0)
    const sources = this.#sources(context, admissionId).map(source => ({ sourceKind: source.kind, sourceId: source.id, amountFen: source.amountFen, ...this.ledger.balance(context, source) }))
    const refundedFen = refunds.filter(refund => refund.outcome === 'success').reduce((sum, refund) => sum + refund.amountFen, 0)
    const reservedFen = refunds.filter(refund => refund.outcome === 'ambiguous').reduce((sum, refund) => sum + refund.amountFen, 0)
    const frozenFundsFen = frozen.transactions.reduce((sum, transaction) => sum + transaction.amountFen, 0)
    const currentFundsFen = frozenFundsFen - refundedFen
    const data = { admissionId, status: admission.status, recordStatus: admission.row.record_status, firstSettlement: frozen.settlement,
      charges, adjustments, sources, refunds, frozenChargesFen: frozen.settlement.chargesFen, currentChargesFen,
      frozenFundsFen, currentFundsFen, remainingRefundFen: currentFundsFen - currentChargesFen, reservedFen }
    return inpatientFinancialSchema.parse({ ...data, fingerprint: hash(data) })
  }
  read(context: ActorContext, admissionId: string) {
    this.owner.assertReadRole(context, ['cashier', 'medical-records'])
    this.owner.database.driver.exec('BEGIN')
    try { const result = this.#snapshot(context, admissionId); this.owner.database.driver.exec('COMMIT'); return result }
    catch (error) { if (this.owner.database.driver.inTransaction) this.owner.database.driver.exec('ROLLBACK'); throw error }
  }
  adjust(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientFinancialAdjustmentInputSchema.parse(raw)
    return this.owner.commands.execute({ context, contextRequirement: 'current', input, idempotencyKey, operation: 'inpatient.financial.adjust',
      expectedVersions: {}, dataSchema: inpatientFinancialResponseSchema.shape.data, authorize: () => this.#authorize(context) }, () => {
      const snapshot = this.#snapshot(context, input.admissionId)
      if (snapshot.fingerprint !== input.expectedFingerprint) throw new InpatientError('INPATIENT_FINANCIAL_PREVIEW_STALE', '账目或资金已变化，请重新审阅财务差异')
      const charge = snapshot.charges.find(item => item.chargeId === input.chargeId)
      const facts = this.owner.orders.chargeFacts(context, input.admissionId)
      if (!charge || charge.originalFen <= 0 || facts.charges.some(item => item.reversalOf === input.chargeId) || input.amountFen > charge.currentFen)
        throw new InpatientError('INPATIENT_FINANCIAL_AMOUNT_CONFLICT', '冲减须关联有效原费用且不超过剩余金额')
      const id = uuidv7()
      this.owner.database.driver.prepare('INSERT INTO inpatient_financial_adjustment VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(context.workspaceId, context.epoch, id, input.admissionId, input.chargeId, snapshot.firstSettlement.id, input.amountFen, input.reason,
          context.actorId, context.practitionerRoleId, this.owner.virtualTime(context))
      return { data: this.#snapshot(context, input.admissionId), effects: [{ kind: 'created' as const, reference: `InpatientFinancialAdjustment/${id}`, versionId: '1' }] }
    })
  }
  #refundBasis(context: ActorContext, input: z.infer<typeof inpatientFinancialRefundPreviewInputSchema>) {
    const snapshot = this.#snapshot(context, input.admissionId)
    if (snapshot.fingerprint !== input.expectedFingerprint) throw new InpatientError('INPATIENT_FINANCIAL_PREVIEW_STALE', '账目或资金已变化，请重新审阅财务差异')
    const adjustment = snapshot.adjustments.find(item => item.adjustmentId === input.adjustmentId)
    const source = this.#sources(context, input.admissionId).find(item => item.kind === input.sourceKind && item.id === input.sourceId)
    if (!adjustment || !source) throw new InpatientError('INPATIENT_FINANCIAL_SOURCE_CONFLICT', '退款须关联本次住院的原费用更正和原交易')
    const balance = this.ledger.balance(context, source)
    if (balance.version !== input.expectedSourceVersion || input.amountFen > balance.refundableFen
      || input.amountFen > adjustment.amountFen - adjustment.refundedFen - adjustment.reservedFen
      || input.amountFen > snapshot.remainingRefundFen - snapshot.reservedFen)
      throw new InpatientError('INPATIENT_FINANCIAL_AMOUNT_CONFLICT', '退款超过当前更正依据、待退金额或原交易可退余额')
    return source
  }
  refundPreview(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientFinancialRefundPreviewInputSchema.parse(raw)
    return this.owner.commands.execute({ context, contextRequirement: 'current', input, idempotencyKey, operation: 'inpatient.financial.refund.preview',
      expectedVersions: {}, dataSchema: inpatientFinancialRefundPreviewResponseSchema.shape.data, authorize: () => this.#authorize(context) }, () => {
      this.#refundBasis(context, input)
      const previewId = uuidv7(), commitToken = randomUUID(), expiresAt = new Date(Date.now() + 300_000).toISOString()
      const plan = paymentChannelPlan(this.owner.database, context, input.simulatorRule)
      this.owner.database.driver.prepare('INSERT INTO inpatient_financial_refund_preview VALUES(?,?,?,?,?,?,?,?,NULL)')
        .run(context.workspaceId, context.epoch, previewId, input.admissionId, JSON.stringify(input), hash(commitToken), hash(context), expiresAt)
      return { data: { previewId, commitToken, admissionId: input.admissionId, adjustmentId: input.adjustmentId, sourceKind: input.sourceKind,
        sourceId: input.sourceId, amountFen: input.amountFen, expectedOutcome: plan.outcome, expiresAt },
        effects: [{ kind: 'created' as const, reference: `InpatientFinancialRefundPreview/${previewId}`, versionId: '1' }] }
    })
  }
  refundConfirm(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientFinancialRefundConfirmInputSchema.parse(raw)
    return this.owner.commands.execute({ context, contextRequirement: 'current', input, idempotencyKey, operation: 'inpatient.financial.refund.confirm',
      expectedVersions: {}, dataSchema: refundResponseSchema.shape.data, authorize: () => this.#authorize(context) }, () => {
      const preview = z.object({ admission_id: z.string(), input_json: z.string(), token_hash: z.string(), actor_hash: z.string(),
        expires_at: z.string(), consumed_at: z.string().nullable() }).optional().parse(this.owner.database.driver.prepare(
        'SELECT * FROM inpatient_financial_refund_preview WHERE workspace_id=? AND epoch=? AND preview_id=?').get(context.workspaceId, context.epoch, input.previewId))
      if (!preview || preview.admission_id !== input.admissionId || preview.consumed_at !== null || preview.token_hash !== hash(input.commitToken)
        || preview.actor_hash !== hash(context) || Date.parse(preview.expires_at) <= Date.now())
        throw new InpatientError('INPATIENT_FINANCIAL_PREVIEW_STALE', '退款预览失效，请重新审阅')
      const reviewed = inpatientFinancialRefundPreviewInputSchema.parse(JSON.parse(preview.input_json))
      const source = this.#refundBasis(context, reviewed), now = this.owner.virtualTime(context)
      const refund = this.ledger.create(context, { source, basisId: reviewed.adjustmentId, ownerKind: 'inpatient', ownerId: input.admissionId,
        amountFen: reviewed.amountFen, simulatorRule: reviewed.simulatorRule, createdAt: now })
      this.owner.database.driver.prepare('UPDATE inpatient_financial_refund_preview SET consumed_at=? WHERE workspace_id=? AND epoch=? AND preview_id=?')
        .run(now, context.workspaceId, context.epoch, input.previewId)
      return { data: refund, effects: [{ kind: 'created' as const, reference: `RefundTransaction/${refund.refundId}`, versionId: '1' }] }
    })
  }
  refundRecover(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientFinancialRefundRecoverInputSchema.parse(raw)
    return this.owner.commands.execute({ context, contextRequirement: 'current', input, idempotencyKey, operation: 'inpatient.financial.refund.recover',
      expectedVersions: {}, dataSchema: refundResponseSchema.shape.data, authorize: () => this.#authorize(context) }, () => {
      this.owner.readAdmissionBinding(context, input.admissionId)
      const original = this.ledger.attempt(context, input.refundId)
      const basis = this.owner.database.driver.prepare('SELECT 1 FROM inpatient_financial_adjustment WHERE workspace_id=? AND epoch=? AND admission_id=? AND adjustment_id=?')
        .get(context.workspaceId, context.epoch, input.admissionId, original?.basisId ?? '')
      if (!original || original.ownerKind !== 'inpatient' || original.ownerId !== input.admissionId || !basis)
        throw new InpatientError('INPATIENT_FINANCIAL_SOURCE_CONFLICT', '原退款不属于本次后续财务调整')
      const refund = this.ledger.recover(context, input.refundId, input.expectedRefundVersion, this.owner.virtualTime(context))
      return { data: refund, effects: refund.version === original.version ? [] : [{ kind: 'created' as const, reference: `RefundResolution/${refund.refundId}`, versionId: '1' }] }
    })
  }
}
