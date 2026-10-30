import { createHmac } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import { paymentTendersSchema } from '@clinmesh/contracts/his'
import { chargeAdjustmentInputSchema, chargeAdjustmentResponseSchema, refundCaseSchema, refundConfirmInputSchema,
  refundPreviewInputSchema, refundPreviewResponseSchema, refundRecoverInputSchema, refundResponseSchema } from '@clinmesh/contracts/refunds'
import type { ActorContext, CommandEffect, CommandExecutor } from './command-executor.ts'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { FhirRepository } from '../infrastructure/sqlite/fhir-repository.ts'
import { WorkspaceContextError, WorkspaceRepository } from '../infrastructure/sqlite/workspace-repository.ts'
import { PaymentLedger } from './payment-ledger.ts'
import { OutpatientInvestigationBilling } from './outpatient-investigation-billing.ts'
import { readOutpatientInsuranceAllocations } from './outpatient-insurance.ts'
import { RefundLedger } from './refund-ledger.ts'
import { WorkflowError } from './workflow-error.ts'

export class OutpatientRefunds {
  readonly ledger: RefundLedger
  constructor(readonly database: ClinMeshDatabase, readonly fhir: FhirRepository, readonly commands: CommandExecutor,
    readonly options: { now: () => Date; virtualTime: (context: ActorContext) => string; tokenSecret: string
      onFundsChanged?: (context: ActorContext) => CommandEffect[] }) {
    this.ledger = new RefundLedger(database)
  }
  #authorize(context: ActorContext) {
    if (context.roleCode !== 'cashier') throw new WorkflowError('ROLE_NOT_ALLOWED', '仅收费员可办理费用更正和退款')
  }
  #authorizeRecovery(context: ActorContext) {
    this.#authorize(context)
    const run = z.object({ status: z.enum(['active', 'completed', 'closed']) }).parse(this.database.driver.prepare(
      'SELECT status FROM scenario_run WHERE workspace_id=? AND epoch=? AND scenario_run_id=?')
      .get(context.workspaceId, context.epoch, context.scenarioRunId))
    if (run.status === 'closed' || (run.status === 'completed' && context.agentGrantId !== undefined)) {
      throw new WorkspaceContextError('The Scenario Run does not permit recovery of the original refund')
    }
  }
  #charge(context: ActorContext, chargeItemId: string, caseId?: string) {
    const row = z.object({ case_id: z.string(), total_fen: z.number().int().nonnegative(), version: z.number().int().positive(), category: z.string(),
      status: z.string(), source_reference: z.string(), case_status: z.string() }).optional().parse(this.database.driver.prepare(`
      SELECT charge.*,outpatient.status AS case_status FROM charge_record charge JOIN outpatient_case outpatient USING(workspace_id,epoch,case_id)
      WHERE charge.workspace_id=? AND charge.epoch=? AND charge.charge_item_id=?`).get(context.workspaceId, context.epoch, chargeItemId))
    if (row === undefined || (caseId !== undefined && row.case_id !== caseId) || row.category === 'registration') throw new WorkflowError('WORKFLOW_CONFLICT', '原费用不可办理此退款')
    return row
  }
  adjustmentFen(context: ActorContext, chargeItemId: string) {
    return z.object({ amount: z.number().int().nonnegative() }).parse(this.database.driver.prepare(
      'SELECT COALESCE(SUM(amount_fen),0) AS amount FROM financial_charge_adjustment WHERE workspace_id=? AND epoch=? AND charge_item_id=?')
      .get(context.workspaceId, context.epoch, chargeItemId)).amount
  }
  #source(context: ActorContext, paymentId: string) {
    const attempt = new PaymentLedger(this.database).attempt(context, paymentId)
    if (attempt === undefined || attempt.outcome !== 'success' || attempt.amountFen === 0) throw new WorkflowError('WORKFLOW_CONFLICT', '退款必须关联已确定成功且有余额的原交易')
    const tenders = paymentTendersSchema.parse(this.database.driver.prepare('SELECT method,amount_fen AS amountFen FROM payment_tender WHERE workspace_id=? AND epoch=? AND payment_id=? ORDER BY position')
      .all(context.workspaceId, context.epoch, paymentId))
    return { attempt, source: { kind: 'outpatient-payment' as const, id: paymentId, amountFen: attempt.amountFen, tenders }, charge: this.#charge(context, attempt.chargeItemId) }
  }
  #allowance(context: ActorContext, chargeItemId: string) {
    const basis = this.ledger.basisBalance(context, `outpatient-charge:${chargeItemId}`)
    return Math.max(0, this.adjustmentFen(context, chargeItemId) - basis.refundedFen - basis.reservedFen)
  }
  read(context: ActorContext, caseId: string) {
    let result: z.infer<typeof refundCaseSchema>
    try {
      result = this.#statement(context, caseId)
    } catch (error) {
      try { this.commands.auditRead(context, 'billing.refunds.get', { caseId }, 'failed') }
      catch { /* Preserve the original read rejection if its audit cannot be stored. */ }
      throw error
    }
    this.commands.auditRead(context, 'billing.refunds.get', { caseId }, 'success')
    return result
  }
  #statement(context: ActorContext, caseId: string) {
    this.#authorize(context)
    new WorkspaceRepository(this.database).assertCurrent(context, context.scenarioRunId)
    const found = this.database.driver.prepare('SELECT 1 FROM outpatient_case WHERE workspace_id=? AND epoch=? AND case_id=?').get(context.workspaceId, context.epoch, caseId)
    if (found === undefined) throw new WorkflowError('WORKFLOW_CONFLICT', '收费病例不存在')
    const adjustments = z.array(z.object({ adjustmentId: z.string(), chargeItemId: z.string(), amountFen: z.number(), reason: z.string(), createdAt: z.string() })).parse(
      this.database.driver.prepare(`SELECT a.adjustment_id AS adjustmentId,a.charge_item_id AS chargeItemId,a.amount_fen AS amountFen,a.reason,a.created_at AS createdAt
        FROM financial_charge_adjustment a JOIN charge_record c USING(workspace_id,epoch,charge_item_id)
        WHERE a.workspace_id=? AND a.epoch=? AND c.case_id=? ORDER BY a.created_at,a.adjustment_id`).all(context.workspaceId, context.epoch, caseId))
    const sources = z.array(z.object({ paymentId: z.string() })).parse(this.database.driver.prepare(`SELECT p.payment_id AS paymentId
      FROM payment_transaction p LEFT JOIN payment_resolution r USING(workspace_id,epoch,payment_id)
      WHERE p.workspace_id=? AND p.epoch=? AND p.case_id=? AND p.amount_fen>0 AND COALESCE(r.outcome,p.outcome)='success' ORDER BY p.created_at,p.payment_id`).all(context.workspaceId, context.epoch, caseId))
      .map(({ paymentId }) => { const { source, attempt } = this.#source(context, paymentId); const balance = this.ledger.balance(context, source)
        return { sourceId: paymentId, chargeItemId: attempt.chargeItemId, amountFen: source.amountFen, ...balance,
          refundableFen: Math.min(balance.refundableFen, this.#allowance(context, attempt.chargeItemId)) } })
    const refunds = this.ledger.attempts(context, 'outpatient', caseId)
    return refundCaseSchema.parse({ caseId, adjustments, sources, refunds,
      adjustedFen: adjustments.reduce((sum, item) => sum + item.amountFen, 0),
      refundedFen: sources.reduce((sum, item) => sum + item.refundedFen, 0), reservedFen: sources.reduce((sum, item) => sum + item.reservedFen, 0) })
  }
  adjust(context: ActorContext, caseId: string, raw: unknown, expectedVersions: Record<string, string>, idempotencyKey: string) {
    const input = chargeAdjustmentInputSchema.parse(raw)
    return this.commands.execute({ context, input: { caseId, ...input }, expectedVersions, idempotencyKey, operation: 'billing.charge.adjust',
      dataSchema: chargeAdjustmentResponseSchema.shape.data, authorize: () => this.#authorize(context) }, () => {
      const charge = this.#charge(context, input.chargeItemId, caseId)
      this.#expectedCharge(expectedVersions, input.chargeItemId)
      const investigation = new OutpatientInvestigationBilling(this.database).readByCharge(context, input.chargeItemId)
      if (investigation !== undefined && investigation.billing.releasedAt === undefined && investigation.billing.status !== 'cancelled') {
        throw new WorkflowError('WORKFLOW_CONFLICT', '首次放行前不能冲减原检查费用，请负责医生取消后按正确价格重新开立')
      }
      if (readOutpatientInsuranceAllocations(this.database, context, caseId).has(`ChargeItem/${input.chargeItemId}`)) {
        throw new WorkflowError('WORKFLOW_CONFLICT', '请先撤销本费用的有效医保待遇，再办理费用冲减')
      }
      if (input.amountFen > charge.total_fen - this.adjustmentFen(context, input.chargeItemId)) throw new WorkflowError('WORKFLOW_CONFLICT', '冲减超过原费用剩余金额')
      if (new PaymentLedger(this.database).balance(context, input.chargeItemId).unresolved > 0) throw new WorkflowError('WORKFLOW_CONFLICT', '请先查明原收款或退款结果')
      const id = uuidv7(), now = this.options.virtualTime(context)
      this.database.driver.prepare('INSERT INTO financial_charge_adjustment VALUES(?,?,?,?,?,?,?,?)').run(context.workspaceId, context.epoch, id, input.chargeItemId, input.amountFen, input.reason,
        JSON.stringify({ sourceReference: charge.source_reference, caseStatus: charge.case_status, chargeStatus: charge.status }), now)
      const item = this.fhir.read(context, 'ChargeItem', input.chargeItemId)
      const updated = this.fhir.update(context, { ...item, note: [...(Array.isArray(item.note) ? item.note : []), { text: `Financial adjustment ${id}: -${input.amountFen} fen; ${input.reason}` }] }, String(charge.version))
      this.database.driver.prepare('UPDATE charge_record SET version=version+1 WHERE workspace_id=? AND epoch=? AND charge_item_id=?').run(context.workspaceId, context.epoch, input.chargeItemId)
      return { data: { adjustmentId: id, chargeItemId: input.chargeItemId, adjustedFen: input.amountFen, chargeVersion: charge.version + 1 }, effects: [
        { kind: 'created' as const, reference: `ChargeAdjustment/${id}`, versionId: '1' },
        { kind: 'updated' as const, reference: `ChargeItem/${input.chargeItemId}`, versionId: updated.meta!.versionId! },
      ] }
    })
  }
  #expectedCharge(expectedVersions: Record<string, string>, chargeItemId: string) {
    if (expectedVersions[`ChargeItem/${chargeItemId}`] === undefined) throw new WorkflowError('WORKFLOW_CONFLICT', '必须提供原费用版本')
  }
  #hash(value: string) { return createHmac('sha256', this.options.tokenSecret).update(value).digest('hex') }
  #contextHash(context: ActorContext) { return this.#hash(JSON.stringify(context)) }
  #validate(context: ActorContext, paymentId: string, amountFen: number, version: number, expectedVersions: Record<string, string>) {
    const value = this.#source(context, paymentId)
    this.#expectedCharge(expectedVersions, value.attempt.chargeItemId)
    if (new PaymentLedger(this.database).balance(context, value.attempt.chargeItemId).unresolved > 0) {
      throw new WorkflowError('WORKFLOW_CONFLICT', '请先查明该费用的原收款或退款结果')
    }
    const balance = this.ledger.balance(context, value.source)
    if (balance.version !== version || amountFen > balance.refundableFen || amountFen > this.#allowance(context, value.attempt.chargeItemId)) {
      throw new WorkflowError('WORKFLOW_CONFLICT', '原交易余额或费用更正依据已变化，请重新预览')
    }
    return { ...value, balance }
  }
  preview(context: ActorContext, raw: unknown, expectedVersions: Record<string, string>, idempotencyKey: string) {
    const input = refundPreviewInputSchema.parse(raw)
    return this.commands.execute({ context, input, expectedVersions, idempotencyKey, operation: 'refund.preview', dataSchema: refundPreviewResponseSchema.shape.data,
      authorize: () => this.#authorize(context) }, () => {
      const value = this.#validate(context, input.paymentId, input.amountFen, input.expectedSourceVersion, expectedVersions)
      const previewId = uuidv7(), commitToken = `${previewId}.${this.#hash(previewId)}`, expiresAt = new Date(this.options.now().getTime() + 300_000).toISOString()
      this.database.driver.prepare('INSERT INTO refund_preview VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)').run(context.workspaceId, context.epoch, previewId,
        input.paymentId, input.amountFen, input.expectedSourceVersion, value.charge.version, input.simulatorRule, this.#contextHash(context), this.#hash(commitToken), expiresAt)
      return { data: { previewId, commitToken, sourceId: input.paymentId, chargeItemId: value.attempt.chargeItemId, amountFen: input.amountFen,
        refundableFen: Math.min(value.balance.refundableFen, this.#allowance(context, value.attempt.chargeItemId)), expectedSourceVersion: input.expectedSourceVersion,
        expectedOutcome: input.simulatorRule.startsWith('ambiguous') ? 'ambiguous' as const : input.simulatorRule === 'decline' ? 'declined' as const : 'success' as const, expiresAt },
        effects: [{ kind: 'created' as const, reference: `RefundPreview/${previewId}`, versionId: '1' }] }
    })
  }
  confirm(context: ActorContext, previewId: string, raw: unknown, expectedVersions: Record<string, string>, idempotencyKey: string) {
    const input = refundConfirmInputSchema.parse(raw)
    return this.commands.execute({ context, input: { previewId, ...input }, expectedVersions, idempotencyKey, operation: 'refund.confirm', dataSchema: refundResponseSchema.shape.data,
      authorize: () => this.#authorize(context) }, () => {
      const preview = z.object({ payment_id: z.string(), amount_fen: z.number(), source_version: z.number(), charge_version: z.number(), simulator_rule: refundPreviewInputSchema.shape.simulatorRule,
        actor_context_hash: z.string(), token_hash: z.string(), expires_at: z.string(), consumed_at: z.string().nullable() }).optional().parse(this.database.driver.prepare(
        'SELECT * FROM refund_preview WHERE workspace_id=? AND epoch=? AND preview_id=?').get(context.workspaceId, context.epoch, previewId))
      if (preview === undefined || preview.consumed_at !== null || preview.actor_context_hash !== this.#contextHash(context)
        || preview.token_hash !== this.#hash(input.commitToken) || Date.parse(preview.expires_at) <= this.options.now().getTime()) throw new WorkflowError('WORKFLOW_CONFLICT', '退款预览失效，请重新预览')
      const value = this.#validate(context, preview.payment_id, preview.amount_fen, preview.source_version, expectedVersions)
      if (value.charge.version !== preview.charge_version) throw new WorkflowError('WORKFLOW_CONFLICT', '原费用已变化，请重新预览')
      const now = this.options.virtualTime(context)
      const refund = this.ledger.create(context, { source: value.source, basisId: `outpatient-charge:${value.attempt.chargeItemId}`, ownerKind: 'outpatient', ownerId: value.charge.case_id,
        amountFen: preview.amount_fen, simulatorRule: preview.simulator_rule, createdAt: now })
      this.database.driver.prepare('UPDATE refund_preview SET consumed_at=? WHERE workspace_id=? AND epoch=? AND preview_id=?').run(now, context.workspaceId, context.epoch, previewId)
      return { data: refund, effects: [
        { kind: 'created' as const, reference: `RefundTransaction/${refund.refundId}`, versionId: '1' },
        ...(this.options.onFundsChanged?.(context) ?? []),
      ] }
    })
  }
  recover(context: ActorContext, refundId: string, raw: unknown, expectedVersions: Record<string, string>, idempotencyKey: string) {
    const input = refundRecoverInputSchema.parse(raw)
    return this.commands.execute({ context, contextRequirement: 'current', input: { refundId, ...input }, expectedVersions, idempotencyKey, operation: 'refund.recover', dataSchema: refundResponseSchema.shape.data,
      authorize: () => this.#authorizeRecovery(context) }, () => {
      const attempt = this.ledger.attempt(context, refundId)
      if (attempt === undefined || attempt.ownerKind !== 'outpatient') throw new WorkflowError('WORKFLOW_CONFLICT', '原退款不存在')
      const value = this.#source(context, attempt.sourceId)
      this.#expectedCharge(expectedVersions, value.attempt.chargeItemId)
      const refund = this.ledger.recover(context, refundId, input.expectedRefundVersion, this.options.virtualTime(context))
      return { data: refund, effects: [
        ...(refund.version === attempt.version ? [] : [{ kind: 'created' as const, reference: `RefundResolution/${refundId}`, versionId: '1' }]),
        ...(this.options.onFundsChanged?.(context) ?? []),
      ] }
    })
  }
}
