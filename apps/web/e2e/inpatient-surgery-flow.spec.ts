import { test } from './inpatient-pci-ai.fixture.ts'
import { runSurgeryFlowJourney } from './inpatient-surgery-flow.journey.ts'
test('手术全程逐阶段对照原型，双宽浅深与偏离核对、默认完成和术后确认贯通', async ({ page, pciAiApp }, info) => {
  test.setTimeout(240_000)
  await runSurgeryFlowJourney(page, pciAiApp, info)
})
