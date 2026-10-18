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
      try { await use(app) }
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
  await page.getByRole('button', { name: '候诊患者', exact: true }).click()
  await page.getByRole('button', { name: /^选择病例 / }).click()
  await page.getByRole('button', { name: '开始首诊', exact: true }).click()
  await page.getByRole('tab', { name: '检验检查', exact: true }).click()
  const laboratory = page.getByRole('tabpanel', { name: /^检验 \d+$/ })
  const manualForm = laboratory.locator('[data-order-entry]')
  await manualForm.getByRole('button', { name: '选择 合成不兼容检验 0101901A', exact: true }).click()
  await expect(manualForm.getByText('草稿已自动保存', { exact: true })).toBeVisible()
  const issueResponse = page.waitForResponse(response => response.url().endsWith('/recommendations/laboratory/actions/confirm'))
  await laboratory.getByRole('region', { name: '待开具检验', exact: true }).getByRole('button', { name: /^开具选中项目/ }).click()
  const issuedResponse = await issueResponse
  expect(issuedResponse.status()).toBe(200)
  const issuedId = confirmDoctorPreparationResponseSchema.parse(await issuedResponse.json()).data.recordIds[0]
  if (issuedId === undefined) throw new Error('Expected the issued laboratory request identity')
  await browserApp.runtime.dispatchPending()
  const detail = laboratory.getByRole('region', { name: '申请详情', exact: true })
  await expect(detail.getByText('该病例的合成检验真值与申请的结果定义或单位不兼容，无法生成结果。请取消此申请。', { exact: true })).toBeVisible()
  await expect(detail.getByRole('button', { name: /重试结果生成/ })).toHaveCount(0)
  await detail.getByRole('button', { name: '取消检验申请 合成不兼容检验', exact: true }).click()
  const confirmation = page.getByRole('alertdialog', { name: '确认取消检验申请', exact: true })
  await expect(confirmation.getByText('结果生成失败', { exact: true })).toBeVisible()
  const readCase = async () => doctorCaseDetailSchema.parse(await (await page.request.get(
    `${browserApp.origin}/api/his/v1/doctor/cases/${investigationCase.outpatientCaseId}`)).json())
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
  await page.getByRole('tab', { name: '检验检查', exact: true }).click()
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
    await expect(page.getByRole('tab', { name: '在诊', exact: true })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('tab', { name: '检验检查', exact: true }).click()
    const laboratory = page.getByRole('tabpanel', { name: /^检验 \d+$/ })
    const manualForm = laboratory.locator('[data-order-entry]')
    await manualForm.getByRole('button', { name: '选择 合成白细胞计数 0100101A', exact: true }).click()
    await expect(manualForm.getByText('草稿已自动保存', { exact: true })).toBeVisible()
    const issueResponse = page.waitForResponse(response => response.url().endsWith('/recommendations/laboratory/actions/confirm'))
    await laboratory.getByRole('region', { name: '待开具检验', exact: true }).getByRole('button', { name: /^开具选中项目/ }).click()
    await waitingForIssue
    const radiologyTab = page.getByRole('tab', { name: '放射检查 0', exact: true })
    await radiologyTab.click()
    const imagingForm = page.getByRole('region', { name: '开具放射申请', exact: true })
    await imagingForm.getByLabel('搜索放射目录').fill('保留当前放射检索')
    resumeIssue()
    expect((await issueResponse).status()).toBe(200)
    await expect(imagingForm).toBeVisible()
    await expect(page.getByRole('tab', { name: '放射检查 0', exact: true, includeHidden: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByLabel('搜索放射目录')).toHaveValue('保留当前放射检索')
    await expect(page.getByLabel('搜索放射目录')).toBeVisible()
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
  if (width === 390) await page.getByRole('button', { name: '候诊患者', exact: true }).click()
  await page.getByRole('button', { name: /^选择病例 / }).click()
  await page.getByRole('button', { name: '开始首诊', exact: true }).click()
  await page.getByRole('tab', { name: '检验检查', exact: true }).click()
  const laboratory = page.getByRole('tabpanel', { name: /^检验 \d+$/ })
  const readCase = async () => {
    const response = await page.request.get(`${browserApp.origin}/api/his/v1/doctor/cases/${investigationCase.outpatientCaseId}`)
    expect(response.status()).toBe(200)
    return doctorCaseDetailSchema.parse(await response.json())
  }
  expect((await readCase()).laboratoryRequests?.requests ?? []).toEqual([])
  await expect(laboratory.getByLabel('搜索检验目录')).toBeVisible()
  const manualForm = laboratory.locator('[data-order-entry]')
  await expect(manualForm.getByLabel('搜索检验目录')).toBeVisible()
  await expect(manualForm.getByText('尚未选择检验项目')).toBeVisible()
  await expect(manualForm.getByRole('button', { name: '选择 合成白细胞计数 0100101A', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await expect(manualForm.getByRole('button', { name: '开具检验申请', exact: true })).toHaveCount(0)
  await manualForm.getByLabel('搜索检验目录').fill('不存在项目')
  await manualForm.getByRole('button', { name: '执行检验目录搜索', exact: true }).click()
  await expect(manualForm.getByText('没有匹配记录', { exact: true })).toBeVisible()
  await manualForm.getByLabel('搜索检验目录').fill('白细胞')
  await manualForm.getByRole('button', { name: '执行检验目录搜索', exact: true }).click()
  const choice = manualForm.getByRole('button', { name: '选择 合成白细胞计数 0100101A', exact: true })
  await choice.focus()
  await choice.press('Space')
  await expect(manualForm.getByText('草稿已自动保存', { exact: true })).toBeVisible()
  await expect(manualForm.getByRole('definition').filter({ hasText: /^全血$/ })).toBeVisible()
  await expect(manualForm.getByText('1 项指标', { exact: true })).toBeVisible()

  await page.getByRole('tab', { name: '放射检查 0', exact: true }).click()
  await expect(page.getByLabel('搜索放射目录')).toBeVisible()
  const imagingForm = page.getByRole('region', { name: '开具放射申请', exact: true })
  await expect(imagingForm.getByLabel('搜索放射目录')).toBeVisible()
  await expect(page.getByLabel('搜索检验目录')).toBeHidden()
  await page.getByRole('tab', { name: '病理会诊 0', exact: true }).click()
  const pathologyForm = page.getByRole('region', { name: '开具病理会诊', exact: true })
  await expect(pathologyForm.getByLabel('搜索病理目录')).toBeVisible()
  await expect(pathologyForm.getByText('无可送检的既往乳腺手术')).toBeVisible()
  await page.getByRole('tab', { name: '检验 0', exact: true }).click()
  await expect(manualForm.getByText('草稿已自动保存', { exact: true })).toBeVisible()
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
  await expect(laboratory.getByLabel('搜索检验目录')).toBeVisible()
  expect((await readCase()).laboratoryRequests?.requests[0]?.id).toBe(issuedId)

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
  await addition.getByLabel('搜索检验目录').focus()
  await expect(addition.getByRole('button', { name: '收起目录', exact: true })).toHaveAttribute('aria-expanded', 'true')
  await addition.getByLabel('搜索检验目录').fill('血红蛋白')
  await addition.getByRole('button', { name: '执行检验目录搜索', exact: true }).click()
  await addition.getByRole('button', { name: '选择 合成血红蛋白 0100501A', exact: true }).click()
  await expect(addition.getByText('草稿已自动保存', { exact: true })).toBeVisible()
  await expect(addition.getByRole('button', { name: '开具检验申请', exact: true })).toHaveCount(0)
  await expect(addition).toBeVisible()
  const issueSelected = laboratory.getByRole('region', { name: '待开具检验', exact: true }).getByRole('button', { name: /^开具选中项目/ })
  await issueSelected.scrollIntoViewIfNeeded()
  await expect(issueSelected).toBeInViewport()
  await issueSelected.click()
  await expect(page.getByRole('tab', { name: '检验 2', exact: true })).toBeVisible()
  await expect(detail.getByRole('heading', { name: '合成血红蛋白', exact: true })).toBeVisible()
  await browserApp.runtime.dispatchPending()
  await expect(detail.getByRole('table').getByText('135', { exact: true })).toBeVisible()
  await expect(detail.getByRole('table').getByText('g/L', { exact: true })).toBeVisible()
  await expect(laboratory.getByRole('region', { name: '申请列表', exact: true }).getByRole('button', { name: '合成白细胞计数 医生已阅', exact: true })).toBeVisible()

  await page.reload()
  await page.getByRole('tab', { name: '检验检查', exact: true }).click()
  await expect(page.getByRole('tab', { name: '检验 2', exact: true })).toBeVisible()
  await expect(laboratory.getByRole('region', { name: '申请列表', exact: true })).toBeVisible()
  await expect(laboratory.getByLabel('搜索检验目录')).toBeVisible()
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
    await page.getByRole('tab', { name: 'Investigations', exact: true }).click()
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
