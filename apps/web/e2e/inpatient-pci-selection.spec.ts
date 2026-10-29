import { test } from './inpatient-drg.fixture.ts'
import { runPciSelectionJourney } from './inpatient-pci-selection.journey.ts'

test('真实住院入口手工确认 PCI 参数、查看候选依据并在修改后重新核对', async ({ page, browserApp }) => {
  await runPciSelectionJourney(page, browserApp, () => page.goto(`${browserApp.origin}/inpatient`).then(() => undefined))
})
