import { test } from './inpatient-pci.fixture.ts'
import { prepareDispenseBatchPatient, runDispenseBatchJourney, runSameLotDispenseJourney } from './inpatient-dispense-batch.journey.ts'

test('药师从真实住院工作台集中核对同患者PCI三种待发药，保留逐项原尝试恢复', async ({ page, pciApp }) => {
  const s = await prepareDispenseBatchPatient(page, pciApp)
  const other = await prepareDispenseBatchPatient(page, pciApp, { sameLot: true, expandTimes: false, name: '合成隔离发药患者', bedId: 'bed-general-2' })
  await runDispenseBatchJourney(page, s, async () => { await page.goto(`${pciApp.origin}/pharmacy`) }, undefined, other)
})

test('同批长期BID两个时点使用原审阅库存及本批成功增量连续发药', async ({ page, pciApp }) => {
  const s = await prepareDispenseBatchPatient(page, pciApp, { sameLot: true })
  await runSameLotDispenseJourney(page, s, async () => { await page.goto(`${pciApp.origin}/pharmacy`) })
})

test('同批第一项后发生外部同lot扣减，余项保留并要求重审而不静默换版本', async ({ page, pciApp }) => {
  const s = await prepareDispenseBatchPatient(page, pciApp, { sameLot: true })
  const external = await prepareDispenseBatchPatient(page, pciApp, { sameLot: true, name: '合成其他药师患者', bedId: 'bed-general-2' })
  await runSameLotDispenseJourney(page, s, async () => { await page.goto(`${pciApp.origin}/pharmacy`) }, external)
})
