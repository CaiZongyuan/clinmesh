import { test, expect } from './inpatient-drg.fixture.ts'
import { prepareReservationBatchPatient, runReservationBatchJourney } from './inpatient-reservation-batch.journey.ts'

test('同一手术连续新增和释放、成功回执可恢复原坏稿且保留另一计划', async ({ page, browserApp }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const s = await prepareReservationBatchPatient(page, browserApp)
  const result = await runReservationBatchJourney(page, s, async () => { await page.goto(`${browserApp.origin}/inpatient`) }, undefined, { damageReleaseDraft: true })
  expect(result).toMatchObject({ createPosts: 2, releasePosts: 2, createAudits: 2, releaseAudits: 2, chargesFen: 0, procedureCount: 0 })
  expect(errors).toEqual([])
})
