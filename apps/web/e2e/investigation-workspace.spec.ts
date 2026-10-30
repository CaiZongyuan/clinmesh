import { openWorkspaceTab } from './workspace-tabs.fixture.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { z } from 'zod'
import { confirmDoctorPreparationResponseSchema } from '@clinmesh/contracts/doctor-recommendations'
import { sourceArtifactHash } from '../../server/src/application/scenario-data/provider.ts'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { test as base, expect } from './fixtures.ts'
import { createInvestigationReferenceDatabase } from './investigation-workspace.fixture.ts'
import { collectOutpatientInvestigation } from './outpatient-investigation-payment.fixture.ts'

const test = base.extend<{ investigationCase: Awaited<ReturnType<typeof startConsultationCase>> }>({
  browserApp: async ({ webRoot }, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-investigation-e2e-'))
    try {
      const referenceDatabasePath = await createInvestigationReferenceDatabase(directory)
      const app = await startBrowserServer(webRoot, {
        activeReferenceReleaseId: 'investigation-e2e-v1', referenceDatabasePath,
        patientPersonaModel: 'synthetic-persona', syntheaProvider: new class extends StubSyntheaProvider {
          override async generate() {
            const corpus = await super.generate()
            const sources = corpus.sources.map(source => {
              const raw = z.object({ entry: z.array(z.object({ resource: z.record(z.string(), z.unknown()) }).passthrough()) }).passthrough().parse(source.raw)
              raw.entry.find(entry => entry.resource.id === 'iwtest')!.resource.valueQuantity = {
                code: '10*3/uL', system: 'http://unitsofmeasure.org', unit: '10*3/uL', value: 11.2,
              }
              raw.entry.find(entry => entry.resource.id === 'ihtest')!.resource.valueQuantity = {
                code: 'g/dL', system: 'http://unitsofmeasure.org', unit: 'g/dL', value: 13.5,
              }
              return { ...source, raw, hash: sourceArtifactHash(raw) }
            })
            return { ...corpus, sources }
          }
        }(),
        chatCompletionsProvider: { completeJson: async input => {
          expect(input.schemaName).toBe('patient_persona')
          return { model: input.model, content: JSON.stringify(persona) }
        } },
      })
      try {
        // 本场景验证临床真值不兼容；其独立合成项目先配置有效门诊价，避免被缺价门禁提前拦截。
        const priced = app.runtime.database.driver.prepare(`UPDATE hospital_service_catalog
          SET config_json = json_set(config_json, '$.laboratoryService.outpatientBilling', json(?))
          WHERE json_extract(config_json, '$.laboratoryService.referenceConcept.code') = '0101901A'`).run(JSON.stringify({
          id: 'synthetic-e2e-incompatible-laboratory-price', version: 1, priceFen: 800, currency: 'CNY', unit: '项目',
          source: 'synthetic-e2e-incompatible-laboratory', effectiveOn: '2026-08-24',
        }))
        expect(priced.changes).toBe(1)
        await use(app)
      }
      finally { await app.close() }
    } finally { await rm(directory, { force: true, recursive: true }) }
  },
  investigationCase: async ({ browserApp }, use) => {
    await use(await startConsultationCase(browserApp.runtime, browserApp.password, browserApp.origin))
  },
})

test('a doctor cancels an incompatible laboratory request after reviewing its failure through the real server', async ({ page, browserApp, investigationCase }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto(`${browserApp.origin}/consultation`)
  await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('tab', { name: '待诊', exact: true }).click()

  await page.getByRole('button', { name: /^选择病例 / }).click()
  await page.getByRole('button', { name: '开始首诊', exact: true }).click()
  await expect(page.getByRole('tab', { name: '在诊', exact: true, includeHidden: true })).toHaveAttribute('aria-selected', 'true')
  await openWorkspaceTab(page, '检验检查')
  const laboratory = page.getByRole('tabpanel', { name: /^检验 \d+$/ })
  const readCase = async () => doctorCaseDetailSchema.parse(await (await page.request.get(
    `${browserApp.origin}/api/his/v1/doctor/cases/${investigationCase.outpatientCaseId}`)).json())
  // 弹窗合同：目录选择与适应证确认在「选择检验项目」弹窗内完成，确认即直写服务端草稿。
  await laboratory.getByRole('button', { name: '添加检验', exact: true }).click()
  const composer = page.getByRole('dialog', { name: '选择检验项目', exact: true })
  await composer.getByLabel('搜索检验目录', { exact: true }).fill('不兼容')
  await composer.getByRole('button', { name: '执行检验目录搜索', exact: true }).click()
  await composer.getByRole('button', { name: '选择 合成不兼容检验 0101901A', exact: true }).click()
  await composer.getByRole('button', { name: '加入检验申请', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(laboratory.getByRole('region', { name: '检验申请', exact: true }).getByText('草稿已自动保存', { exact: true })).toBeVisible()
  const issueResponse = page.waitForResponse(response => response.url().endsWith('/recommendations/laboratory/actions/confirm'))
  await laboratory.getByRole('region', { name: '待开具检验', exact: true }).getByRole('button', { name: /^开具选中项目/ }).click()
  const issuedResponse = await issueResponse
  expect(issuedResponse.status()).toBe(200)
  const issuedId = confirmDoctorPreparationResponseSchema.parse(await issuedResponse.json()).data.recordIds[0]
  if (issuedId === undefined) throw new Error('Expected the issued laboratory request identity')
  const original = (await readCase()).laboratoryRequests?.requests.find(request => request.id === issuedId)
  expect(original?.billing).toBeDefined()
  await collectOutpatientInvestigation(browserApp, { caseId: investigationCase.outpatientCaseId,
    category: 'laboratory', chargeItemId: original!.billing!.chargeItemId })
  await browserApp.runtime.dispatchPending()
  const detail = laboratory.getByRole('region', { name: '申请详情', exact: true })
  await expect(detail.getByText('该病例的合成检验真值与申请的结果定义或单位不兼容，无法生成结果。请取消此申请。', { exact: true })).toBeVisible()
  await expect(detail.getByRole('button', { name: /重试结果生成/ })).toHaveCount(0)
  await detail.getByRole('button', { name: '取消检验申请 合成不兼容检验', exact: true }).click()
  const confirmation = page.getByRole('alertdialog', { name: '确认取消检验申请', exact: true })
  await expect(confirmation.getByText('结果生成失败', { exact: true })).toBeVisible()
  const failed = (await readCase()).laboratoryRequests?.requests.find(request => request.id === issuedId)
  expect(failed?.status).toBe('generation-failed')
  expect(failed?.generationError?.code).toBe('INVESTIGATION_TRUTH_INCOMPATIBLE')
  expect(failed?.report).toBeUndefined()
  const cancelResponse = page.waitForResponse(response => response.url().endsWith(`/${issuedId}/actions/cancel`))
  await confirmation.getByRole('button', { name: '确认取消', exact: true }).click()
  expect((await cancelResponse).status()).toBe(200)
  await expect(confirmation).toHaveCount(0)
  await expect(detail.getByText('检验申请已取消', { exact: true })).toBeVisible()
  expect((await readCase()).laboratoryRequests?.requests.find(request => request.id === issuedId)?.status).toBe('cancelled')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.reload()
  await openWorkspaceTab(page, '检验检查')
  await expect(laboratory.getByRole('region', { name: '申请列表', exact: true }).getByText('已取消', { exact: true })).toBeVisible()
  await expect(detail.getByRole('button', { name: /取消检验申请|重试结果生成/ })).toHaveCount(0)
})

test('keeps the current category when another category finishes issuing a request', async ({ page, browserApp, investigationCase }) => {
  let resumeIssue: () => void = () => undefined
  let issueStarted: () => void = () => undefined
  const waitingForIssue = new Promise<void>(resolve => { issueStarted = resolve })
  const issueGate = new Promise<void>(resolve => { resumeIssue = resolve })
  await page.route('**/recommendations/laboratory/actions/confirm', async route => {
    issueStarted()
    await issueGate
    await route.continue()
  })
  try {
    await page.goto(`${browserApp.origin}/consultation`)
    await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
    await page.getByLabel('账户密码').fill(browserApp.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByRole('tab', { name: '待诊', exact: true }).click()
    await page.getByRole('button', { name: /^选择病例 / }).click()
    await page.getByRole('button', { name: '开始首诊', exact: true }).click()
    await expect(page.getByRole('tab', { name: '在诊', exact: true, includeHidden: true })).toHaveAttribute('aria-selected', 'true')
    await openWorkspaceTab(page, '检验检查')
    const laboratory = page.getByRole('tabpanel', { name: /^检验 \d+$/ })
    // 弹窗合同：先在弹窗内加入检验草稿，再发起开具并用路由闸门挂起请求。
    await laboratory.getByRole('button', { name: '添加检验', exact: true }).click()
    const composer = page.getByRole('dialog', { name: '选择检验项目', exact: true })
    await composer.getByLabel('搜索检验目录', { exact: true }).fill('白细胞')
    await composer.getByRole('button', { name: '执行检验目录搜索', exact: true }).click()
    await composer.getByRole('button', { name: '选择 合成白细胞计数 0100101A', exact: true }).click()
    await composer.getByRole('button', { name: '加入检验申请', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(laboratory.getByRole('region', { name: '检验申请', exact: true }).getByText('草稿已自动保存', { exact: true })).toBeVisible()
    const issueResponse = page.waitForResponse(response => response.url().endsWith('/recommendations/laboratory/actions/confirm'))
    await laboratory.getByRole('region', { name: '待开具检验', exact: true }).getByRole('button', { name: /^开具选中项目/ }).click()
    await waitingForIssue
    const radiologyTab = page.getByRole('tab', { name: '放射检查 0', exact: true })
    await radiologyTab.click()
    await page.getByRole('region', { name: '开具放射申请', exact: true }).getByRole('button', { name: '添加放射检查', exact: true }).click()
    const imagingComposer = page.getByRole('dialog', { name: '选择放射检查', exact: true })
    await imagingComposer.getByLabel('搜索放射目录', { exact: true }).fill('保留当前放射检索')
    resumeIssue()
    expect((await issueResponse).status()).toBe(200)
    // 他类申请确认完成只刷新病例：当前弹窗保持打开、未保存输入保留、页签不切换（弹窗打开时背景 aria-hidden）。
    await expect(imagingComposer).toBeVisible()
    await expect(page.getByRole('tab', { name: '放射检查 0', exact: true, includeHidden: true })).toHaveAttribute('aria-selected', 'true')
    await expect(imagingComposer.getByLabel('搜索放射目录', { exact: true })).toHaveValue('保留当前放射检索')
    await imagingComposer.getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('tab', { name: '放射检查 0', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('region', { name: '开具放射申请', exact: true })).toBeVisible()
    const response = await page.request.get(`${browserApp.origin}/api/his/v1/doctor/cases/${investigationCase.outpatientCaseId}`)
    expect(doctorCaseDetailSchema.parse(await response.json()).laboratoryRequests?.requests).toHaveLength(1)
    await page.getByRole('tab', { name: '检验 1', exact: true }).click()
    await expect(laboratory.getByRole('region', { name: '申请列表', exact: true }).getByRole('button', { name: /^合成白细胞计数 / })).toHaveAttribute('aria-pressed', 'true')
  } finally {
    resumeIssue()
  }
})

for (const width of [1280, 390]) test(`a doctor issues, reads, adds and restores laboratory requests through the real server at ${width}px`, async ({ page, browserApp, investigationCase }) => {
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.setViewportSize({ width, height: 900 })
  await page.goto(`${browserApp.origin}/consultation`)
  await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(browserApp.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('tab', { name: '待诊', exact: true }).click()

  await page.getByRole('button', { name: /^选择病例 / }).click()
  await page.getByRole('button', { name: '开始首诊', exact: true }).click()
  await expect(page.getByRole('tab', { name: '在诊', exact: true, includeHidden: true })).toHaveAttribute('aria-selected', 'true')
  await openWorkspaceTab(page, '检验检查')
  const laboratory = page.getByRole('tabpanel', { name: /^检验 \d+$/ })
  const readCase = async () => {
    const response = await page.request.get(`${browserApp.origin}/api/his/v1/doctor/cases/${investigationCase.outpatientCaseId}`)
    expect(response.status()).toBe(200)
    return doctorCaseDetailSchema.parse(await response.json())
  }
  expect((await readCase()).laboratoryRequests?.requests ?? []).toEqual([])
  const entry = laboratory.locator('[data-order-entry]')
  await expect(entry.getByRole('button', { name: '添加检验', exact: true })).toBeVisible()
  await expect(entry.getByText('尚未选择检验项目', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await expect(entry.getByRole('button', { name: '开具检验申请', exact: true })).toHaveCount(0)
  // 弹窗合同：目录检索、选中与适应证确认都在「选择检验项目」弹窗内完成。
  await entry.getByRole('button', { name: '添加检验', exact: true }).click()
  const composer = page.getByRole('dialog', { name: '选择检验项目', exact: true })
  await composer.getByLabel('搜索检验目录', { exact: true }).fill('不存在项目')
  await composer.getByRole('button', { name: '执行检验目录搜索', exact: true }).click()
  await expect(composer.getByText('没有匹配记录', { exact: true })).toBeVisible()
  await composer.getByLabel('搜索检验目录', { exact: true }).fill('白细胞')
  await composer.getByRole('button', { name: '执行检验目录搜索', exact: true }).click()
  await composer.getByRole('button', { name: '选择 合成白细胞计数 0100101A', exact: true }).click()
  // 确认前弹窗先给出标本、报告结构等定义，适应证自动取首个允许值。
  await expect(composer.getByRole('definition').filter({ hasText: /^全血$/ })).toBeVisible()
  await expect(composer.getByText('1 项指标', { exact: true })).toBeVisible()
  await composer.getByRole('button', { name: '加入检验申请', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(entry.getByText('草稿已自动保存', { exact: true })).toBeVisible()

  await page.getByRole('tab', { name: '放射检查 0', exact: true }).click()
  await expect(page.getByRole('region', { name: '开具放射申请', exact: true }).getByRole('button', { name: '添加放射检查', exact: true })).toBeVisible()
  await page.getByRole('tab', { name: '病理会诊 0', exact: true }).click()
  const pathologyForm = page.getByRole('region', { name: '开具病理会诊', exact: true })
  await pathologyForm.getByRole('button', { name: '添加病理会诊', exact: true }).click()
  const pathologyComposer = page.getByRole('dialog', { name: '选择病理会诊', exact: true })
  await expect(pathologyComposer.getByLabel('搜索病理目录', { exact: true })).toBeVisible()
  // 病例没有可送检的既往手术，弹窗内目录行禁用并给出提示。
  await expect(pathologyComposer.getByText('无可送检的既往手术', { exact: true }).first()).toBeVisible()
  await pathologyComposer.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('tab', { name: '检验 0', exact: true }).click()
  await expect(entry.getByText('草稿已自动保存', { exact: true })).toBeVisible()
  const issueResponse = page.waitForResponse(response => response.url().endsWith('/recommendations/laboratory/actions/confirm'))
  await laboratory.getByRole('region', { name: '待开具检验', exact: true }).getByRole('button', { name: /^开具选中项目/ }).click()
  const issuedResponse = await issueResponse
  expect(issuedResponse.status()).toBe(200)
  const issuedId = confirmDoctorPreparationResponseSchema.parse(await issuedResponse.json()).data.recordIds[0]
  if (issuedId === undefined) throw new Error('Expected the issued laboratory request identity')
  await expect(page.getByRole('tab', { name: '检验 1', exact: true })).toBeVisible()
  await expect(laboratory.getByRole('region', { name: '申请列表', exact: true })).toBeVisible()
  const detail = laboratory.getByRole('region', { name: '申请详情', exact: true })
  await expect(detail.getByRole('heading', { name: '合成白细胞计数', exact: true })).toBeVisible()
  await expect(detail.getByRole('heading', { name: /检验报告/ })).toHaveCount(0)
  // 开具后入口恢复空态，等待下一次添加。
  await expect(entry.getByRole('button', { name: '添加检验', exact: true })).toBeVisible()
  expect((await readCase()).laboratoryRequests?.requests[0]?.id).toBe(issuedId)

  const first = (await readCase()).laboratoryRequests?.requests.find(request => request.id === issuedId)
  expect(first?.billing).toBeDefined()
  await collectOutpatientInvestigation(browserApp, { caseId: investigationCase.outpatientCaseId,
    category: 'laboratory', chargeItemId: first!.billing!.chargeItemId })
  await browserApp.runtime.dispatchPending()
  await expect(detail.getByRole('heading', { name: '合成白细胞计数 · 检验报告', exact: true })).toBeVisible()
  await expect(detail.getByRole('table').getByText('11.2', { exact: true })).toBeVisible()
  await expect(detail.getByRole('table').getByText('×10^9/L', { exact: true })).toBeVisible()
  await expect(detail.getByRole('table').getByText('偏高', { exact: true })).toBeVisible()
  await expect(laboratory.getByText('共 1 份申请 · 1 份待阅', { exact: true })).toBeVisible()
  await laboratory.getByRole('button', { name: '待阅', exact: true }).click()
  await detail.getByRole('button', { name: '确认已阅 合成白细胞计数', exact: true }).click()
  await expect(laboratory.getByText('共 1 份申请 · 0 份待阅', { exact: true })).toBeVisible()
  await expect(laboratory.getByText('没有匹配的申请', { exact: true })).toBeVisible()
  await expect(detail.getByRole('heading', { name: '合成白细胞计数 · 检验报告', exact: true })).toBeVisible()
  expect((await readCase()).laboratoryRequests?.requests[0]?.report?.acknowledgement).toBeDefined()
  await laboratory.getByRole('button', { name: '查看全部申请', exact: true }).click()

  const addition = laboratory.locator('[data-order-entry]')
  expect(await addition.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    return bounds.left >= 0 && bounds.right <= window.innerWidth
  })).toBe(true)
  // 再次添加同样经弹窗完成。
  await addition.getByRole('button', { name: '添加检验', exact: true }).click()
  const additionComposer = page.getByRole('dialog', { name: '选择检验项目', exact: true })
  await additionComposer.getByLabel('搜索检验目录', { exact: true }).fill('血红蛋白')
  await additionComposer.getByRole('button', { name: '执行检验目录搜索', exact: true }).click()
  await additionComposer.getByRole('button', { name: '选择 合成血红蛋白 0100501A', exact: true }).click()
  await additionComposer.getByRole('button', { name: '加入检验申请', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(addition.getByText('草稿已自动保存', { exact: true })).toBeVisible()
  await expect(addition.getByRole('button', { name: '开具检验申请', exact: true })).toHaveCount(0)
  await expect(addition).toBeVisible()
  const issueSelected = laboratory.getByRole('region', { name: '待开具检验', exact: true }).getByRole('button', { name: /^开具选中项目/ })
  await issueSelected.scrollIntoViewIfNeeded()
  await expect(issueSelected).toBeInViewport()
  await issueSelected.click()
  await expect(page.getByRole('tab', { name: '检验 2', exact: true })).toBeVisible()
  await expect(detail.getByRole('heading', { name: '合成血红蛋白', exact: true })).toBeVisible()
  const second = (await readCase()).laboratoryRequests?.requests.find(request => request.id !== issuedId)
  expect(second?.billing).toBeDefined()
  await collectOutpatientInvestigation(browserApp, { caseId: investigationCase.outpatientCaseId,
    category: 'laboratory', chargeItemId: second!.billing!.chargeItemId })
  await browserApp.runtime.dispatchPending()
  await expect(detail.getByRole('table').getByText('135', { exact: true })).toBeVisible()
  await expect(detail.getByRole('table').getByText('g/L', { exact: true })).toBeVisible()
  await expect(laboratory.getByRole('region', { name: '申请列表', exact: true }).getByRole('button', { name: '合成白细胞计数 医生已阅', exact: true })).toBeVisible()

  await page.reload()
  await openWorkspaceTab(page, '检验检查')
  await expect(page.getByRole('tab', { name: '检验 2', exact: true })).toBeVisible()
  await expect(laboratory.getByRole('region', { name: '申请列表', exact: true })).toBeVisible()
  await expect(laboratory.getByRole('region', { name: '检验申请', exact: true }).getByRole('button', { name: '添加检验', exact: true })).toBeVisible()
  const requests = (await readCase()).laboratoryRequests?.requests
  expect(requests).toHaveLength(2)
  expect(requests?.find(request => request.id === issuedId)?.status).toBe('acknowledged')
  expect(requests?.find(request => request.id !== issuedId)?.status).toBe('reported')

  await page.goto(`${browserApp.origin}/settings`)
  await page.getByRole('main').getByRole('button', { name: '暗色', exact: true }).click()
  await page.getByRole('button', { name: 'English', exact: true }).click()
  for (const fontSize of ['Standard', 'Larger', 'Large']) {
    await page.getByRole('button', { name: fontSize, exact: true }).click()
    await page.goto(`${browserApp.origin}/consultation`)
    await openWorkspaceTab(page, 'Investigations')
    await expect(page.getByRole('tab', { name: 'Laboratory 2', exact: true })).toBeVisible()
    await page.getByRole('region', { name: 'Request list', exact: true }).getByRole('button', { name: /^合成血红蛋白 / }).click()
    const englishDetail = page.getByRole('region', { name: 'Request detail', exact: true })
    await expect(englishDetail.getByRole('table').getByText('135', { exact: true })).toBeVisible()
    const acknowledgement = englishDetail.getByRole('button', { name: 'Acknowledge report 合成血红蛋白', exact: true })
    await acknowledgement.scrollIntoViewIfNeeded()
    await expect(acknowledgement).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.goto(`${browserApp.origin}/settings`)
  }
  expect(pageErrors).toEqual([])
})
