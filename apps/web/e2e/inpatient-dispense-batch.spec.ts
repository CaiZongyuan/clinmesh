import { test } from './inpatient-pci.fixture.ts'
import { prepareDispenseBatchPatient, runDispenseBatchJourney } from './inpatient-dispense-batch.journey.ts'

test('药师从真实住院工作台集中核对同患者PCI三种待发药，保留逐项原尝试恢复', async ({ page, pciApp }) => {
  const s = await prepareDispenseBatchPatient(page, pciApp)
  await runDispenseBatchJourney(page, s, async () => { await page.goto(`${pciApp.origin}/pharmacy`) })
})
