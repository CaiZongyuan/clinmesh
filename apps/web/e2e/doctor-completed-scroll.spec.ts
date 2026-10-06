import { doctorCompletedCaseDetailSchema, doctorCompletedCaseListSchema } from '@clinmesh/contracts/his'
import { expect, test } from './fixtures.ts'

test('completed doctor case scrolls to its final timeline entry without moving the queue', async ({ page, browserApp }) => {
  const detail = doctorCompletedCaseDetailSchema.parse({
    caseId: 'scroll-case', completedAt: '2026-10-06T09:00:00+08:00',
    clinicalDocuments: [], laboratoryRequests: [],
    encounter: { id: 'scroll-encounter', status: 'completed', versionId: '1' },
    patient: { id: 'scroll-patient', identifier: 'SYNTHETIC-SCROLL', name: '滚动测试患者', synthetic: true, versionId: '1' },
    timeline: Array.from({ length: 30 }, (_, index) => ({
      kind: 'encounter-completed', occurredAt: '2026-10-06T09:00:00+08:00',
      reference: `Encounter/scroll-event-${index}`, relatedReferences: [],
    })),
  })
  await page.route('**/api/his/v1/doctor/completed-cases?*', route => route.fulfill({ json: doctorCompletedCaseListSchema.parse({
    items: [{ caseId: detail.caseId, completedAt: detail.completedAt, encounterId: detail.encounter.id,
      encounterVersion: '1', patient: detail.patient }],
    page: 1, pageSize: 20, total: 1,
  }) }))
  await page.route('**/api/his/v1/doctor/completed-cases/scroll-case', route => route.fulfill({ json: detail }))
  await page.goto(`${browserApp.origin}/consultation`)
  await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('tab', { name: '完诊', exact: true }).click()
  await page.getByRole('button', { name: '查看病例 滚动测试患者', exact: true }).click()
  const region = page.getByRole('region', { name: '已完诊病例详情', exact: true })
  const end = region.getByText('Encounter/scroll-event-29', { exact: true })
  for (const width of [1440, 390, 1440]) {
    await page.setViewportSize({ width, height: 700 })
    await region.evaluate(element => { element.scrollTop = 0 })
    await expect(end).not.toBeInViewport()
    const bounds = await region.boundingBox()
    expect(bounds).not.toBeNull()
    const queueTab = page.getByRole('tab', { name: '完诊', exact: true, includeHidden: true })
    const queueTop = await queueTab.evaluate(element => element.getBoundingClientRect().top)
    await page.mouse.move(bounds!.x + bounds!.width / 2, Math.min(bounds!.y + 100, 600))
    await page.mouse.wheel(0, 10000)
    await expect(end).toBeInViewport()
    expect(await queueTab.evaluate(element => element.getBoundingClientRect().top)).toBe(queueTop)
    expect(await region.evaluate(element => element.getBoundingClientRect().bottom <= innerHeight)).toBe(true)
  }
})
