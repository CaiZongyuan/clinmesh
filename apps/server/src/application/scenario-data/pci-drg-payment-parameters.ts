/** 独立的合成参数摘录；FM39 是联合验收目标，并非准备资料时产生的分组结果。 */
export const syntheticPciDrgPaymentParameters = {
  parameterSetId: 'clinmesh-synthetic-pci-payment',
  version: '2026-10-25.r1',
  synthetic: true as const,
  baseRateFen: 500_000,
  weightsBp: { FM39: 24_000 },
  note: 'FM39 权重与基础费率均为合成医院演示参数，金额由既有核定算法计算；不代表地区结算标准或真实成本。',
}
