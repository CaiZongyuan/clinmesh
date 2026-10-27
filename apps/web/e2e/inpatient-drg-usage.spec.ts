import { test } from './inpatient-pci.fixture.ts'
import { runDrgUsageJourney } from './inpatient-drg-usage.journey.ts'

test('实际术前模型用量从住院入口可查，关闭页面和重启后仍与账本一致', async ({ page, pciAgentApp }) => {
  test.setTimeout(60_000)
  await runDrgUsageJourney(page, pciAgentApp, async (_admissionId, name) => {
    await page.goto(`${pciAgentApp.origin}/inpatient`)
    await page.getByRole('button', { name: new RegExp(name) }).click()
    await page.getByRole('tab', { name: 'DRG 与费用推演', exact: true }).click()
  })
})
