import {
  doctorCaseDetailSchema,
  doctorQueueSchema,
  encounterCompletionPreviewSchema,
} from '@clinmesh/contracts/his'
import { expect, test } from './fixtures.ts'

test('doctor checklist stays between patient details and vital signs and replaces the case sidebar', async ({ page, browserApp }) => {
  // Authenticate against the real server; use controlled clinical responses for layout only.
  const cases = ['布局测试甲', '布局测试乙'].map((name, index) => doctorCaseDetailSchema.parse({
    allergies: [],
    caseId: `layout-case-${index}`,
    consultation: { turns: [], version: 1 },
    encounter: { id: `layout-encounter-${index}`, status: 'in-progress', versionId: '1' },
    laboratoryRequests: { draftVersion: 0, reportingSupported: true, requests: [] },
    patient: { id: `layout-patient-${index}`, identifier: `SYNTHETIC-LAYOUT-${index}`, name, gender: 'male', synthetic: true, versionId: '1' },
    presentation: {
      chiefComplaint: '发热伴咽痛两天', summary: '发热伴咽痛两天',
      vitalSigns: { temperatureC: 38.2, pulseBpm: 102, respirationBpm: 20, bloodPressure: { systolicMmHg: 118, diastolicMmHg: 76 }, oxygenSaturationPct: 98 },
    },
    priorFacts: [], status: 'first-visit', taskId: `layout-task-${index}`, taskVersion: '1',
  }))
  const items = encounterCompletionPreviewSchema.parse({
    canComplete: false, encounterId: 'layout-encounter-0', encounterVersion: '1',
    items: [
      { code: 'primary-diagnosis-confirmed', status: 'incomplete', statusText: '待确认主诊断', target: 'diagnosis' },
      { code: 'clinical-document-signed', status: 'incomplete', statusText: '待签署门诊病历', target: 'clinical-document' },
      { code: 'required-reports-acknowledged', status: 'complete', statusText: '必需报告已阅', target: 'laboratory' },
      { code: 'medication-conclusion-recorded', status: 'incomplete', statusText: '待记录用药结论', target: 'medication-conclusion' },
      { code: 'no-pending-drafts', status: 'complete', statusText: '无待提交草稿', target: 'clinical-document' },
      { code: 'disposition-complete', status: 'incomplete', statusText: '待填写处置方案', target: 'clinical-document' },
      { code: 'follow-up-complete', status: 'incomplete', statusText: '待填写随访安排与注意事项', target: 'clinical-document' },
    ],
  }).items
  await page.route('**/api/his/v1/doctor/queue?*', route => route.fulfill({ json: doctorQueueSchema.parse({
    items: cases.map(detail => ({ ...detail, encounterId: detail.encounter.id, encounterVersion: '1' })),
    page: 1, pageSize: 20, total: 2, hasNextPage: false,
  }) }))
  await page.route('**/api/his/v1/doctor/cases/layout-case-*', route => {
    const detail = cases.find(candidate => route.request().url().endsWith(candidate.caseId))
    if (detail === undefined) throw new Error('Unknown layout case')
    return route.fulfill({ json: detail })
  })
  await page.route('**/api/his/v1/encounters/layout-encounter-*/completion', route => {
    const second = route.request().url().includes('layout-encounter-1')
    return route.fulfill({ json: {
      canComplete: false, encounterId: `layout-encounter-${second ? 1 : 0}`, encounterVersion: '1',
      items: items.map(item => second && item.code === 'primary-diagnosis-confirmed'
        ? { ...item, status: 'complete', statusText: '主诊断已确认' } : item),
    } })
  })
  await page.goto(`${browserApp.origin}/consultation`)
  await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  const checklist = page.getByRole('region', { name: '完诊清单' })
  const banner = page.getByRole('region', { name: '当前患者' })
  await expect(checklist.getByLabel('已满足 2 / 7', { exact: true })).toBeVisible()
  const labels = ['主诊断确认', '门诊病历签署', '必需报告查阅', '用药结论记录', '待提交草稿处理', '处置方案', '随访安排']
  const primaryDiagnosis = checklist.getByText('主诊断确认', { exact: true })
  await expect(primaryDiagnosis).toHaveAttribute('data-variant', 'secondary')
  await expect(checklist.getByText('必需报告查阅', { exact: true })).toHaveAttribute('data-variant', 'success')
  const pendingBackground = await primaryDiagnosis.evaluate(element => getComputedStyle(element).backgroundColor)
  const completedBackground = await checklist.getByText('必需报告查阅', { exact: true }).evaluate(element => getComputedStyle(element).backgroundColor)
  expect(pendingBackground).not.toBe(completedBackground)
  for (const width of [1440, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(checklist.getByRole('listitem')).toHaveCount(7)
    await expect(checklist.getByRole('listitem')).toHaveText(labels)
    const widths = await checklist.locator('[data-slot="badge"]').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width))
    expect(new Set(widths).size).toBe(1)
    await expect(checklist.getByText(/^(已完成|待完成)$/)).toHaveCount(0)
    expect(await checklist.locator('ul').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await expect(page.getByRole('complementary', { name: '病例上下文' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /显示患者信息|隐藏患者信息|病例上下文/ })).toHaveCount(0)
    const patientBounds = await banner.getByRole('heading', { level: 2 }).boundingBox()
    const checklistBounds = await checklist.boundingBox()
    expect(patientBounds).not.toBeNull()
    expect(checklistBounds).not.toBeNull()
    expect(checklistBounds!.y).toBeGreaterThanOrEqual(patientBounds!.y + patientBounds!.height)
    await expect.poll(() => checklist.evaluate(element => {
      const vitalSigns = element.nextElementSibling
      return vitalSigns?.tagName === 'DL'
        && element.getBoundingClientRect().bottom <= vitalSigns.getBoundingClientRect().top
    })).toBe(true)
    expect(checklistBounds!.x + checklistBounds!.width).toBeLessThanOrEqual(width)
    for (const item of await checklist.getByRole('listitem').all()) {
      const bounds = await item.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.x).toBeGreaterThanOrEqual(checklistBounds!.x)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(checklistBounds!.x + checklistBounds!.width)
    }
    await page.getByRole('tab', { name: '诊断', exact: true }).click()
    await expect(checklist.getByLabel('已满足 2 / 7', { exact: true })).toBeVisible()
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
  }
  await page.getByRole('button', { name: '选择病例 布局测试乙', exact: true }).click()
  await expect(banner.getByRole('heading', { name: '布局测试乙' })).toBeVisible()
  await expect(checklist.getByLabel('已满足 3 / 7', { exact: true })).toBeVisible()
  await expect(primaryDiagnosis).toHaveAttribute('data-variant', 'success')
  expect(await primaryDiagnosis.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(completedBackground)
})
