import { test } from './inpatient-pci.fixture.ts'
import { runColdDraftCostJourney, runEquivalentMaterialJourney } from './inpatient-equivalent-materials.journey.ts'

test('接近支付参考时在真实手术清单与术中选择严格等效耗材，保存换回与费用一致', async ({ page, pciAgentApp }, info) => {
  await runEquivalentMaterialJourney(page, pciAgentApp, info, () => page.goto(pciAgentApp.origin + '/inpatient').then(() => {}))
})

test('冷客户端未加载耗材清单时，DRG保留已保存草稿的完整费用', async ({ page, pciAgentApp }) => {
  await runColdDraftCostJourney(page, pciAgentApp, () => page.goto(pciAgentApp.origin + '/inpatient').then(() => {}))
})
