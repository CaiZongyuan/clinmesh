import { expect, test } from './inpatient-drg.fixture.ts'
import { prepareSurgeryMaterialsPatient, runSurgeryMaterialsJourney } from './inpatient-surgery-materials.journey.ts'

test('术中分次耗材、额外使用、更正和完成从真实住院入口提交', async ({ page, browserApp }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const s = await prepareSurgeryMaterialsPatient(page, browserApp)
  await runSurgeryMaterialsJourney(page, s, () => page.goto(`${browserApp.origin}/inpatient`).then(() => undefined))
  expect(errors).toEqual([])
})
