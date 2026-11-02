import { test } from './inpatient-pci.fixture.ts'
import { prepareDrgRecordChecksBrowser, runDrgRecordChecksJourney, runDrgRecordChecksReadFailureJourney } from './inpatient-drg-record-checks.journey.ts'

test('真实住院页面无需跟进直接核对，展开解释复用且依据变化失效，返回原记录', async ({ page, pciAgentApp }) => {
  const prepared = await prepareDrgRecordChecksBrowser(pciAgentApp)
  await runDrgRecordChecksJourney(page, pciAgentApp, prepared, () => page.goto(`${pciAgentApp.origin}/inpatient`).then(() => undefined))
})

test('真实住院页面核对读取失败不冒充无差异，刷新后恢复规则结果', async ({ page, pciAgentApp }) => {
  const prepared = await prepareDrgRecordChecksBrowser(pciAgentApp)
  await runDrgRecordChecksReadFailureJourney(page, pciAgentApp, prepared, () => page.goto(`${pciAgentApp.origin}/inpatient`).then(() => undefined))
})
