/**
 * 固定版本合成医院 DRG 支付参数：独立身份，仅覆盖明确列出的演示病组；
 * 未列出的病组按参数缺口如实报告，不用通用分组结果乘以任何地区真实点值。
 */
export const syntheticDrgPaymentParameters = {
  parameterSetId: 'clinmesh-synthetic-hospital-drg-payment',
  version: '2026-demo-1',
  baseRateFen: 500_000,
  /** 万分位权重，只声明实际覆盖的病组。 */
  weightsBp: { RA15: 6_000 } as Record<string, number>,
  note: '模拟核定基于固定版本合成支付参数（仅覆盖列出病组），支付额=基础费率×权重；'
    + '差异为模拟核定支付额与正式收费净额之差，不构成完整盈亏，不代表任何地区真实结算，不触发患者退款。',
} as const
