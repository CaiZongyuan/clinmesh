import { test } from './inpatient-drg.fixture.ts'
import { runDrgProgressJourney } from './inpatient-drg-progress.journey.ts'

test('住院医生所有页签共用常驻 DRG 进度，术中登记同步费用，其他岗位不显示', async ({ page, browserApp }, info) => {
  await runDrgProgressJourney(page, browserApp, info, () => page.goto(browserApp.origin + '/inpatient').then(() => {}))
})
