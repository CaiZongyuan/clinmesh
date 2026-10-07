import {
  doctorCaseDetailSchema,
  doctorQueueSchema,
  encounterCompletionPreviewSchema,
} from '@clinmesh/contracts/his'
import { expect, test } from './fixtures.ts'

test('doctor checklist stays between patient details and vital signs and replaces the case sidebar', async ({ page, browserApp }) => {
  // Authenticate against the real server; use controlled clinical responses for layout only.
  const cases = ['布局测试甲', '布局测试乙'].map((name, index) => doctorCaseDetailSchema.parse({
    allergies: index === 0 ? [
      { code: 'synthetic-penicillin', display: '青霉素过敏' },
      { code: 'synthetic-sulfonamide', display: '磺胺类过敏' },
      { code: 'synthetic-macrolide', display: '大环内酯类过敏' },
    ] : [],
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
    // 规格验收：桌面宽度下头部（患者 banner 顶到章节标签栏下缘）约 140px。
    if (width >= 1024) {
      const tabsList = page.getByRole('tab', { name: '病历记录', exact: true }).locator('xpath=ancestor::*[@role="tablist"][1]')
      const bannerBox = await banner.boundingBox()
      const tabsBox = await tabsList.boundingBox()
      expect(bannerBox).not.toBeNull()
      expect(tabsBox).not.toBeNull()
      expect(tabsBox!.y + tabsBox!.height - bannerBox!.y).toBeLessThanOrEqual(140)
      // 规格验收：桌面宽度下队列侧栏列宽不超过 200px。
      const queueAside = page.getByRole('complementary', { name: '候诊队列' })
      const queueBox = await queueAside.boundingBox()
      expect(queueBox).not.toBeNull()
      expect(queueBox!.width).toBeLessThanOrEqual(200)
    }
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

  await page.goto(`${browserApp.origin}/settings`)
  await page.getByRole('button', { name: '大', exact: true }).click()
  await expect(page.locator('.clinmesh-web-root')).toHaveAttribute('data-font-size', 'large')
  await page.goto(`${browserApp.origin}/consultation`)
  await page.setViewportSize({ width: 320, height: 520 })
  await expect(banner.getByRole('heading', { name: '布局测试甲' })).toBeVisible()
  await page.getByRole('tab', { name: '病历记录', exact: true }).click()
  const panel = page.getByRole('tabpanel', { name: '病历记录', exact: true })
  await expect.poll(() => panel.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    return bounds.height > 0 && bounds.top >= 0 && bounds.bottom <= window.innerHeight
  })).toBe(true)
  const bannerTop = await banner.evaluate(element => element.getBoundingClientRect().top)
  const panelBounds = await panel.boundingBox()
  expect(panelBounds).not.toBeNull()
  await page.mouse.move(panelBounds!.x + panelBounds!.width / 2, panelBounds!.y + panelBounds!.height / 2)
  await page.mouse.wheel(0, 10_000)
  await expect(panel.getByRole('button', { name: '签署病历', exact: true })).toBeInViewport()
  expect(await banner.evaluate(element => element.getBoundingClientRect().top)).toBe(bannerTop)
  await banner.evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect(banner.getByText('血氧饱和度（%）', { exact: true })).toBeInViewport()
})

test('queue tabs adapt to the 200px sidebar with full-width English labels', async ({ page, browserApp }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${browserApp.origin}/consultation`)
  await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('complementary', { name: '候诊队列' })).toBeVisible()
  await page.goto(`${browserApp.origin}/settings`)
  await page.getByRole('button', { name: 'English', exact: true }).click({ timeout: 20_000 })
  await expect(page.locator('.clinmesh-web-root')).toHaveAttribute('lang', 'en-US')
  await page.goto(`${browserApp.origin}/consultation`)
  const aside = page.getByRole('complementary', { name: 'Waiting queue' })
  await expect(aside.getByRole('tab', { name: 'In care', exact: true })).toBeVisible()
  // 队列 tab 行必须完整落在 200px 侧栏内：任一触发器越界（左截断或压住计数徽章）都算失败。
  const geo = await aside.getByRole('tablist').evaluate(listElement => {
    const asideElement = listElement.closest('aside')
    const asideBounds = asideElement?.getBoundingClientRect()
    const triggers = Array.from(listElement.querySelectorAll('[role="tab"]'))
      .map(tab => tab.getBoundingClientRect())
    return {
      asideLeft: asideBounds?.left ?? Number.NEGATIVE_INFINITY,
      asideRight: asideBounds?.right ?? Number.POSITIVE_INFINITY,
      asideScrolls: asideElement === undefined || asideElement.scrollWidth > asideElement.clientWidth + 1,
      minTriggerLeft: triggers.length === 0 ? Number.NEGATIVE_INFINITY : Math.min(...triggers.map(b => b.left)),
      maxTriggerRight: triggers.length === 0 ? Number.POSITIVE_INFINITY : Math.max(...triggers.map(b => b.right)),
    }
  })
  expect(geo.asideScrolls).toBe(false)
  expect(geo.minTriggerLeft).toBeGreaterThanOrEqual(geo.asideLeft - 0.5)
  expect(geo.maxTriggerRight).toBeLessThanOrEqual(geo.asideRight + 0.5)
  await expect(aside.getByLabel(/^\d+ cases?$/)).toBeVisible()
})
