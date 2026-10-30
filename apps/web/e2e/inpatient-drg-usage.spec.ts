import { selectInpatientStage } from './inpatient-ui.ts'
import { test } from './inpatient-pci.fixture.ts'
import { runDrgUsageJourney } from './inpatient-drg-usage.journey.ts'

test('实际术前用量跨关闭和重启保留，双权限成员可从病例明细补算', async ({ page, pciAgentApp }) => {
  test.setTimeout(60_000)
  await runDrgUsageJourney(page, pciAgentApp, async (_admissionId, name) => {
    await page.goto(`${pciAgentApp.origin}/inpatient`)
    await page.getByRole('button', { name: new RegExp(name) }).click()
    await selectInpatientStage(page, "DRG 预分组")
  })
})
