import { createHash } from 'node:crypto'
import { z } from 'zod'
import { insurancePreviewSchema, type InsuranceSource } from '@clinmesh/contracts/insurance'
import { inpatientFinancialInsuranceCancelInputSchema, inpatientFinancialInsurancePreviewInputSchema,
  inpatientFinancialInsuranceConfirmInputSchema, inpatientFinancialResponseSchema } from '@clinmesh/contracts/inpatient-finance'
import type { ActorContext, CommandEffect } from './command-executor.ts'
import { InpatientError, type InpatientService } from './inpatient-service.ts'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const cycleSchema = z.object({ adjustmentId: z.string(), originalSettlementId: z.string(), compensationId: z.string(), replacementSettlementId: z.string().optional() })

/** A correction composes immutable insurance events with the existing financial Command owner. */
export class InpatientInsuranceAdjustments {
  constructor(readonly owner: InpatientService) {}
  get insurance() { return this.owner.workflow.insurance }
  #cycles(context: ActorContext, admissionId: string) {
    return z.array(cycleSchema).parse(this.owner.database.driver.prepare(`SELECT adjustment_id AS adjustmentId,
      original_settlement_id AS originalSettlementId, compensation_id AS compensationId,
      replacement_id AS replacementSettlementId FROM inpatient_insurance_adjustment
      WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY rowid`).all(context.workspaceId, context.epoch, admissionId)
      .map(row => z.object({ replacementSettlementId: z.string().nullable() }).passthrough().parse(row))
      .map(({ replacementSettlementId, ...row }) => ({ ...row, ...(replacementSettlementId === null ? {} : { replacementSettlementId }) })))
  }
  source(context: ActorContext, admissionId: string, source: InsuranceSource): InsuranceSource {
    const rows = z.array(z.object({ adjustment_id: z.string(), charge_id: z.string(), direction: z.enum(['increase', 'decrease']), amount_fen: z.number().int() })).parse(
      this.owner.database.driver.prepare('SELECT * FROM inpatient_financial_adjustment WHERE workspace_id=? AND epoch=? AND admission_id=? ORDER BY rowid')
        .all(context.workspaceId, context.epoch, admissionId))
    return { ...source, charges: source.charges.map(charge => {
      const changes = rows.filter(row => charge.reference === `ChargeItem/${row.charge_id}`)
      return changes.length === 0 ? charge : { ...charge,
        amountFen: charge.amountFen + changes.reduce((sum, row) => sum + (row.direction === 'increase' ? row.amount_fen : -row.amount_fen), 0),
        version: hash([charge.version, changes]),
      }
    }) }
  }
  projection(context: ActorContext, admissionId: string) {
    const original = this.owner.discharge.snapshot(context, admissionId).insurance
    if (!original) return undefined
    const active = this.insurance.validAllocation(context, original.target)
    const sourceFingerprint = hash(this.source(context, admissionId, original.source))
    return { original, ...(active ? { active } : {}), balance: this.insurance.balance(context, original.source.patientId, original.year),
      sourceFingerprint, ready: active?.sourceFingerprint === sourceFingerprint, cycles: this.#cycles(context, admissionId) }
  }
  #basis(context: ActorContext, admissionId: string, adjustmentId: string) {
    const snapshot = this.owner.financialAdjustments.snapshot(context, admissionId)
    const insurance = snapshot.insurance
    if (!insurance || snapshot.adjustments.at(-1)?.adjustmentId !== adjustmentId)
      throw new InpatientError('INPATIENT_INSURANCE_ADJUSTMENT_REQUIRED', '医保更正须关联当前住院最新财务调整')
    if (snapshot.reservedCollectFen + snapshot.reservedFen > 0 || this.owner.payments.pendingCount(context, admissionId) > 0)
      throw new InpatientError('INPATIENT_FUNDS_PENDING', '资金结果未查明，不能更正医保待遇')
    return { snapshot, insurance, cycle: insurance.cycles.find(row => row.adjustmentId === adjustmentId) }
  }
  cancel(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientFinancialInsuranceCancelInputSchema.parse(raw)
    return this.owner.commands.execute({ context, contextRequirement: 'current', input, idempotencyKey, operation: 'inpatient.financial.insurance.cancel',
      expectedVersions: {}, dataSchema: inpatientFinancialResponseSchema.shape.data, authorize: () => this.owner.financialAdjustments.authorize(context) }, () => {
      const { snapshot, insurance, cycle } = this.#basis(context, input.admissionId, input.adjustmentId)
      if (snapshot.fingerprint !== input.expectedFingerprint || cycle || insurance.active?.id !== input.settlementId
        || insurance.balance.version !== input.expectedBalanceVersion)
        throw new InpatientError('INPATIENT_INSURANCE_PREVIEW_STALE', '待遇或账目已变化，请重新审阅更正依据')
      const effects: CommandEffect[] = []
      const compensation = this.insurance.compensate(context, input.settlementId, effects)
      this.owner.database.driver.prepare('INSERT INTO inpatient_insurance_adjustment VALUES(?,?,?,?,?,?,NULL)')
        .run(context.workspaceId, context.epoch, input.adjustmentId, input.admissionId, input.settlementId, compensation.id)
      effects.push({ kind: 'created', reference: `InpatientInsuranceAdjustment/${input.adjustmentId}`, versionId: '1' })
      return { data: this.owner.financialAdjustments.snapshot(context, input.admissionId), effects }
    })
  }
  preview(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientFinancialInsurancePreviewInputSchema.parse(raw)
    return this.owner.commands.execute({ context, contextRequirement: 'current', input, idempotencyKey, operation: 'inpatient.financial.insurance.preview',
      expectedVersions: {}, dataSchema: insurancePreviewSchema, authorize: () => this.owner.financialAdjustments.authorize(context) }, () => {
      const { snapshot, insurance, cycle } = this.#basis(context, input.admissionId, input.adjustmentId)
      if (snapshot.fingerprint !== input.expectedFingerprint || !cycle || cycle.replacementSettlementId || insurance.active)
        throw new InpatientError('INPATIENT_INSURANCE_PREVIEW_STALE', '请先补偿原待遇，再审阅更正后待遇')
      const source = this.source(context, input.admissionId, insurance.original.source)
      const data = this.insurance.previewForSource(context, source, insurance.original.planCode, insurance.original.year)
      this.owner.database.driver.prepare('INSERT INTO inpatient_insurance_adjustment_preview VALUES(?,?,?,?)')
        .run(context.workspaceId, context.epoch, data.previewId, input.adjustmentId)
      return { data, effects: [{ kind: 'created' as const, reference: `InsurancePreview/${data.previewId}`, versionId: '1' }] }
    })
  }
  confirm(context: ActorContext, raw: unknown, idempotencyKey: string) {
    const input = inpatientFinancialInsuranceConfirmInputSchema.parse(raw)
    return this.owner.commands.execute({ context, contextRequirement: 'current', input, idempotencyKey, operation: 'inpatient.financial.insurance.confirm',
      expectedVersions: {}, dataSchema: inpatientFinancialResponseSchema.shape.data, authorize: () => this.owner.financialAdjustments.authorize(context) }, () => {
      const { insurance, cycle } = this.#basis(context, input.admissionId, input.adjustmentId)
      const binding = this.owner.database.driver.prepare('SELECT 1 FROM inpatient_insurance_adjustment_preview WHERE workspace_id=? AND epoch=? AND preview_id=? AND adjustment_id=?')
        .get(context.workspaceId, context.epoch, input.previewId, input.adjustmentId)
      const { settlement } = this.insurance.reviewedPreview(context, input.previewId, input.commitToken)
      if (!binding || !cycle || cycle.replacementSettlementId || insurance.active || settlement.year !== insurance.original.year
        || settlement.planCode !== insurance.original.planCode || settlement.sourceFingerprint !== insurance.sourceFingerprint
        || settlement.balanceVersion !== insurance.balance.version)
        throw new InpatientError('INPATIENT_INSURANCE_PREVIEW_STALE', '费用或原年度患者余额已变化，请重新预览并审阅')
      const effects: CommandEffect[] = []
      this.insurance.recordSettlement(context, settlement, effects)
      this.owner.database.driver.prepare('UPDATE inpatient_insurance_adjustment SET replacement_id=? WHERE workspace_id=? AND epoch=? AND adjustment_id=?')
        .run(settlement.id, context.workspaceId, context.epoch, input.adjustmentId)
      effects.push({ kind: 'updated', reference: `InpatientInsuranceAdjustment/${input.adjustmentId}`, versionId: '2' })
      return { data: this.owner.financialAdjustments.snapshot(context, input.admissionId), effects }
    })
  }
}
