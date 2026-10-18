import type { SimAssessment, SimCase, SimClinical, SimDraftLine, SimRules } from '@clinmesh/contracts/drg'

/** 单价保留最多六位小数，整数数量只在行边界四舍五入为分。 */
export function quoteFen(price: string | null, quantity: number): number | null {
  if (price === null) return null
  const [whole = '0', fraction = ''] = price.split('.')
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))
  const fen = (micros * BigInt(quantity) + 5_000n) / 10_000n
  if (fen > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('金额超出安全范围')
  return Number(fen)
}

export function simulateGroup(clinical: SimClinical, rules: SimRules): SimAssessment['group'] {
  if (clinical.mainDiagnosisId !== rules.mainDiagnosisId) return null
  if (clinical.completedProcedureIds.includes(rules.completedProcedureId)) return {
    code: 'SIM-PNEUMONIA-PROCEDURE', name: '肺炎伴已确认操作（模拟）', referenceFen: rules.procedurePaymentFen,
    reason: '模拟规则：主诊断为肺炎且已确认指定操作完成。',
  }
  if (clinical.secondaryDiagnosisIds.includes(rules.complicationId)) return {
    code: 'SIM-PNEUMONIA-COMPLEX', name: '肺炎伴呼吸衰竭（模拟）', referenceFen: rules.complicationPaymentFen,
    reason: '模拟规则：肺炎主诊断伴已确认的呼吸衰竭诊断。',
  }
  return { code: 'SIM-PNEUMONIA', name: '肺炎基础组（模拟）', referenceFen: rules.basePaymentFen,
    reason: '模拟规则：已确认肺炎主诊断，未命中模拟操作或并发症规则。' }
}

export function assessSimulation(state: SimCase, draft: readonly SimDraftLine[] = [], clinical = state.clinical): SimAssessment {
  const { mappings, rules } = state.configuration
  const group = simulateGroup(clinical, rules)
  const missing: string[] = []
  if (group === null) missing.push('该主诊断尚无模拟分组或支付规则')
  let incurredChargeFen = state.baseChargeFen
  let committedChargeFen = 0
  let incurredCostFen = state.baseCostFen
  let committedCostFen = 0
  let draftChargeFen = 0
  let draftCostFen = 0
  let chargeComplete = true
  let costComplete = true
  for (const line of state.lines) {
    if (line.chargeState !== 'reversed') {
      if (line.chargeFen === null) { chargeComplete = false; missing.push(`${line.mapping.name}：收费价待补全`) }
      else if (line.chargeState === 'incurred') incurredChargeFen += line.chargeFen
      else committedChargeFen += line.chargeFen
    }
    if (line.costState !== 'released') {
      if (line.costFen === null) { costComplete = false; missing.push(`${line.mapping.name}：成本待核算`) }
      else if (line.costState === 'incurred') incurredCostFen += line.costFen
      else committedCostFen += line.costFen
    }
  }
  const byId = new Map(mappings.map(item => [item.id, item]))
  for (const line of draft) {
    const mapping = byId.get(line.mappingId)
    if (mapping === undefined) throw new Error('院内模拟映射不存在')
    const applicable = state.simulationDate >= mapping.validFrom && state.simulationDate <= mapping.validTo
    const charge = applicable ? quoteFen(mapping.chargePrice, line.quantity) : null
    const cost = applicable ? quoteFen(mapping.costPrice, line.quantity) : null
    if (!applicable) missing.push(`${mapping.name}：模拟价格不在适用日期内`)
    if (charge === null) { chargeComplete = false; missing.push(`${mapping.name}：收费价待补全`) }
    else draftChargeFen += charge
    if (cost === null) { costComplete = false; missing.push(`${mapping.name}：成本待核算`) }
    else draftCostFen += cost
  }
  const knownChargeFen = incurredChargeFen + committedChargeFen + draftChargeFen + state.reserveChargeFen
  const knownCostFen = incurredCostFen + committedCostFen + draftCostFen + state.reserveCostFen
  const payment = group?.referenceFen
  return {
    group, incurredChargeFen, committedChargeFen, draftChargeFen, reserveChargeFen: state.reserveChargeFen,
    incurredCostFen, committedCostFen, draftCostFen, reserveCostFen: state.reserveCostFen,
    knownChargeFen, knownCostFen,
    totalChargeFen: chargeComplete ? knownChargeFen : null,
    totalCostFen: costComplete ? knownCostFen : null,
    chargeProgress: payment === undefined || !chargeComplete ? null : knownChargeFen / payment,
    remainingFen: payment === undefined || !chargeComplete ? null : payment - knownChargeFen,
    costBalanceFen: payment === undefined || !costComplete ? null : payment - knownCostFen,
    costBalanceRatio: payment === undefined || !costComplete ? null : (payment - knownCostFen) / payment,
    missing: [...new Set(missing)],
    coverage: '合成住院病例：基线费用、模拟医嘱、独立后续预留；成本为已覆盖成本估算，收入假设等于模拟参考额。预留不包含本页新增医嘱。',
  }
}
