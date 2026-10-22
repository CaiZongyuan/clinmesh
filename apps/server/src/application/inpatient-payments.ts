import { createHash, randomBytes } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import { inpatientPaymentInputSchema, inpatientPaymentConfirmInputSchema, inpatientPaymentRecoverInputSchema,
  inpatientPaymentSchema, inpatientPaymentResponseSchema, inpatientPaymentPreviewResponseSchema, inpatientPaymentsSchema,
  inpatientRefundInputSchema, inpatientRefundConfirmInputSchema, inpatientRefundRecoverInputSchema, inpatientRefundPreviewResponseSchema } from '@clinmesh/contracts/inpatient-discharge'
import { refundResponseSchema } from '@clinmesh/contracts/refunds'
import type { ActorContext } from './command-executor.ts'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import { paymentChannelPlan } from './payment-channel.ts'
import { RefundLedger, type RefundSource } from './refund-ledger.ts'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const paymentSelect = `SELECT a.payment_id AS paymentId,a.admission_id AS admissionId,a.kind,a.amount_fen AS amountFen,
  a.tenders_json,a.outcome AS initialOutcome,COALESCE(r.outcome,a.outcome) AS outcome,a.correlation_id AS correlationId,
  a.created_at AS createdAt,r.resolved_at AS resolvedAt,CASE WHEN r.payment_id IS NULL THEN 1 ELSE 2 END AS version,a.recovery_outcome,a.adjustment_id
  FROM inpatient_payment_attempt a LEFT JOIN inpatient_payment_resolution r USING(workspace_id,epoch,payment_id)
  WHERE a.workspace_id=? AND a.epoch=?`
const rowSchema = inpatientPaymentSchema.omit({ tenders: true }).extend({ tenders_json: z.string(), recovery_outcome: z.enum(['success','declined','ambiguous']), adjustment_id: z.string().nullable() })
function publicAttempt(raw: z.infer<typeof rowSchema>) {
  const { tenders_json, recovery_outcome: _recovery, adjustment_id: _adjustment, ...row } = raw
  return inpatientPaymentSchema.parse({ ...row, tenders: JSON.parse(tenders_json) })
}
const previewSchema = z.object({ admission_id: z.string(), kind: inpatientPaymentSchema.shape.kind, amount_fen: z.number(), tenders_json: z.string(),
  simulator_rule: inpatientPaymentInputSchema.shape.simulatorRule, fingerprint: z.string(), token_hash: z.string(), actor_hash: z.string(), expires_at: z.string(), consumed_at: z.string().nullable(), adjustment_id: z.string().nullable() })
export const firstSettlementBasis = (admissionId: string) => `first-settlement:${admissionId}`

/** Owns inpatient funding; first settlement remains a separate clinical-owner gate. */
export class InpatientPayments {
  readonly refunds: RefundLedger
  constructor(readonly owner: InpatientService) { this.refunds = new RefundLedger(owner.database) }
  #rows(context: ActorContext, admissionId: string, firstOnly = false) {
    return z.array(rowSchema).parse(this.owner.database.driver.prepare(`${paymentSelect} AND a.admission_id=? ${firstOnly ? 'AND a.adjustment_id IS NULL' : ''} ORDER BY a.created_at,a.payment_id`)
      .all(context.workspaceId, context.epoch, admissionId))
  }
  #attempts(context: ActorContext, admissionId: string, firstOnly = false) {
    return this.#rows(context, admissionId, firstOnly).map(publicAttempt)
  }
  adjustmentAttempts(context: ActorContext, admissionId: string) {
    return this.#rows(context, admissionId).flatMap(row => {
      return row.adjustment_id === null ? [] : [{ ...publicAttempt(row), adjustmentId: row.adjustment_id }]
    })
  }
  sources(context: ActorContext, admissionId: string): Array<RefundSource & { createdAt: string }> {
    const attempts = this.#attempts(context, admissionId), tenders = new Map(attempts.map(attempt => [attempt.paymentId, attempt.tenders]))
    const deposits = z.array(z.object({ id: z.string(), amountFen: z.number().int().positive().safe(), createdAt: z.string() })).parse(
      this.owner.database.driver.prepare('SELECT transaction_id AS id,amount_fen AS amountFen,virtual_time AS createdAt FROM inpatient_deposit WHERE workspace_id=? AND epoch=? AND admission_id=?')
        .all(context.workspaceId, context.epoch, admissionId)).map(row => ({ ...row, kind: 'inpatient-deposit' as const,
          ...(tenders.has(row.id) ? { tenders: tenders.get(row.id)! } : {}) }))
    const supplements = new Map<string, RefundSource & { createdAt: string }>()
    for (const payment of attempts) if (payment.kind === 'supplement' && payment.outcome === 'success')
      supplements.set(payment.paymentId, { kind: 'inpatient-supplement', id: payment.paymentId, amountFen: payment.amountFen, createdAt: payment.createdAt, tenders: payment.tenders })
    for (const row of z.array(z.object({ id: z.string(), amountFen: z.number().int().positive().safe(), createdAt: z.string() })).parse(
      this.owner.database.driver.prepare("SELECT transaction_id AS id,amount_fen AS amountFen,virtual_time AS createdAt FROM inpatient_settlement_transaction WHERE workspace_id=? AND epoch=? AND admission_id=? AND kind='supplement'")
        .all(context.workspaceId, context.epoch, admissionId))) if (!supplements.has(row.id)) supplements.set(row.id, { ...row, kind: 'inpatient-supplement' })
    return [...deposits, ...supplements.values()]
  }
  read(context: ActorContext, admissionId: string) {
    // Commands use this calculation within their existing business transaction.
    if (this.owner.database.driver.inTransaction) return this.#statement(context, admissionId)
    let result: z.infer<typeof inpatientPaymentsSchema>
    try {
      result = this.#statement(context, admissionId)
    } catch (error) {
      try { this.owner.commands.auditRead(context, 'inpatient.payment.read', { admissionId }, 'failed') }
      catch { /* Preserve the original read rejection if its audit cannot be stored. */ }
      throw error
    }
    this.owner.commands.auditRead(context, 'inpatient.payment.read', { admissionId }, 'success')
    return result
  }
  #statement(context: ActorContext, admissionId: string) {
    this.owner.assertReadRole(context, ['cashier'])
    this.owner.readAdmissionBinding(context, admissionId)
    const rows = this.#rows(context, admissionId), payments = rows.filter(row => row.adjustment_id === null).map(publicAttempt)
    const laterIds = new Set(rows.filter(row => row.adjustment_id !== null).map(row => row.paymentId))
    const sources = this.sources(context, admissionId).filter(source => !laterIds.has(source.id))
      .map(source => ({ ...source, ...this.refunds.balance(context, source) }))
    const refunds = this.firstRefunds(context, admissionId)
    const refundedFen = refunds.filter(refund => refund.outcome === 'success').reduce((sum, refund) => sum + refund.amountFen, 0)
    const depositFen = sources.filter(source => source.kind === 'inpatient-deposit').reduce((sum, source) => sum + source.amountFen, 0)
    const supplementFen = sources.filter(source => source.kind === 'inpatient-supplement').reduce((sum, source) => sum + source.amountFen, 0)
    const settlement = this.owner.discharge.snapshot(context, admissionId)
    const patientFen = settlement.insurance?.patientFen ?? settlement.chargesFen
    return inpatientPaymentsSchema.parse({ admissionId, payments,
      depositFen, supplementFen, refundedFen, remainingFen: patientFen - depositFen - supplementFen + refundedFen,
      sources, refunds, pendingCount: payments.filter(payment => payment.outcome === 'ambiguous').length + refunds.filter(refund => refund.outcome === 'ambiguous').length })
  }
  firstRefunds(context: ActorContext, admissionId: string) { return this.refunds.attempts(context, 'inpatient', admissionId).filter(attempt => attempt.basisId === firstSettlementBasis(admissionId)) }
  pendingCount(context: ActorContext, admissionId: string) {
    return this.#attempts(context, admissionId, true).filter(payment => payment.outcome === 'ambiguous').length
      + this.firstRefunds(context, admissionId).filter(refund => refund.outcome === 'ambiguous').length
  }
  fundingFingerprint(context: ActorContext, admissionId: string) {
    const payments = this.#attempts(context, admissionId, true), refunds = this.firstRefunds(context, admissionId)
    return payments.length === 0 && refunds.length === 0 ? undefined : hash({ payments, refunds })
  }
  fingerprint(context: ActorContext, admissionId: string) {
    return hash({ snapshot: this.owner.discharge.snapshot(context, admissionId), payments: this.#attempts(context, admissionId),
      refunds: this.refunds.attempts(context, 'inpatient', admissionId) })
  }
  #assertCollectible(context: ActorContext, admissionId: string) {
    const admission = this.owner.admissionBinding(context, admissionId)
    this.owner.assertNotArchived(context, admissionId)
    if (admission.financialStatus !== 'open') throw new InpatientError('INPATIENT_ACCOUNT_SETTLED', '首次结算已完成，不能追加预交金或补缴')
    if (this.read(context, admissionId).pendingCount > 0)
      throw new InpatientError('INPATIENT_FUNDS_PENDING', '请先查询原收款结果，不得重复收款')
    return admission
  }
  /** Low-level seams require the owning Command transaction and caller's admission policy. */
  recordPreview(context: ActorContext, input: z.infer<typeof inpatientPaymentInputSchema> & { fingerprint: string; adjustmentId?: string }) {
    const previewId = uuidv7(), commitToken = randomBytes(32).toString('hex'), expiresAt = new Date(Date.now() + 300_000).toISOString()
    const plan = paymentChannelPlan(this.owner.database, context, input.simulatorRule)
    this.owner.database.driver.prepare(`INSERT INTO inpatient_payment_preview(workspace_id,epoch,preview_id,admission_id,kind,amount_fen,tenders_json,simulator_rule,fingerprint,token_hash,actor_hash,expires_at,adjustment_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(context.workspaceId, context.epoch, previewId, input.admissionId, input.kind, input.amountFen, JSON.stringify(input.tenders), input.simulatorRule,
        input.fingerprint, hash(commitToken), hash(context), expiresAt, input.adjustmentId ?? null)
    return { admissionId: input.admissionId, previewId, commitToken, kind: input.kind, amountFen: input.amountFen, tenders: input.tenders,
      expectedOutcome: plan.outcome, expiresAt, fingerprint: input.fingerprint }
  }
  reviewedPreview(context: ActorContext, previewId: string, commitToken: string) {
    const preview = previewSchema.optional().parse(this.owner.database.driver.prepare('SELECT * FROM inpatient_payment_preview WHERE workspace_id=? AND epoch=? AND preview_id=?').get(context.workspaceId, context.epoch, previewId))
    if (!preview || preview.consumed_at !== null || preview.token_hash !== hash(commitToken) || preview.actor_hash !== hash(context) || Date.parse(preview.expires_at) <= Date.now())
      throw new InpatientError('INPATIENT_PAYMENT_PREVIEW_STALE', '收款预览失效，请重新预览并审阅')
    return preview
  }
  recordAttempt(context: ActorContext, input: z.infer<typeof inpatientPaymentInputSchema> & { previewId: string; adjustmentId?: string }) {
    const plan = paymentChannelPlan(this.owner.database, context, input.simulatorRule), id = uuidv7(), now = this.owner.virtualTime(context)
    this.owner.database.driver.prepare(`INSERT INTO inpatient_payment_attempt(workspace_id,epoch,payment_id,admission_id,preview_id,kind,amount_fen,tenders_json,outcome,recovery_outcome,correlation_id,created_at,adjustment_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(context.workspaceId, context.epoch, id, input.admissionId, input.previewId, input.kind, input.amountFen, JSON.stringify(input.tenders), plan.outcome, plan.recoveryOutcome, `sim-inpatient-${id}`, now, input.adjustmentId ?? null)
    this.owner.database.driver.prepare('UPDATE inpatient_payment_preview SET consumed_at=? WHERE workspace_id=? AND epoch=? AND preview_id=? AND consumed_at IS NULL').run(now, context.workspaceId, context.epoch, input.previewId)
    if (plan.outcome === 'success' && input.kind === 'deposit') this.#recordDeposit(context, id, input.admissionId, input.amountFen, now)
    return publicAttempt(this.attempt(context, id)!)
  }
  preview(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientPaymentInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.payment.preview', expectedVersions: {},
      dataSchema: inpatientPaymentPreviewResponseSchema.shape.data, authorize: () => this.owner.assertRole(context, ['cashier']) }, () => {
      const admission = this.#assertCollectible(context, input.admissionId)
      if (input.kind === 'supplement' && (admission.status !== 'departed' || input.amountFen > this.read(context, input.admissionId).remainingFen))
        throw new InpatientError('INPATIENT_FUNDS_CONFLICT', '补缴须在已出区后且不能超过当前差额')
      const data = this.recordPreview(context, { ...input, fingerprint: this.fingerprint(context, input.admissionId) })
      return { data, effects: [{ kind: 'created' as const, reference: `InpatientPaymentPreview/${data.previewId}`, versionId: '1' }] }
    })
  }
  confirm(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientPaymentConfirmInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.payment.confirm', expectedVersions: {},
      dataSchema: inpatientPaymentResponseSchema.shape.data, authorize: () => this.owner.assertRole(context, ['cashier']) }, () => {
      this.#assertCollectible(context, input.admissionId)
      const preview = this.reviewedPreview(context, input.previewId, input.commitToken)
      if (preview.admission_id !== input.admissionId || preview.adjustment_id !== null || preview.fingerprint !== this.fingerprint(context, input.admissionId))
        throw new InpatientError('INPATIENT_PAYMENT_PREVIEW_STALE', '收款预览失效，请重新预览并审阅')
      const data = this.recordAttempt(context, { admissionId: input.admissionId, previewId: input.previewId, kind: preview.kind,
        amountFen: preview.amount_fen, tenders: JSON.parse(preview.tenders_json), simulatorRule: preview.simulator_rule })
      return { data, effects: [{ kind: 'created' as const, reference: `InpatientPayment/${data.paymentId}`, versionId: '1' },
        ...(data.outcome === 'success' && data.kind === 'deposit' ? [{ kind: 'created' as const, reference: `InpatientDeposit/${data.paymentId}`, versionId: '1' }] : [])] }
    })
  }
  #recordDeposit(context: ActorContext, id: string, admissionId: string, amount: number, now: string) {
    this.owner.database.driver.prepare('INSERT INTO inpatient_deposit VALUES(?,?,?,?,?,?)').run(context.workspaceId, context.epoch, id, admissionId, amount, now)
  }
  recover(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientPaymentRecoverInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.payment.recover', expectedVersions: {},
      dataSchema: inpatientPaymentResponseSchema.shape.data, authorize: () => this.owner.assertRole(context, ['cashier']) }, () => {
      this.owner.admissionBinding(context, input.admissionId)
      this.owner.assertNotArchived(context, input.admissionId)
      const attempt = this.attempt(context, input.paymentId)
      if (!attempt || attempt.admissionId !== input.admissionId || attempt.adjustment_id !== null) throw new InpatientError('INPATIENT_PAYMENT_CONFLICT', '原首次收款不存在')
      const data = this.recoverAttempt(context, input.paymentId, input.expectedPaymentVersion)
      return { data, effects: data.version === attempt.version ? [] : [
        { kind: 'created' as const, reference: `InpatientPaymentResolution/${input.paymentId}`, versionId: '1' },
        ...(data.outcome === 'success' && data.kind === 'deposit' ? [{ kind: 'created' as const, reference: `InpatientDeposit/${input.paymentId}`, versionId: '1' }] : [])] }
    })
  }
  attempt(context: ActorContext, paymentId: string) {
    return rowSchema.optional().parse(this.owner.database.driver.prepare(`${paymentSelect} AND a.payment_id=?`).get(context.workspaceId, context.epoch, paymentId))
  }
  recoverAttempt(context: ActorContext, paymentId: string, expectedVersion: number) {
      const attempt = this.attempt(context, paymentId)
      if (!attempt || attempt.version !== expectedVersion) throw new InpatientError('INPATIENT_PAYMENT_CONFLICT', '原收款不存在或版本已变化')
      if (attempt.outcome === 'ambiguous' && attempt.recovery_outcome !== 'ambiguous') {
        const now = this.owner.virtualTime(context)
        this.owner.database.driver.prepare('INSERT INTO inpatient_payment_resolution VALUES(?,?,?,?,?)').run(context.workspaceId, context.epoch, paymentId, attempt.recovery_outcome, now)
        if (attempt.kind === 'deposit' && attempt.recovery_outcome === 'success') {
          this.#recordDeposit(context, paymentId, attempt.admissionId, attempt.amountFen, now)
        }
      }
      return publicAttempt(this.attempt(context, paymentId)!)
  }
  #refundSource(context: ActorContext, admissionId: string, sourceId: string) {
    const source = this.sources(context, admissionId).find(item => item.id === sourceId)
    if (!source) throw new InpatientError('INPATIENT_FUNDS_CONFLICT', '原成功入款不属于本次住院')
    return source
  }
  #assertRefundable(context: ActorContext, input: z.infer<typeof inpatientRefundInputSchema>) {
    const admission = this.#assertCollectible(context, input.admissionId), statement = this.read(context, input.admissionId)
    const source = this.#refundSource(context, input.admissionId, input.sourceId)
    if (admission.status !== 'departed' || input.amountFen > -statement.remainingFen || input.amountFen > this.refunds.balance(context, source).refundableFen)
      throw new InpatientError('INPATIENT_FUNDS_CONFLICT', '退款须在已出区后且不超过应退差额及原款可退余额')
    return source
  }
  refundPreview(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientRefundInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.refund.preview', expectedVersions: {},
      dataSchema: inpatientRefundPreviewResponseSchema.shape.data, authorize: () => this.owner.assertRole(context, ['cashier']) }, () => {
      const source = this.#assertRefundable(context, input), previewId = uuidv7(), commitToken = randomBytes(32).toString('hex')
      const expiresAt = new Date(Date.now() + 300_000).toISOString(), plan = paymentChannelPlan(this.owner.database, context, input.simulatorRule)
      this.owner.database.driver.prepare('INSERT INTO inpatient_refund_preview VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL)').run(context.workspaceId, context.epoch,
        previewId, input.admissionId, source.kind, source.id, input.amountFen, input.simulatorRule, this.fingerprint(context, input.admissionId), hash(commitToken), hash(context), expiresAt)
      return { data: { admissionId: input.admissionId, previewId, commitToken, sourceId: source.id, sourceKind: source.kind,
        amountFen: input.amountFen, expectedOutcome: plan.outcome, expiresAt }, effects: [{ kind: 'created' as const, reference: `InpatientRefundPreview/${previewId}`, versionId: '1' }] }
    })
  }
  refundConfirm(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientRefundConfirmInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.refund.confirm', expectedVersions: {},
      dataSchema: refundResponseSchema.shape.data, authorize: () => this.owner.assertRole(context, ['cashier']) }, () => {
      const preview = z.object({ admission_id: z.string(), source_id: z.string(), amount_fen: z.number(), simulator_rule: inpatientRefundInputSchema.shape.simulatorRule,
        fingerprint: z.string(), token_hash: z.string(), actor_hash: z.string(), expires_at: z.string(), consumed_at: z.string().nullable() }).optional().parse(
          this.owner.database.driver.prepare('SELECT * FROM inpatient_refund_preview WHERE workspace_id=? AND epoch=? AND preview_id=?').get(context.workspaceId, context.epoch, input.previewId))
      if (!preview || preview.admission_id !== input.admissionId || preview.consumed_at !== null || preview.token_hash !== hash(input.commitToken)
        || preview.actor_hash !== hash(context) || Date.parse(preview.expires_at) <= Date.now() || preview.fingerprint !== this.fingerprint(context, input.admissionId))
        throw new InpatientError('INPATIENT_PAYMENT_PREVIEW_STALE', '退款预览失效，请重新预览并审阅')
      const source = this.#assertRefundable(context, { admissionId: input.admissionId, sourceId: preview.source_id, amountFen: preview.amount_fen, simulatorRule: preview.simulator_rule })
      const now = this.owner.virtualTime(context), data = this.refunds.create(context, { source, basisId: firstSettlementBasis(input.admissionId), ownerKind: 'inpatient', ownerId: input.admissionId,
        amountFen: preview.amount_fen, simulatorRule: preview.simulator_rule, createdAt: now })
      this.owner.database.driver.prepare('UPDATE inpatient_refund_preview SET consumed_at=? WHERE workspace_id=? AND epoch=? AND preview_id=?').run(now, context.workspaceId, context.epoch, input.previewId)
      return { data, effects: [{ kind: 'created' as const, reference: `RefundTransaction/${data.refundId}`, versionId: '1' }] }
    })
  }
  refundRecover(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientRefundRecoverInputSchema.parse(raw)
    return this.owner.commands.execute({ context, input, idempotencyKey, operation: 'inpatient.refund.recover', expectedVersions: {},
      dataSchema: refundResponseSchema.shape.data, authorize: () => this.owner.assertRole(context, ['cashier']) }, () => {
      this.owner.admissionBinding(context, input.admissionId)
      this.owner.assertNotArchived(context, input.admissionId)
      const attempt = this.refunds.attempt(context, input.refundId)
      if (!attempt || attempt.ownerKind !== 'inpatient' || attempt.ownerId !== input.admissionId || attempt.basisId !== firstSettlementBasis(input.admissionId))
        throw new InpatientError('INPATIENT_FUNDS_CONFLICT', '原首次退款不存在或不属于本次住院')
      this.#refundSource(context, input.admissionId, attempt.sourceId)
      const data = this.refunds.recover(context, input.refundId, input.expectedRefundVersion, this.owner.virtualTime(context))
      return { data, effects: data.version === attempt.version ? [] : [{ kind: 'created' as const, reference: `RefundResolution/${data.refundId}`, versionId: '1' }] }
    })
  }
  /** Legacy settle is itself the human-reviewed default cash instruction until an independent attempt exists. */
  prepareFirstSettlement(context: ActorContext, admissionId: string) {
    const statement = this.read(context, admissionId)
    if (statement.pendingCount > 0) throw new InpatientError('INPATIENT_FUNDS_PENDING', '资金结果未查明，不能封账或清床')
    if (statement.payments.length === 0 && statement.refunds.length === 0 && statement.remainingFen !== 0) {
      if (statement.remainingFen > 0) {
        const input = { admissionId, kind: 'supplement' as const, amountFen: statement.remainingFen,
          tenders: [{ method: 'cash' as const, amountFen: statement.remainingFen }], simulatorRule: 'success' as const }
        const preview = this.recordPreview(context, { ...input, fingerprint: this.fingerprint(context, admissionId) })
        this.recordAttempt(context, { ...input, previewId: preview.previewId })
      } else {
        let remaining = -statement.remainingFen
        for (const source of this.sources(context, admissionId)) {
          const amount = Math.min(remaining, this.refunds.balance(context, source).refundableFen)
          if (amount > 0) this.refunds.create(context, { source, basisId: firstSettlementBasis(admissionId), ownerKind: 'inpatient', ownerId: admissionId,
            amountFen: amount, simulatorRule: 'success', createdAt: this.owner.virtualTime(context) })
          remaining -= amount
        }
      }
    }
    if (this.read(context, admissionId).remainingFen !== 0) throw new InpatientError('INPATIENT_FUNDS_REQUIRED', '请先按当前差额完成收退款，再重新预览结算')
  }
}
