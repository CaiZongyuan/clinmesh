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

test('doctor banner merges vitals with completion progress and moves per-item detail into the suggestion stack', async ({ page, browserApp }) => {
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

  // 横幅压缩合同：生命体征与完诊进度同处一行，进度为计数摘要。
  await expect(banner.getByLabel('已满足 2 / 7', { exact: true })).toBeVisible()
  await expect(banner.getByText('完诊检查未完 5 项', { exact: true })).toBeVisible()
  await expect(banner.getByText('体温（°C）', { exact: false })).toBeVisible()
  const mergedRow = await banner.evaluate(bannerElement => {
    const dl = bannerElement.querySelector('dl')
    const progress = bannerElement.querySelector('[aria-label="已满足 2 / 7"]')
    if (dl === null || progress === null) return false
    const row = dl.parentElement
    return row !== null && row !== bannerElement && row.contains(progress)
  })
  expect(mergedRow).toBe(true)

  // 建议栈合同：宽容器第三栏承载逐项完诊明细、质控与推荐状态。
  const incompleteLabels = ['主诊断确认', '门诊病历签署', '用药结论记录', '处置方案', '随访安排']
  await expect(stack.getByRole('region', { name: '完诊清单' })).toBeVisible()
  await expect(completionSection.getByText('主诊断确认', { exact: true })).toBeVisible()
  for (const label of incompleteLabels) {
    await expect(completionSection.getByText(label, { exact: true })).toBeVisible()
  }
  await expect(completionSection.getByText('必需报告查阅', { exact: true })).toHaveCount(0)
  await expect(stack.getByRole('region', { name: '病历质控' })).toBeVisible()
  await expect(stack.getByText('暂无质控疑点', { exact: true })).toBeVisible()
  await expect(stack.getByRole('region', { name: '医生推荐' })).toBeVisible()
  await expect(stack.getByText('待确认诊断', { exact: true })).toBeVisible()

  for (const width of [1440, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
      .toBeLessThanOrEqual(1)
    if (width >= 1024) {
      await expect(stack).toBeVisible()
      await expect(page.getByRole('button', { name: '诊疗建议' })).toHaveCount(0)
      // 设计合同：横幅压缩为两行，最多占病例内容区一半高度（过敏徽章换行时仍受此约束）。
      const detailBox = await page.locator('[data-doctor-region="detail"]').boundingBox()
      const bannerBox = await banner.boundingBox()
      expect(detailBox).not.toBeNull()
      expect(bannerBox).not.toBeNull()
      expect(bannerBox!.height).toBeLessThanOrEqual(detailBox!.height / 2 + 1)
      // 设计合同：三栏布局下建议栈列宽约 280px，队列侧栏列宽不超过 200px。
      const stackBox = await stack.boundingBox()
      expect(stackBox).not.toBeNull()
      expect(stackBox!.width).toBeLessThanOrEqual(281)
      expect(stackBox!.width).toBeGreaterThanOrEqual(279)
    } else {
      await expect(stack).not.toBeVisible()
      const drawerButton = page.getByRole('button', { name: '诊疗建议' })
      await expect(drawerButton).toBeVisible()
      await drawerButton.click()
      const drawer = page.getByRole('dialog', { name: '诊疗建议' })
      await expect(drawer.getByText('主诊断确认', { exact: true })).toBeVisible()
      await drawer.getByRole('button', { name: 'Close' }).click()
      await expect(drawer).toHaveCount(0)
    }
    await page.getByRole('tab', { name: '诊断', exact: true }).click()
    await expect(banner.getByLabel('已满足 2 / 7', { exact: true })).toBeVisible()
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
  }
  await page.getByRole('button', { name: '选择病例 布局测试乙', exact: true }).click()
  await expect(banner.getByRole('heading', { name: '布局测试乙' })).toBeVisible()
  await expect(banner.getByLabel('已满足 3 / 7', { exact: true })).toBeVisible()
  await expect(stack.getByText('主诊断确认', { exact: true })).toHaveCount(0)

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
  expect(Math.abs(await banner.evaluate(element => element.getBoundingClientRect().top) - bannerTop)).toBeLessThanOrEqual(1)
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
