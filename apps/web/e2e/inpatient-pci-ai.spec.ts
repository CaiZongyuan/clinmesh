import { test } from './inpatient-pci-ai.fixture.ts'
import { runPciAiJourney } from './inpatient-pci-ai.journey.ts'

test('正式造影报告带入PCI草稿，同屏审阅指南与费用后一次确认，术中规则费用和术后差异无需跟进', async ({ page, pciAiApp }) => {
  await runPciAiJourney(page, pciAiApp)
})
