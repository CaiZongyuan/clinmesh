import { createHash } from 'node:crypto'
import {
  outpatientInvestigationBillingSchema, outpatientInvestigationPriceSchema,
  type LaboratoryServiceSnapshot, type OutpatientInvestigationPrice,
} from '@clinmesh/contracts/his'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { ActorContext, CommandEffect, CommandTransaction } from './command-executor.ts'
import { readInsuranceCoverage } from './insurance-service.ts'
import { readOutpatientInsuranceAllocations } from './outpatient-insurance.ts'
import { PaymentLedger } from './payment-ledger.ts'
import { WorkflowError } from './workflow-error.ts'

type InvestigationCategory = 'laboratory' | 'imaging' | 'pathology'
const source = 'synthetic-outpatient-investigation-2026-10-26-v1'
const laboratoryPrices: Readonly<Record<string, number>> = {
  'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/laboratory-panel-cn#2026-09-01#CN-LAB-CBC': 2500,
  'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/wst-886-2026#2026#0100101A': 800,
  'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/wst-886-2026#2026#0100501A': 800,
}
const servicePrices: Readonly<Record<string, { category: InvestigationCategory; priceFen: number; unit: string }>> = {
  'imaging-chest-radiograph': { category: 'imaging', priceFen: 8000, unit: '次检查' },
  'imaging-chest-ct-plain': { category: 'imaging', priceFen: 30000, unit: '次检查' },
  'pathology-breast-slide-consultation': { category: 'pathology', priceFen: 20000, unit: '次会诊' },
}

function syntheticPrice(id: string, priceFen: number, unit: string): OutpatientInvestigationPrice {
  return { id: `outpatient-charge-definition-${id}`, version: 1, priceFen, unit, currency: 'CNY', effectiveOn: '2026-08-24', source }
}

/** 编码身份经过明确配置才有合成价格；目录零值始终不是免费。 */
export function laboratoryOutpatientPrice(service: LaboratoryServiceSnapshot): OutpatientInvestigationPrice | undefined {
  if (service.outpatientBilling !== undefined) return service.outpatientBilling
  if (service.priceFen > 0) return {
    ...syntheticPrice(service.id, service.priceFen, '项目'),
    source: 'published-synthetic-laboratory-price', version: service.version,
  }
  const coding = service.referenceConcept
  const priceFen = laboratoryPrices[`${coding.system}#${coding.version}#${coding.code}`]
  return priceFen === undefined ? undefined : syntheticPrice(service.id, priceFen, '项目')
}

export function serviceOutpatientPrice(category: 'imaging' | 'pathology', serviceId: string): OutpatientInvestigationPrice | undefined {
  const price = servicePrices[serviceId]
  return price?.category === category ? syntheticPrice(serviceId, price.priceFen, price.unit) : undefined
}

const rowSchema = z.object({
  request_id: z.string(), case_id: z.string(), payment_policy: z.enum(['legacy-unbilled', 'prepaid-v1']),
  charge_item_id: z.string().min(1).nullable(), price_json: z.string().min(1).nullable(), released_at: z.string().datetime({ offset: true }).nullable(),
  release_json: z.string().nullable(), status: z.enum(['issued', 'accepted', 'in-progress', 'generation-failed', 'reported', 'acknowledged', 'cancelled']), request_kind: z.enum(['laboratory', 'imaging', 'pathology']),
  total_fen: z.number().int().nonnegative().nullable(), charge_version: z.number().int().positive().nullable(),
}).refine(row => row.payment_policy === 'legacy-unbilled' || (
  row.charge_item_id !== null && row.price_json !== null && row.total_fen !== null && row.charge_version !== null
), '预付费原申请必须保留完整的原费用与价格')
type BillingRow = z.infer<typeof rowSchema>
const releaseSchema = z.object({
  chargeItemId: z.string().min(1), chargeVersion: z.number().int().positive(),
  paidFen: z.number().int().nonnegative(), insuranceFen: z.number().int().nonnegative(), amountFen: z.number().int().positive(),
}).strict().refine(release => release.paidFen + release.insuranceFen >= release.amountFen, '财务放行快照必须足额覆盖原费用')

/** 原申请拥有门诊应收与一次性放行；资金事实仍由共享账务拥有。 */
export class OutpatientInvestigationBilling {
  readonly #ledger: PaymentLedger
  constructor(private readonly database: ClinMeshDatabase) { this.#ledger = new PaymentLedger(database) }

  priceForLaboratory(service: LaboratoryServiceSnapshot) { return laboratoryOutpatientPrice(service) }
  priceForPublishedLaboratory(item: { id: string; version: number; priceFen: number }) {
    return item.priceFen <= 0 ? undefined : {
      ...syntheticPrice(item.id, item.priceFen, '项目'), version: item.version,
      source: 'published-synthetic-laboratory-price',
    }
  }
  priceForService(category: 'imaging' | 'pathology', serviceId: string) { return serviceOutpatientPrice(category, serviceId) }

  issue(transaction: CommandTransaction, context: ActorContext, input: {
    requestId: string; serviceRequestId: string; caseId: string; category: InvestigationCategory
    descriptionZh: string; descriptionEn: string; price: OutpatientInvestigationPrice | undefined; now: string
  }) {
    const price = input.price
    const virtualDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(input.now))
    if (price === undefined || price.effectiveOn > virtualDate) throw new WorkflowError('CATALOG_CONFLICT', '缺少当前有效的本院门诊价格，请配置价格后重新保存并审阅申请')
    const owner = z.object({ account_id: z.string(), patient_id: z.string(), encounter_id: z.string() }).parse(
      this.database.driver.prepare('SELECT account_id,patient_id,encounter_id FROM outpatient_case WHERE workspace_id=? AND epoch=? AND case_id=?')
        .get(context.workspaceId, context.epoch, input.caseId),
    )
    const chargeItem = transaction.fhir.create(context, {
      resourceType: 'ChargeItem', id: uuidv7(), status: 'billable', code: { text: input.descriptionZh },
      subject: { reference: `Patient/${owner.patient_id}` }, encounter: { reference: `Encounter/${owner.encounter_id}` },
      account: [{ reference: `Account/${owner.account_id}` }], occurrenceDateTime: input.now,
      quantity: { value: 1, unit: price.unit }, service: [{ reference: { reference: `ServiceRequest/${input.serviceRequestId}` } }],
      unitPriceComponent: { type: 'base', amount: { currency: price.currency, value: price.priceFen / 100 } },
      note: [{ text: `${price.source}; ${price.id}; version ${price.version}` }],
    })
    this.database.driver.prepare(`INSERT INTO charge_record (
      workspace_id,epoch,charge_id,case_id,account_id,charge_item_id,category,source_reference,
      description_zh,description_en,quantity,unit_price_fen,total_fen,status,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,'billable',?)`).run(
      context.workspaceId, context.epoch, uuidv7(), input.caseId, owner.account_id, chargeItem.id, input.category,
      `ServiceRequest/${input.serviceRequestId}`, input.descriptionZh, input.descriptionEn, price.priceFen, price.priceFen, input.now,
    )
    this.database.driver.prepare(`INSERT INTO outpatient_investigation_billing
      (workspace_id,epoch,request_id,case_id,payment_policy,charge_item_id,price_json)
      VALUES(?,?,?,?,'prepaid-v1',?,?)`).run(context.workspaceId, context.epoch, input.requestId, input.caseId, chargeItem.id, JSON.stringify(price))
    return {
      billing: this.read(context, input.requestId)!,
      effects: [{ kind: 'created' as const, reference: `ChargeItem/${chargeItem.id}`, versionId: chargeItem.meta?.versionId ?? '1' }],
    }
  }

  #row(context: ActorContext, requestId: string) {
    return rowSchema.optional().parse(this.database.driver.prepare(`
      SELECT billing.*, request.status,request.request_kind, charge.total_fen,charge.version AS charge_version
      FROM outpatient_investigation_billing billing
      JOIN laboratory_request request USING(workspace_id,epoch,request_id)
      LEFT JOIN charge_record charge ON charge.workspace_id=billing.workspace_id AND charge.epoch=billing.epoch
        AND charge.charge_item_id=billing.charge_item_id
      WHERE billing.workspace_id=? AND billing.epoch=? AND billing.request_id=?
    `).get(context.workspaceId, context.epoch, requestId))
  }

  #prepaid(row: BillingRow | undefined): row is BillingRow & { charge_item_id: string; price_json: string; total_fen: number; charge_version: number } {
    return row?.payment_policy === 'prepaid-v1' && row.charge_item_id !== null && row.price_json !== null && row.total_fen !== null && row.charge_version !== null
  }

  #assertKnownPolicy(context: ActorContext, requestId: string, row: BillingRow | undefined): void {
    if (row !== undefined) return
    const scope = z.object({ admission_id: z.string().nullable() }).parse(this.database.driver.prepare(`
      SELECT context.admission_id FROM laboratory_request request JOIN clinical_request_context context
        ON context.workspace_id=request.workspace_id AND context.epoch=request.epoch AND context.case_id=request.case_id
      WHERE request.workspace_id=? AND request.epoch=? AND request.request_id=?
    `).get(context.workspaceId, context.epoch, requestId))
    if (scope.admission_id === null) throw new WorkflowError('WORKFLOW_CONFLICT', '原门诊检查缺少持久化计费策略，不能绕过财务门禁')
  }

  #money(context: ActorContext, row: BillingRow & { charge_item_id: string; total_fen: number }) {
    const balance = this.#ledger.balance(context, row.charge_item_id)
    const insuranceFen = readInsuranceCoverage(this.database, context, `ChargeItem/${row.charge_item_id}`)
    const adjustedFen = z.object({ value: z.number().int().nonnegative() }).parse(this.database.driver.prepare(`
      SELECT COALESCE(SUM(amount_fen),0) AS value FROM financial_charge_adjustment WHERE workspace_id=? AND epoch=? AND charge_item_id=?
    `).get(context.workspaceId, context.epoch, row.charge_item_id)).value
    return { ...balance, insuranceFen, adjustedFen, remainingFen: Math.max(0, row.total_fen - adjustedFen - balance.paidFen - insuranceFen) }
  }

  read(context: ActorContext, requestId: string) {
    const row = this.#row(context, requestId)
    if (!this.#prepaid(row)) return undefined
    const money = this.#money(context, row)
    return outpatientInvestigationBillingSchema.parse({
      chargeItemId: row.charge_item_id, price: outpatientInvestigationPriceSchema.parse(JSON.parse(row.price_json)),
      quantity: 1, paidFen: money.paidFen, insuranceFen: money.insuranceFen, remainingFen: money.remainingFen,
      ...(row.released_at === null ? {} : { releasedAt: row.released_at }),
      status: row.status === 'cancelled' ? 'cancelled' : money.unresolved > 0 ? 'ambiguous'
        : money.remainingFen === 0 ? 'paid' : money.paidFen + money.insuranceFen > 0 ? 'partial' : 'pending',
    })
  }

  #requestIdForCharge(context: ActorContext, chargeItemId: string): string | undefined {
    return z.object({ request_id: z.string() }).optional().parse(this.database.driver.prepare(`
      SELECT request_id FROM outpatient_investigation_billing
      WHERE workspace_id=? AND epoch=? AND charge_item_id=? AND payment_policy='prepaid-v1'
    `).get(context.workspaceId, context.epoch, chargeItemId))?.request_id
  }

  readByCharge(context: ActorContext, chargeItemId: string) {
    const requestId = this.#requestIdForCharge(context, chargeItemId)
    if (requestId === undefined) return undefined
    const billing = this.read(context, requestId)
    return billing === undefined ? undefined : { requestId, billing }
  }

  enqueueIfPaid(transaction: CommandTransaction, context: ActorContext, chargeItemId: string): boolean {
    const requestId = this.#requestIdForCharge(context, chargeItemId)
    if (requestId === undefined) return false
    const row = this.#row(context, requestId)
    if (!this.#prepaid(row) || row.status !== 'issued' || row.released_at !== null) return true
    const money = this.#money(context, row)
    if (money.unresolved > 0 || money.remainingFen !== 0) return true
    const revision = createHash('sha256').update(JSON.stringify([row.charge_version, money.paidFen, money.insuranceFen])).digest('hex')
    transaction.enqueue({ dedupKey: `outpatient-investigation:${row.request_id}:accept:${revision}`, kind: `${row.request_kind}.accept-request`, payload: { requestId: row.request_id } })
    return true
  }

  /** 旧门诊与住院不重定价；首次受理将资金许可与临床状态放在同一事务。 */
  assertAndRelease(context: ActorContext, requestId: string, now: string): void {
    const row = this.#row(context, requestId)
    this.#assertKnownPolicy(context, requestId, row)
    if (!this.#prepaid(row)) return
    const money = this.#money(context, row)
    if (row.status === 'cancelled' || money.unresolved > 0 || money.remainingFen !== 0) {
      throw new WorkflowError('WORKFLOW_CONFLICT', '原检查申请尚未收齐费用，或原收退款结果仍待确认')
    }
    this.database.driver.prepare(`UPDATE outpatient_investigation_billing SET released_at=?,release_json=?
      WHERE workspace_id=? AND epoch=? AND request_id=? AND released_at IS NULL`).run(now, JSON.stringify({
      chargeItemId: row.charge_item_id, chargeVersion: row.charge_version, paidFen: money.paidFen,
      insuranceFen: money.insuranceFen, amountFen: row.total_fen - money.adjustedFen,
    }), context.workspaceId, context.epoch, requestId)
  }

  assertReleased(context: ActorContext, requestId: string): void {
    const row = this.#row(context, requestId)
    this.#assertKnownPolicy(context, requestId, row)
    if (!this.#prepaid(row)) return
    if (row.released_at === null || row.release_json === null || row.status === 'cancelled') {
      throw new WorkflowError('WORKFLOW_CONFLICT', '原检查申请尚未取得财务放行许可')
    }
    const release = releaseSchema.parse(JSON.parse(row.release_json))
    if (release.chargeItemId !== row.charge_item_id) throw new WorkflowError('WORKFLOW_CONFLICT', '财务放行许可与原费用不匹配')
  }

  cancel(transaction: CommandTransaction, context: ActorContext, requestId: string, now: string, reasonCode: string): CommandEffect[] {
    const row = this.#row(context, requestId)
    if (!this.#prepaid(row)) return []
    const money = this.#money(context, row)
    if (money.unresolved > 0) throw new WorkflowError('WORKFLOW_CONFLICT', '请先查明原收款或退款结果，再取消检查')
    if (readOutpatientInsuranceAllocations(this.database, context, row.case_id).has(`ChargeItem/${row.charge_item_id}`)) {
      throw new WorkflowError('WORKFLOW_CONFLICT', '请收费员先撤销本检查的有效医保待遇，再取消检查')
    }
    const amountFen = row.total_fen - money.adjustedFen
    if (amountFen === 0) return []
    const adjustmentId = uuidv7()
    this.database.driver.prepare('INSERT INTO financial_charge_adjustment VALUES(?,?,?,?,?,?,?,?)').run(
      context.workspaceId, context.epoch, adjustmentId, row.charge_item_id, amountFen,
      `取消原检查申请 ${requestId}：${reasonCode}`, JSON.stringify({ requestId, status: row.status, cause: 'clinical-request-cancelled' }), now,
    )
    const chargeItem = transaction.fhir.read(context, 'ChargeItem', row.charge_item_id)
    const updated = transaction.fhir.update(context, {
      ...chargeItem, status: 'not-billable',
      note: [...(Array.isArray(chargeItem.note) ? chargeItem.note : []), { text: `取消原申请 ${requestId}，冲减 ${amountFen} 分，退款另行办理。` }],
    }, chargeItem.meta?.versionId ?? String(row.charge_version))
    this.database.driver.prepare('UPDATE charge_record SET version=version+1 WHERE workspace_id=? AND epoch=? AND charge_item_id=?')
      .run(context.workspaceId, context.epoch, row.charge_item_id)
    return [
      { kind: 'created', reference: `ChargeAdjustment/${adjustmentId}`, versionId: '1' },
      { kind: 'updated', reference: `ChargeItem/${row.charge_item_id}`, versionId: updated.meta?.versionId ?? String(row.charge_version + 1) },
    ]
  }

  pendingCancellationRefundChargeIds(context: ActorContext): string[] {
    const targets = z.array(z.object({ request_id: z.string() })).parse(this.database.driver.prepare(`
      SELECT billing.request_id FROM outpatient_investigation_billing billing
      JOIN laboratory_request request USING(workspace_id,epoch,request_id)
      JOIN outpatient_case cases ON cases.workspace_id=billing.workspace_id AND cases.epoch=billing.epoch AND cases.case_id=billing.case_id
      WHERE billing.workspace_id=? AND billing.epoch=? AND cases.scenario_run_id=? AND billing.payment_policy='prepaid-v1' AND request.status='cancelled'
    `).all(context.workspaceId, context.epoch, context.scenarioRunId))
    return targets.flatMap(({ request_id }) => {
      const row = this.#row(context, request_id)
      if (!this.#prepaid(row)) return []
      const money = this.#money(context, row)
      return money.paidFen > 0 || money.unresolved > 0 ? [row.charge_item_id] : []
    })
  }

  hasPendingCancellationRefunds(context: ActorContext): boolean {
    return this.pendingCancellationRefundChargeIds(context).length > 0
  }
}
