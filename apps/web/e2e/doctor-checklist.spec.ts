import {
  doctorCaseDetailSchema,
  doctorQueueSchema,
  encounterCompletionPreviewSchema,
} from '@clinmesh/contracts/his'
import { expect, test } from './fixtures.ts'

const recommendationKinds = ['diagnosis', 'laboratory', 'imaging', 'pathology', 'prescription'] as const

function idleRecommendation(caseId: string, encounterId: string, kind: string) {
  return {
    caseId, encounterId, encounterVersion: '1', kind,
    generation: 0, inputFingerprint: 'a'.repeat(64), status: 'idle', stale: false,
    items: [], guidelines: [], caseEvidence: [], missingInformation: [],
  }
}

test('医生卡片工作台在三档容器宽度保留患者、七项清单与分区入口', async ({ page, browserApp }) => {
  // Authenticate against the real server; use controlled clinical responses for layout only.
  const cases = ['布局测试甲', '布局测试乙'].map((name, index) => doctorCaseDetailSchema.parse({
    registrationNumber: null,
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
  await page.route('**/api/his/v1/doctor/cases/layout-case-*/document-quality-control', route => {
    const caseId = route.request().url().match(/cases\/(layout-case-\d)\//)?.[1] ?? 'layout-case-0'
    return route.fulfill({ json: {
      caseId, encounterId: cases.find(candidate => candidate.caseId === caseId)!.encounter.id,
      draftVersion: 0, documentFingerprint: 'a'.repeat(64), inputFingerprint: 'b'.repeat(64),
      generation: 1, stale: false, status: 'ready', issues: [], notices: [],
    } })
  })
  await page.route('**/api/his/v1/doctor/cases/layout-case-*/document-quality-control/actions/check', route => {
    const body = route.request().postDataJSON() as { input: { expectedDraftVersion: number; clientId?: string; clientRevision?: number } }
    const caseId = route.request().url().match(/cases\/(layout-case-\d)\//)?.[1] ?? 'layout-case-0'
    return route.fulfill({ json: { data: {
      caseId, encounterId: cases.find(candidate => candidate.caseId === caseId)!.encounter.id,
      draftVersion: body.input.expectedDraftVersion, documentFingerprint: 'a'.repeat(64), inputFingerprint: 'b'.repeat(64),
      ...(body.input.clientId === undefined ? {} : { clientId: body.input.clientId, clientRevision: body.input.clientRevision }),
      generation: 1, stale: false, status: 'ready', issues: [], notices: [],
    }, auditId: 'audit-quality', effects: [], requestId: 'request-quality', warnings: [] } })
  })
  await page.route('**/api/his/v1/doctor/cases/layout-case-*/recommendations/**', route => {
    const url = route.request().url()
    const caseId = url.match(/cases\/(layout-case-\d)\//)?.[1] ?? 'layout-case-0'
    const encounterId = cases.find(candidate => candidate.caseId === caseId)!.encounter.id
    const kind = recommendationKinds.find(candidate => url.includes(`/recommendations/${candidate}`)) ?? 'diagnosis'
    if (route.request().method() === 'POST') {
      return route.fulfill({ json: { data: idleRecommendation(caseId, encounterId, kind),
        auditId: `audit-${kind}`, effects: [], requestId: `request-${kind}`, warnings: [] } })
    }
    return route.fulfill({ json: idleRecommendation(caseId, encounterId, kind) })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${browserApp.origin}/consultation`)
  await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  const banner = page.getByRole('region', { name: '当前患者' })
  const stack = page.getByRole('complementary', { name: '诊疗建议' })
  const completionSection = stack.getByRole('region', { name: '完诊清单' })

  await expect(banner.getByLabel('已满足 2 / 7', { exact: true })).toBeVisible()
  await expect(banner.getByRole('button', { name: '完诊 2/7', exact: true })).toBeVisible()
  await expect(banner.getByText('体温（°C）', { exact: true })).toHaveCount(0)
  await expect(stack.getByText('体温（°C）', { exact: true })).toBeVisible()
  for (const label of ['主诊断确认', '门诊病历签署', '必需报告查阅', '用药结论记录', '待提交草稿处理', '处置方案', '随访安排']) {
    await expect(completionSection.getByText(label, { exact: true })).toBeVisible()
  }
  await expect(stack.getByRole('region', { name: '病历质控' })).toBeVisible()
  await expect(stack.getByText('暂无质控疑点', { exact: true })).toBeVisible()
  await expect(stack.getByRole('region', { name: '医生推荐' })).toBeVisible()
  const workspace = page.locator('[data-workspace-id="outpatient-doctor"]')
  const queue = page.getByRole('complementary', { name: '候诊队列', exact: true })
  const main = page.locator('[data-doctor-region="detail"]')
  for (const width of [944, 720, 400]) {
    await workspace.evaluate((element, width) => { element.style.width = `${width}px` }, width)
    await expect.poll(() => workspace.evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(width)
    await expect(stack).toBeVisible()
    await expect(page.getByRole('dialog', { name: '诊疗建议' })).toHaveCount(0)
    await expect.poll(() => workspace.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    const queueBox = await queue.boundingBox(), mainBox = await main.boundingBox(), stackBox = await stack.boundingBox()
    expect(queueBox).not.toBeNull(); expect(mainBox).not.toBeNull(); expect(stackBox).not.toBeNull()
    if (width >= 900) {
      expect(queueBox!.x + queueBox!.width).toBeLessThanOrEqual(mainBox!.x)
      expect(mainBox!.x + mainBox!.width).toBeLessThanOrEqual(stackBox!.x)
    } else if (width >= 600) {
      expect(queueBox!.x + queueBox!.width).toBeLessThanOrEqual(mainBox!.x)
      expect(stackBox!.y).toBeGreaterThanOrEqual(mainBox!.y)
    } else expect(queueBox!.y).toBeLessThan(mainBox!.y)
    const diagnosis = page.getByRole('tab', { name: '诊断', exact: true })
    if (!await diagnosis.isVisible()) await page.getByRole('button', { name: '更多', exact: true }).click()
    await diagnosis.click()
    await expect(diagnosis).toHaveAttribute('aria-selected', 'true')
    const record = page.getByRole('tab', { name: '病历记录', exact: true })
    if (!await record.isVisible()) await page.getByRole('button', { name: '更多', exact: true }).click()
    await record.click()
    await expect(record).toHaveAttribute('aria-selected', 'true')
    await expect(banner.getByLabel('已满足 2 / 7', { exact: true })).toBeVisible()
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await expect.poll(() => page.locator('.clinmesh-web-root').evaluate(element => element.classList.contains('dark'))).toBe(colorScheme === 'dark')
      await workspace.screenshot({ path: `.data/doctor-cards/${width}-${colorScheme}.png`, animations: 'disabled' })
    }
    await page.emulateMedia({ colorScheme: 'light' })
  }
  await page.getByRole('button', { name: '收起队列', exact: true }).click()
  await expect(queue).toHaveCount(0)
  await expect(banner.getByRole('heading', { name: '布局测试甲', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '展开队列', exact: true }).click()
  await page.getByRole('button', { name: '选择病例 布局测试乙', exact: true }).click()
  await expect(banner.getByRole('heading', { name: '布局测试乙' })).toBeVisible()
  await expect(banner.getByLabel('已满足 3 / 7', { exact: true })).toBeVisible()
  await expect(completionSection.getByText('主诊断已确认', { exact: true })).toBeVisible()
  await page.goto(`${browserApp.origin}/settings`)
  await page.getByRole('button', { name: '大', exact: true }).click()
  await expect(page.locator('.clinmesh-web-root')).toHaveAttribute('data-font-size', 'large')
  await page.goto(`${browserApp.origin}/consultation`)
  await page.setViewportSize({ width: 400, height: 700 })
  await expect(banner.getByRole('heading', { name: '布局测试甲' })).toBeVisible()
  await page.getByRole('tab', { name: '病历记录', exact: true }).click()
  const panel = page.getByRole('tabpanel', { name: '病历记录', exact: true })
  const bannerTop = await banner.evaluate(element => element.getBoundingClientRect().top)
  await panel.getByRole('button', { name: '签署病历', exact: true }).scrollIntoViewIfNeeded()
  await expect(panel.getByRole('button', { name: '签署病历', exact: true })).toBeInViewport()
  expect(Math.abs(await banner.evaluate(element => element.getBoundingClientRect().top) - bannerTop)).toBeLessThanOrEqual(1)
})

test('doctor workspace applies every font tier without horizontal scroll', async ({ page, browserApp }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${browserApp.origin}/consultation`)
  await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('complementary', { name: '候诊队列' })).toBeVisible()
  const root = page.locator('.clinmesh-web-root')
  for (const tier of [
    { label: '标准', attribute: 'standard', font: '14px' },
    { label: '较大', attribute: 'larger', font: '15.75px' },
    { label: '大', attribute: 'large', font: '17.5px' },
  ]) {
    await page.goto(`${browserApp.origin}/settings`)
    await page.getByRole('button', { name: tier.label, exact: true }).click()
    await page.goto(`${browserApp.origin}/consultation`)
    await expect(root).toHaveAttribute('data-font-size', tier.attribute)
    expect(await root.evaluate(element => getComputedStyle(element).fontSize)).toBe(tier.font)
    // 三档字号在宽、中、窄卡片布局下都不产生横向滚动。
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
        .toBeLessThanOrEqual(1)
    }
  }
})

test('queue tabs retain complete English labels within the queue card', async ({ page, browserApp }) => {
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
  // 队列 tab 行必须完整落在卡片内：任一触发器越界（左截断或压住计数徽章）都算失败。
  // 换行适应后 tab 列表纵向自适应高度，触发器不得画出 tab 列表盒子压入下方队列内容。
  const geo = await aside.getByRole('tablist').evaluate(listElement => {
    const asideElement = listElement.closest('aside')
    const asideBounds = asideElement?.getBoundingClientRect()
    const listBounds = listElement.getBoundingClientRect()
    const triggers = Array.from(listElement.querySelectorAll('[role="tab"]'))
      .map(tab => tab.getBoundingClientRect())
    return {
      asideLeft: asideBounds?.left ?? Number.NEGATIVE_INFINITY,
      asideRight: asideBounds?.right ?? Number.POSITIVE_INFINITY,
      asideScrolls: asideElement === null || asideElement.scrollWidth > asideElement.clientWidth + 1,
      minTriggerLeft: triggers.length === 0 ? Number.NEGATIVE_INFINITY : Math.min(...triggers.map(b => b.left)),
      maxTriggerRight: triggers.length === 0 ? Number.POSITIVE_INFINITY : Math.max(...triggers.map(b => b.right)),
      maxTriggerBottom: triggers.length === 0 ? Number.POSITIVE_INFINITY : Math.max(...triggers.map(b => b.bottom)),
      listBottom: listBounds.bottom,
    }
  })
  expect(geo.asideScrolls).toBe(false)
  expect(geo.minTriggerLeft).toBeGreaterThanOrEqual(geo.asideLeft - 0.5)
  expect(geo.maxTriggerRight).toBeLessThanOrEqual(geo.asideRight + 0.5)
  expect(geo.maxTriggerBottom).toBeLessThanOrEqual(geo.listBottom + 0.5)
  await expect(aside.getByLabel(/^\d+ cases?$/)).toBeVisible()
})
