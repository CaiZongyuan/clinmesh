import { test } from './inpatient-pci.fixture.ts'
import { runEquivalentMaterialJourney } from './inpatient-equivalent-materials.journey.ts'

test('接近支付参考时在真实手术清单与术中选择严格等效耗材，保存换回与费用一致', async ({ page, pciAgentApp }, info) => {
  await runEquivalentMaterialJourney(page, pciAgentApp, info, () => page.goto(pciAgentApp.origin + '/inpatient').then(() => {}))
})
