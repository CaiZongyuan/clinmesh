import {
  insurancePlans,
  type InsuranceAllocation,
  type InsuranceBalance,
  type InsurancePlanCode,
  type InsuranceSource,
} from '@clinmesh/contracts/insurance'

export type InsuranceTier = 'A' | 'B' | 'C'

export function insuranceTier(coverage: { included: boolean; priorSelfPayBps: number }): InsuranceTier {
  if (!coverage.included) return 'C'
  return coverage.priorSelfPayBps === 0 ? 'A' : 'B'
}

export function splitItemCoverage(
  amountFen: number,
  coverage: { included: boolean; priorSelfPayBps: number },
): { outsideFen: number; priorSelfPayFen: number; eligibleFen: number } {
  const outsideFen = coverage.included ? 0 : amountFen
  const priorSelfPayFen = coverage.included
    ? Number((BigInt(amountFen) * BigInt(coverage.priorSelfPayBps)) / 10000n)
    : 0
  return { outsideFen, priorSelfPayFen, eligibleFen: amountFen - outsideFen - priorSelfPayFen }
}

/** 确定性按比例将收费员冲减后的净额分配回处方明细，保证明细合计精确等于 targetTotalFen。 */
export function adjustChargeItemsToTotal<T extends { amountFen: number }>(
  items: readonly T[],
  targetTotalFen: number,
): T[] {
  if (!Number.isSafeInteger(targetTotalFen) || targetTotalFen < 0) {
    throw new Error('Adjusted charge total must be a non-negative safe integer')
  }
  const originalTotal = items.reduce((sum, item) => sum + item.amountFen, 0)
  if (targetTotalFen === originalTotal) return items.map(item => ({ ...item }))
  if (targetTotalFen > originalTotal) {
    throw new Error('Adjusted charge total cannot exceed original item sum')
  }
  if (targetTotalFen === 0 || originalTotal === 0) {
    return items.map(item => ({ ...item, amountFen: 0 }))
  }
  const denom = BigInt(originalTotal)
  const target = BigInt(targetTotalFen)
  const parts = items.map((item, index) => {
    const numerator = BigInt(item.amountFen) * target
    return { index, base: Number(numerator / denom), remainder: numerator % denom }
  })
  let leftover = targetTotalFen - parts.reduce((sum, part) => sum + part.base, 0)
  const ranked = [...parts].sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1))
  const amounts = parts.map(part => part.base)
  for (const entry of ranked) {
    if (leftover <= 0) break
    amounts[entry.index] = amounts[entry.index]! + 1
    leftover -= 1
  }
  return items.map((item, index) => ({ ...item, amountFen: amounts[index]! }))
}

export type InsuranceBenefitBalanceInput = Pick<
  InsuranceBalance,
  'planCode' | 'accountFen' | 'outpatientEligibleFen' | 'outpatientFundFen' | 'inpatientEligibleFen' | 'inpatientFundFen'
>

export class InsuranceItemSumMismatchError extends Error {
  constructor(reference: string, expectedFen: number, actualFen: number) {
    super(`Charge ${reference} item sum ${actualFen} does not match charge amount ${expectedFen}`)
    this.name = 'InsuranceItemSumMismatchError'
  }
}

/** 按品规明细与年度余额以整数分计算每笔 ChargeItem 的合成医保分摊。 */
export function allocateInsuranceBenefits(input: {
  source: InsuranceSource
  planCode: InsurancePlanCode
  balance: InsuranceBenefitBalanceInput
}): InsuranceAllocation[] {
  const plan = insurancePlans[input.planCode]
  const parameters = plan[input.source.target.kind]
  let deductible = Math.max(
    0,
    parameters.deductibleFen - (
      input.source.target.kind === 'outpatient'
        ? input.balance.outpatientEligibleFen
        : input.balance.inpatientEligibleFen
    ),
  )
  let cap = Math.max(
    0,
    parameters.capFen - (
      input.source.target.kind === 'outpatient'
        ? input.balance.outpatientFundFen
        : input.balance.inpatientFundFen
    ),
  )
  let account = input.balance.planCode === undefined ? plan.initialAccountFen : input.balance.accountFen
  return input.source.charges.map((charge) => {
    let outsideFen: number
    let priorSelfPayFen: number
    let eligibleFen: number
    let items: InsuranceAllocation['items']
    if (charge.items !== undefined && charge.items.length > 0) {
      const actualSum = charge.items.reduce((sum, item) => sum + item.amountFen, 0)
      if (actualSum !== charge.amountFen) {
        throw new InsuranceItemSumMismatchError(charge.reference, charge.amountFen, actualSum)
      }
      items = charge.items.map((item) => {
        const split = splitItemCoverage(item.amountFen, item.coverage)
        return {
          ...(item.id === undefined ? {} : { id: item.id }),
          label: item.label,
          ...(item.quantity === undefined ? {} : { quantity: item.quantity }),
          amountFen: item.amountFen,
          coverage: item.coverage,
          ...split,
        }
      })
      outsideFen = items.reduce((sum, item) => sum + item.outsideFen, 0)
      priorSelfPayFen = items.reduce((sum, item) => sum + item.priorSelfPayFen, 0)
      eligibleFen = charge.amountFen - outsideFen - priorSelfPayFen
    } else {
      const split = splitItemCoverage(charge.amountFen, charge.coverage)
      outsideFen = split.outsideFen
      priorSelfPayFen = split.priorSelfPayFen
      eligibleFen = split.eligibleFen
    }
    const deductibleFen = Math.min(eligibleFen, deductible)
    deductible -= deductibleFen
    const fundFen = Math.min(
      cap,
      Number((BigInt(eligibleFen - deductibleFen) * BigInt(parameters.ratioBps)) / 10000n),
    )
    cap -= fundFen
    // 目录外费用由患者承担，个人账户仅抵扣目录内个人负担。
    const accountFen = Math.min(account, charge.amountFen - outsideFen - fundFen)
    account -= accountFen
    return {
      reference: charge.reference,
      amountFen: charge.amountFen,
      outsideFen,
      priorSelfPayFen,
      eligibleFen,
      deductibleFen,
      fundFen,
      accountFen,
      patientFen: charge.amountFen - fundFen - accountFen,
      ...(items === undefined ? {} : { items }),
    }
  })
}
