/** 只适用于合成冠脉造影阶段，独立身份不覆盖既有 PCI 或其他病组参数。 */
export const syntheticAngiographyDrgPaymentParameters = {
  parameterSetId: 'clinmesh-synthetic-angiography-payment', version: '2026-11-02.r1', synthetic: true,
  baseRateFen: 500_000, weightsBp: { FM59: 8_000 },
  note: 'FM59 权重与基础费率为合成医院造影阶段演示参数，不代表任何地区真实医保点值、待遇或医院成本。',
} as const
