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
