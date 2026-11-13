import { test } from './inpatient-pci-ai.fixture.ts'
import { runSurgeryFlowJourney } from './inpatient-surgery-flow.journey.ts'
test('手术全程对照原型状态，术中完成双宽浅深与偏离核对及术后确认贯通', async ({ page, pciAiApp }, info) => {
  test.setTimeout(240_000)
  await runSurgeryFlowJourney(page, pciAiApp, info)
})
