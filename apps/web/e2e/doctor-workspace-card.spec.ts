import { doctorCaseDetailSchema, doctorQueueSchema, encounterCompletionPreviewSchema } from '@clinmesh/contracts/his'
import { expect, test } from './fixtures.ts'

test('医生原位查看七项完诊清单、定位缺项并明确确认后才提交', async ({ page, browserApp }) => {
  const detail = doctorCaseDetailSchema.parse({
    registrationNumber: 'CM-OP-20261030-001', allergies: [], caseId: 'card-case',
    consultation: { turns: [], version: 1 },
    encounter: { id: 'card-encounter', status: 'in-progress', versionId: '1' },
    laboratoryRequests: { draftVersion: 0, reportingSupported: true, requests: [] },
    patient: { id: 'card-patient', identifier: 'SYNTHETIC-CARD', name: '卡片测试患者', gender: 'male', synthetic: true, versionId: '1' },
    presentation: { chiefComplaint: '咽痛两天', summary: '咽痛两天', vitalSigns: {
      temperatureC: 37, pulseBpm: 80, respirationBpm: 18,
      bloodPressure: { systolicMmHg: 120, diastolicMmHg: 80 }, oxygenSaturationPct: 98,
    } },
    priorFacts: [], status: 'first-visit', taskId: 'card-task', taskVersion: '1',
  })
  let ready = false
  let blocked = false
  let completed = false
  let submissions = 0
  let caseReads = 0
  const preview = () => encounterCompletionPreviewSchema.parse({
    canComplete: ready && !blocked, encounterId: detail.encounter.id, encounterVersion: '1', items: [
      { code: 'primary-diagnosis-confirmed', target: 'diagnosis', status: ready ? 'complete' : 'incomplete', statusText: ready ? '主诊断已确认' : '待确认主诊断' },
      { code: 'clinical-document-signed', target: 'clinical-document', status: ready ? 'complete' : 'incomplete', statusText: ready ? '门诊病历已签署' : '待签署门诊病历' },
      { code: 'required-reports-acknowledged', target: 'laboratory', status: 'complete', statusText: '必需报告已阅' },
      { code: 'medication-conclusion-recorded', target: 'medication-conclusion', status: 'complete', statusText: '用药结论已记录' },
      { code: 'no-pending-drafts', target: 'clinical-document', status: 'complete', statusText: '无待提交草稿' },
      { code: 'disposition-complete', target: 'clinical-document', status: 'complete', statusText: '已填写处置方案' },
      { code: 'follow-up-complete', target: 'clinical-document', status: 'complete', statusText: '已填写随访安排' },
    ],
  })
  await page.route('**/api/his/v1/doctor/queue?*', route => route.fulfill({ json: doctorQueueSchema.parse({
    items: [{ ...detail, encounterId: detail.encounter.id, encounterVersion: '1' }],
    page: 1, pageSize: 20, total: 1, hasNextPage: false,
  }) }))
  await page.route('**/api/his/v1/doctor/cases/card-case', route => {
    caseReads += 1
    return completed ? route.fulfill({ status: 503,
    json: { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'exception', diagnostics: 'Synthetic case refresh failure' }] },
  }) : route.fulfill({ json: detail })
  })
  await page.route('**/api/his/v1/encounters/card-encounter/completion', route => route.fulfill({ json: preview() }))
  await page.route('**/api/his/v1/encounters/card-encounter/actions/complete', route => {
    submissions += 1
    expect(route.request().postDataJSON()).toEqual({ expectedVersions: { 'Encounter/card-encounter': '1' }, input: {} })
    completed = true
    return route.fulfill({ json: { data: { completedAt: '2026-10-30T08:00:00Z', encounterId: detail.encounter.id, encounterVersion: '2', status: 'completed' },
      auditId: 'audit-card', effects: [], requestId: 'request-card', warnings: [] } })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${browserApp.origin}/consultation`)
  await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  const patient = page.getByRole('region', { name: '当前患者', exact: true })
  await expect(patient.getByRole('button', { name: '完诊 5/7', exact: true })).toBeVisible()
  const flow = page.getByRole('list', { name: '办理流程', exact: true })
  await expect(flow.locator('[aria-current="step"]')).toHaveText('接诊')
  const checklist = page.getByRole('region', { name: '完诊清单', exact: true })
  for (const label of ['主诊断确认', '门诊病历签署', '必需报告查阅', '用药结论记录', '待提交草稿处理', '处置方案', '随访安排']) {
    await expect(checklist.getByText(label, { exact: true })).toBeVisible()
  }
  await patient.getByRole('button', { name: '完诊 5/7', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  const actions = page.getByRole('region', { name: '完诊操作', exact: true })
  await expect(actions).toContainText('主诊断确认')
  await expect(actions).toContainText('门诊病历签署')
  await actions.getByRole('button', { name: '前往诊断', exact: true }).click()
  await expect(page.getByRole('tab', { name: '诊断', exact: true })).toHaveAttribute('aria-selected', 'true')
  expect(submissions).toBe(0)

  ready = true
  blocked = true
  await page.reload()
  await patient.getByRole('button', { name: '完诊 7/7', exact: true }).click()
  await expect(actions).toContainText('暂不能完诊')
  await expect(actions.getByRole('button', { name: '确认完诊', exact: true })).toHaveCount(0)
  await actions.getByRole('button', { name: '返回核对', exact: true }).click()
  await expect(patient.getByRole('button', { name: '完诊 7/7', exact: true })).toBeFocused()
  expect(submissions).toBe(0)
  blocked = false
  await page.reload()
  await patient.getByRole('button', { name: '完诊 7/7', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  const confirm = actions.getByRole('button', { name: '确认完诊', exact: true })
  await expect(confirm).toBeFocused()
  await expect(actions).toContainText('本次门诊结束')
  await actions.getByRole('button', { name: '返回', exact: true }).click()
  expect(submissions).toBe(0)
  await patient.getByRole('button', { name: '完诊 7/7', exact: true }).click()
  await confirm.click()
  await expect.poll(() => submissions).toBe(1)
  await expect(patient.getByText('已完诊 · 病例只读', { exact: true })).toBeVisible()
  await expect(flow.getByText('接诊 · 已完成', { exact: true })).toBeVisible()
  await expect(flow.locator('[aria-current="step"]')).toHaveCount(0)
  await expect(flow.getByText('缴费', { exact: true })).toBeVisible()
  await expect(flow.getByText('发药', { exact: true })).toBeVisible()
  await expect(actions).toContainText('已完诊')
  await expect(actions).toContainText('完诊列表')
  await expect(page.getByRole('complementary', { name: '诊疗建议' }).getByText('体温（°C）', { exact: true })).toBeVisible()
  const refreshError = page.getByRole('alert').filter({ hasText: '病例刷新失败' })
  await expect(refreshError).toBeVisible()
  const readsBeforeRetry = caseReads
  await refreshError.getByRole('button', { name: '重试', exact: true }).click()
  await expect.poll(() => caseReads).toBeGreaterThan(readsBeforeRetry)
  expect(submissions).toBe(1)
})

test('开始首诊的迟到回执不抢回已切换的待诊患者', async ({ page, browserApp }) => {
  const details = ['甲', '乙'].map((name, index) => doctorCaseDetailSchema.parse({
    registrationNumber: null, allergies: [], caseId: `late-start-${index}`,
    encounter: { id: `late-start-encounter-${index}`, status: 'in-progress', versionId: '1' },
    patient: { id: `late-start-patient-${index}`, identifier: `SYNTHETIC-LATE-${index}`, name: `合成待诊患者${name}`, synthetic: true, versionId: '1' },
    presentation: null, priorFacts: [], status: 'awaiting-doctor', taskId: `late-start-task-${index}`, taskVersion: '1',
  }))
  let releaseCommand!: () => void
  const command = new Promise<void>(resolve => { releaseCommand = resolve })
  let submissions = 0
  await page.route('**/api/his/v1/doctor/queue?*', route => {
    const view = new URL(route.request().url()).searchParams.get('view')
    const items = details.filter(detail => view === null || (view === 'waiting') === (detail.status === 'awaiting-doctor'))
      .map(detail => ({ ...detail, encounterId: detail.encounter.id, encounterVersion: detail.encounter.versionId }))
    return route.fulfill({ json: doctorQueueSchema.parse({ items, page: 1, pageSize: 20, total: items.length, hasNextPage: false }) })
  })
  await page.route('**/api/his/v1/doctor/cases/late-start-*', route => route.fulfill({
    json: details.find(detail => new URL(route.request().url()).pathname.endsWith(`/${detail.caseId}`)),
  }))
  await page.route('**/api/his/v1/encounters/late-start-encounter-0/actions/start-first-visit', async route => {
    submissions += 1
    expect(route.request().postDataJSON()).toEqual({
      expectedVersions: { 'Encounter/late-start-encounter-0': '1', 'Task/late-start-task-0': '1' }, input: {},
    })
    await command
    details[0]!.status = 'first-visit'
    details[0]!.encounter.versionId = '2'
    details[0]!.taskVersion = '2'
    await route.fulfill({ json: { data: { encounterVersion: '2', status: 'first-visit', taskVersion: '2' },
      auditId: 'audit-late-start', effects: [], requestId: 'request-late-start', warnings: [] } })
  })
  try {
    await page.goto(`${browserApp.origin}/consultation`)
    await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
    await page.getByLabel('账户密码').fill(browserApp.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByRole('tab', { name: '待诊', exact: true }).click()
    const patient = page.getByRole('region', { name: '当前患者', exact: true })
    await expect(patient.getByRole('heading', { name: '合成待诊患者甲', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '开始首诊', exact: true }).click()
    await expect.poll(() => submissions).toBe(1)
    await page.getByRole('button', { name: '选择病例 合成待诊患者乙', exact: true }).click()
    await expect(patient.getByRole('heading', { name: '合成待诊患者乙', exact: true })).toBeVisible()
    const refreshed = Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/his/v1/doctor/cases/late-start-0'),
      ...[null, 'waiting'].map(view => page.waitForResponse(async response => {
        const url = new URL(response.url())
        if (url.pathname !== '/api/his/v1/doctor/queue' || url.searchParams.get('view') !== view || !response.ok()) return false
        const data = doctorQueueSchema.parse(await response.json())
        return view === null ? data.items.some(item => item.caseId === 'late-start-0' && item.status === 'first-visit')
          : data.items.every(item => item.caseId !== 'late-start-0')
      })),
    ])
    releaseCommand()
    await Promise.all((await refreshed).map(response => response.finished()))
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(page.getByRole('button', { name: '开始首诊', exact: true })).toBeEnabled()
    await expect(patient.getByRole('heading', { name: '合成待诊患者乙', exact: true })).toBeVisible()
    await expect(page.getByRole('tab', { name: '待诊', exact: true })).toHaveAttribute('aria-selected', 'true')
    expect(submissions).toBe(1)
  } finally { releaseCommand() }
})

for (const revisit of [false, true]) {
  for (const source of ['failed', 'other-page'] as const) {
    test(`${revisit ? '复诊' : '首诊'}成功后在${source === 'failed' ? '队列读取失败' : '病例不在全量当前页'}时仍进入在诊`, async ({ page, browserApp }) => {
      const waitingStatus = revisit ? 'awaiting-revisit' : 'awaiting-doctor'
      const nextStatus = revisit ? 'revisit-draft' : 'first-visit'
      const detail = doctorCaseDetailSchema.parse({
        registrationNumber: null, allergies: [], caseId: 'start-recovery',
        encounter: { id: 'start-recovery-encounter', status: 'in-progress', versionId: '1' },
        patient: { id: 'start-recovery-patient', identifier: 'SYNTHETIC-START-RECOVERY', name: '合成接诊恢复患者', synthetic: true, versionId: '1' },
        presentation: null, priorFacts: [], status: waitingStatus, taskId: 'start-recovery-task', taskVersion: '1',
      })
      let started = false
      let fallbackReads = 0
      let submissions = 0
      await page.route('**/api/his/v1/doctor/queue?*', route => {
        const view = new URL(route.request().url()).searchParams.get('view')
        if (started && view === null) {
          fallbackReads += 1
          if (source === 'failed') return route.fulfill({ status: 503,
            json: { error: { code: 'SERVICE_UNAVAILABLE', message: 'Synthetic queue read failure' } } })
        }
        const item = { ...detail, encounterId: detail.encounter.id, encounterVersion: detail.encounter.versionId }
        const items = started && source === 'other-page' && view !== 'active'
          ? Array.from({ length: 20 }, (_, index) => ({ ...item, caseId: `earlier-case-${index}`,
            encounterId: `earlier-encounter-${index}`, encounterVersion: '1', status: waitingStatus,
            taskId: `earlier-task-${index}`, taskVersion: '1',
            patient: { ...detail.patient, id: `earlier-patient-${index}`, name: `合成排队患者${index}`, identifier: `SYNTHETIC-EARLIER-${index}` },
          }))
          : view === null || (view === 'waiting') === (detail.status === waitingStatus) ? [item] : []
        const total = started && source === 'other-page' && view === null ? 21 : items.length
        return route.fulfill({ json: doctorQueueSchema.parse({ items, page: 1, pageSize: 20, total, hasNextPage: total > 20 }) })
      })
      await page.route('**/api/his/v1/doctor/cases/start-recovery', route => route.fulfill({ json: detail }))
      await page.route(`**/api/his/v1/encounters/start-recovery-encounter/actions/${revisit ? 'start-revisit' : 'start-first-visit'}`, route => {
        submissions += 1
        expect(route.request().postDataJSON()).toEqual({
          expectedVersions: { 'Encounter/start-recovery-encounter': '1', 'Task/start-recovery-task': '1' }, input: {},
        })
        started = true
        detail.status = nextStatus
        detail.encounter.versionId = '2'
        detail.taskVersion = '2'
        return route.fulfill({ json: { data: { encounterVersion: '2', status: nextStatus, taskVersion: '2' },
          auditId: 'audit-start-recovery', effects: [], requestId: 'request-start-recovery', warnings: [] } })
      })
      await page.goto(`${browserApp.origin}/consultation`)
      await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
      await page.getByLabel('账户密码').fill(browserApp.password)
      await page.getByRole('button', { name: '登录', exact: true }).click()
      await page.getByRole('tab', { name: '待诊', exact: true }).click()
      await page.getByRole('button', { name: revisit ? '开始复诊' : '开始首诊', exact: true }).click()
      await expect(page.getByRole('tab', { name: '在诊', exact: true })).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByRole('region', { name: '当前患者', exact: true }).getByRole('heading', { name: detail.patient.name, exact: true })).toBeVisible()
      await expect(page.getByRole('list', { name: '办理流程', exact: true }).locator('[aria-current="step"]')).toHaveText('接诊')
      expect(fallbackReads).toBeGreaterThan(0)
      expect(submissions).toBe(1)
    })
  }
}
