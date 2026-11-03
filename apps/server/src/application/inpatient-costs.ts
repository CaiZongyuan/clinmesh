import { inpatientCostsSchema, inpatientSurgeryUsageSchema, type InpatientSurgeryUsage, type InpatientCosts, type InpatientDrgSimulation } from '@clinmesh/contracts/inpatient-drg-simulation'
import type { ActorContext } from './command-executor.ts'
import { InpatientError, type InpatientService } from './inpatient-service.ts'
import { canonicalJsonHash } from './scenario-data/canonical-json.ts'

/** 仅从当前岗位可见的正式事实和既有计价器读取；不依赖模型或持续跟进授权。 */
export function readInpatientCosts(owner: InpatientService, context: ActorContext, admissionId: string,
  planned?: { requestId: string; items: Array<{ materialId: string; catalogVersion: number; quantity: number; unitPriceFen: number; display: string }> },
  evaluated?: InpatientDrgSimulation | null) {
  let simulation = evaluated ?? null
  if (evaluated === undefined) try { simulation = owner.drg.simulate(context, admissionId, undefined) }
  catch (error) { if (!(error instanceof InpatientError) || error.code !== 'DRG_RULES_NOT_CONFIGURED') throw error }
  const priced = planned === undefined && simulation !== null ? simulation : owner.drg.costProjection(context, admissionId, undefined, planned)
  const sum = (items: typeof priced.committed.items) => items.reduce((total, item) => total + (item.estimatedFen ?? 0), 0)
  const currentGrouping = simulation?.grouping.formal ?? null, projectedGrouping = simulation?.grouping.projected ?? null
  const currentPaymentReference = simulation?.paymentReference ?? null
  const projectedPaymentReference = projectedGrouping === null ? null : owner.drg.paymentReference(projectedGrouping)
  const components = { formalChargesFen: priced.formal.chargesFen,
    pendingOrdersFen: sum(priced.committed.items.filter(item => item.kind !== 'surgery')),
    remainingMaterialsFen: sum(priced.reserved.items),
    plannedSurgeryFen: sum(priced.committed.items.filter(item => item.kind === 'surgery')),
    projectedTotalFen: priced.coverage.estimatedTotalFen }
  const paymentStatus = simulation === null ? 'rules-unavailable' : currentGrouping?.status !== 'grouped' ? 'grouping-incomplete'
    : currentPaymentReference === null ? 'reference-missing' : 'available'
  const facts = { components, currentGrouping, projectedGrouping, currentPaymentReference, projectedPaymentReference,
    currentDifferenceFen: currentPaymentReference === null ? null : currentPaymentReference.referenceFen - components.projectedTotalFen,
    projectedDifferenceFen: projectedPaymentReference === null ? null : projectedPaymentReference.referenceFen - components.projectedTotalFen,
    paymentStatus, paymentMessage: paymentStatus === 'rules-unavailable' ? '医院尚未启用医保分组'
      : paymentStatus === 'grouping-incomplete' ? '诊断或手术记录不全，暂时无法分组'
        : paymentStatus === 'reference-missing' ? `已分到${currentGrouping!.drgCode}组，但暂无支付参考，金额暂不可估`
          : '医院支付参考与患者医保待遇分别核对；费用说明不改变临床选择。',
    exceptionAlert: currentPaymentReference === null || currentPaymentReference.referenceFen <= 0 ? 'unknown'
      : BigInt(components.formalChargesFen) > 3n * BigInt(currentPaymentReference.referenceFen) ? 'triggered' : 'below-threshold' }
  return inpatientCostsSchema.parse({ ...facts, fingerprint: canonicalJsonHash(facts) })
}

export function assertInpatientCostExplanation(explanation: string | null, costs?: InpatientCosts | null,
  usage: ReadonlyArray<Pick<InpatientSurgeryUsage, 'usedFen' | 'additionalFen'>> = []) {
  if (explanation === null) return
  if (!costs) throw new InpatientError('INPATIENT_DRG_COST_EXPLANATION_INVALID', '费用说明缺少确定性金额依据')
  const amounts = [...Object.values(costs.components), costs.currentPaymentReference?.referenceFen, costs.projectedPaymentReference?.referenceFen,
    costs.currentDifferenceFen, costs.projectedDifferenceFen, ...usage.flatMap(item => [item.usedFen, item.additionalFen]),
    usage.reduce((sum, item) => sum + item.usedFen, 0), usage.reduce((sum, item) => sum + item.additionalFen, 0)]
    .filter((amount): amount is number => amount != null)
  const compact = (value: string) => value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value
  const fen = new Set(amounts.map(String))
  const yuan = new Set(amounts.map(amount => {
    const absolute = BigInt(Math.abs(amount))
    return compact(`${amount < 0 ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`)
  }))
  const normalized = explanation.normalize('NFKC').replaceAll('−', '-')
    .replace(/\b(?:CNY|RMB)\s*(?=[+-]?\d)/gi, '¥').replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, '')
  const mentioned = [...normalized.matchAll(/(?<![A-Za-z0-9])-?\d+(?:\.\d+)?(?![A-Za-z0-9])/g),
    ...normalized.matchAll(/(?<!\d)-?\d+(?:\.\d+)?(?=\s*(?:万元|元|分))/g)]
  const supported = mentioned.every(match => {
    const value = compact(match[0]), after = normalized.slice(match.index + match[0].length).trimStart()
    if (after.startsWith('万')) return false
    if (after.startsWith('分')) return fen.has(value)
    if (after.startsWith('元') || /[￥¥]$|人民币$/.test(normalized.slice(0, match.index).trimEnd())) return yuan.has(value)
    return false
  })
  if (!supported || /[零〇一二三四五六七八九十百千万亿两壹贰叁肆伍陆柒捌玖拾佰仟萬億]+[元分圆块]/.test(normalized)
    || /\d[eE][+-]?\d/.test(normalized))
    throw new InpatientError('INPATIENT_DRG_COST_EXPLANATION_INVALID', '费用说明含有确定性费用块之外的金额或单位')
}

export function readInpatientSurgeryUsage(owner: InpatientService, context: ActorContext, admissionId: string) {
  const surgery = owner.surgery.read(context, admissionId), selection = owner.pciSelection.read(context, admissionId)
  const usage: InpatientSurgeryUsage[] = []
  for (const execution of [...surgery.inProgress, ...surgery.executions]) {
    const basis = owner.materialPlans.forRequest(context, admissionId, execution.requestId)
    const plan = basis.history.find(item => item.reference === basis.effectiveReference)
    const selected = selection.confirmation?.parameters.requestId === execution.requestId
    const planned = plan?.items ?? (selected ? selection.candidates.filter(item => item.eligibility === 'valid' && item.item !== null)
      .map(item => ({ materialId: item.materialId, catalogVersion: item.materialVersion, display: item.item!.display,
        quantity: item.expectedQuantity!, unit: item.item!.chargeDefinition.unit, unitPriceFen: item.item!.chargeDefinition.priceFen })) : [])
    const keys = new Set([...planned.map(item => `${item.materialId}@${item.catalogVersion}`),
      ...execution.materials.map(use => `${use.item.id}@${use.item.version}`)])
    for (const key of keys) {
      const item = planned.find(item => `${item.materialId}@${item.catalogVersion}` === key)
      const uses = execution.materials.filter(use => `${use.item.id}@${use.item.version}` === key), material = uses[0]?.item
      const quantity = item?.quantity ?? (plan || selected ? 0 : null)
      const actualQuantity = uses.reduce((sum, use) => sum + use.quantity, 0)
      const excessQuantity = quantity === null ? 0 : Math.max(0, actualQuantity - quantity)
      usage.push(inpatientSurgeryUsageSchema.parse({ requestId: execution.requestId, executionId: execution.id,
        procedureDisplay: execution.actualProcedure.coding.display, materialId: item?.materialId ?? material!.id,
        catalogVersion: item?.catalogVersion ?? material!.version, display: item?.display ?? material!.display,
        unit: item?.unit ?? material!.chargeDefinition.unit, plannedQuantity: quantity, actualQuantity,
        remainingQuantity: quantity === null ? null : Math.max(0, quantity - actualQuantity), unplanned: quantity === 0 && actualQuantity > 0,
        excessQuantity, usedFen: uses.reduce((sum, use) => sum + use.amountFen, 0),
        additionalFen: excessQuantity * (item?.unitPriceFen ?? material!.chargeDefinition.priceFen) }))
    }
  }
  return usage
}
