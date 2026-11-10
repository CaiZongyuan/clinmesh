import { test, runOutpatientDiagnosisBatchJourney } from './outpatient-diagnosis-batch.fixture.ts'
import { expect } from '@playwright/test'
import { doctorCaseDetailSchema, saveDiagnosisDraftRequestSchema } from '@clinmesh/contracts/his'
import { closeQueue, expectConsultationStarted, openQueue } from './queue-overlay.fixture.ts'
import { openWorkspaceTab } from './workspace-tabs.fixture.ts'

for (const width of [1600, 390]) test(`两诊断连续加入、主次调整、整组冲突与刷新后原确认恢复 ${width}px`, async ({ page, browserApp, consultationCase }) => {
  await page.setViewportSize({ width, height: 1000 })
  await runOutpatientDiagnosisBatchJourney({ page, browserApp, consultationCase })
})

test('主诊断被真实服务明确拒绝后解冻，保留备注供修正并用新键确认', async ({ page, browserApp, consultationCase }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await runOutpatientDiagnosisBatchJourney({ page, browserApp, consultationCase, rejection: 'primary' })
})

test('已自动保存的诊断清空失败保留输入，重试成功并退出重登后不再出现', async ({ page, browserApp, consultationCase }) => {
  await page.route(/\/recommendations\/(diagnosis|prescription|laboratory|imaging|pathology)$/, route => route.abort('failed'))
  const login = async () => {
    await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
    await page.getByLabel('账户密码').fill(browserApp.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
  }
  await page.goto(`${browserApp.origin}/consultation`)
  await login()
  await openQueue(page)
  await page.getByRole('tab', { name: '待诊', exact: true }).click()
  await page.getByRole('button', { name: /^选择病例 / }).click()
  await page.getByRole('button', { name: '开始首诊', exact: true }).click()
  await expectConsultationStarted(page)
  await closeQueue(page)
  await openWorkspaceTab(page, '诊断')
  const readCase = async () => doctorCaseDetailSchema.parse(await (await page.request.get(
    `${browserApp.origin}/api/his/v1/doctor/cases/${consultationCase.outpatientCaseId}`,
  )).json())
  await page.getByRole('button', { name: '添加诊断', exact: true }).click()
  const composer = page.getByRole('dialog', { name: '选择诊断', exact: true })
  await composer.getByRole('button', { name: '选择 发热，未特指 R50.9', exact: true }).click()
  await composer.getByLabel('诊断备注', { exact: true }).fill('合成诊断：显式丢弃后不应恢复。')
  await composer.getByRole('button', { name: '加入诊断', exact: true }).click()
  await composer.getByRole('button', { name: '完成选择', exact: true }).click()
  await expect.poll(async () => (await readCase()).diagnosis?.draft?.entries.length).toBe(1)
  await expect(page.getByRole('button', { name: '清空手动草稿', exact: true })).toBeEnabled()
  const detail = await readCase()
  const endpoint = `**/encounters/${detail.encounter.id}/diagnosis/draft`
  await page.route(endpoint, async route => {
    const request = saveDiagnosisDraftRequestSchema.parse(route.request().postDataJSON())
    expect(request.input.entries).toEqual([])
    const response = await route.fetch({ postData: JSON.stringify({ ...request, input: { ...request.input, expectedDraftVersion: 0 } }) })
    expect(response.status()).toBe(409)
    await route.fulfill({ response })
  })
  await page.getByRole('button', { name: '清空手动草稿', exact: true }).click()
  await page.getByRole('button', { name: '确认丢弃', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toContainText('清空失败')
  expect((await readCase()).diagnosis?.draft?.entries).toHaveLength(1)
  await page.getByRole('button', { name: '保留草稿', exact: true }).click()
  const pending = page.getByRole('region', { name: '待确认诊断', exact: true })
  await expect(pending.getByRole('checkbox')).toHaveCount(1)
  await page.unroute(endpoint)
  await page.getByRole('button', { name: '清空手动草稿', exact: true }).click()
  await page.getByRole('button', { name: '确认丢弃', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect(pending.getByRole('checkbox')).toHaveCount(0)
  expect((await readCase()).diagnosis?.draft).toBeUndefined()
  await page.getByRole('button', { name: '用户菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).click()
  await login()
  await openQueue(page)
  await page.getByRole('tab', { name: '在诊', exact: true }).click()
  await page.getByRole('button', { name: /^选择病例 / }).click()
  await closeQueue(page)
  await openWorkspaceTab(page, '诊断')
  await expect(pending.getByRole('checkbox')).toHaveCount(0)
  expect((await readCase()).diagnosis?.draft).toBeUndefined()
})
