import { scenarioModules } from '@clinmesh/contracts/scenario'

const labels = {
  fever: { 'en-US': 'Fever outpatient', 'zh-CN': '发热门诊' },
  hypertension: { 'en-US': 'Hypertension', 'zh-CN': '高血压' },
  'type-2-diabetes': { 'en-US': 'Type 2 diabetes', 'zh-CN': '2 型糖尿病' },
} as const

export const scenarioModuleOptions = scenarioModules.map(value => ({
  label: labels[value],
  value,
}))
