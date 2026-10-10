import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doctorCaseDetailSchema, issueLaboratoryRequestResponseSchema } from '@clinmesh/contracts/his'
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
        patientPersonaModel: 'synthetic-persona', syntheaProvider: new StubSyntheaProvider(),
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

test('keeps the current category when another category finishes issuing a request', async ({ page, browserApp, investigationCase }) => {
  let resumeIssue: () => void = () => undefined
  let issueStarted: () => void = () => undefined
  const waitingForIssue = new Promise<void>(resolve => { issueStarted = resolve })
  const issueGate = new Promise<void>(resolve => { resumeIssue = resolve })
  await page.route('**/laboratory-request/actions/issue', async route => {
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
    await page.getByRole('tab', { name: '检验检查', exact: true }).click()
    const laboratory = page.getByRole('tabpanel', { name: /^检验 \d+$/ })
    await laboratory.getByRole('button', { name: '选择 合成白细胞计数 0100101A', exact: true }).click()
    await expect(laboratory.getByText('草稿已自动保存', { exact: true })).toBeVisible()
    const issueResponse = page.waitForResponse(response => response.url().endsWith('/laboratory-request/actions/issue'))
    await laboratory.getByRole('button', { name: '开具检验申请', exact: true }).click()
    await waitingForIssue
    const radiologyTab = page.getByRole('tab', { name: '放射检查 0', exact: true })
    await radiologyTab.click()
    await page.getByLabel('搜索放射目录').fill('保留当前放射检索')
    resumeIssue()
    expect((await issueResponse).status()).toBe(200)
    await expect(page.getByRole('tab', { name: '检验 1', exact: true })).toBeVisible()
    await expect(radiologyTab).toHaveAttribute('aria-selected', 'true')
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
  await expect(laboratory.getByText('尚未选择检验项目')).toBeVisible()
  await expect(laboratory.getByRole('button', { name: '选择 合成白细胞计数 0100101A', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await expect(laboratory.getByRole('button', { name: '开具检验申请', exact: true })).toHaveCount(0)
  await laboratory.getByLabel('搜索检验目录').fill('不存在项目')
  await laboratory.getByRole('button', { name: '执行检验目录搜索', exact: true }).click()
  await expect(laboratory.getByText('没有匹配记录', { exact: true })).toBeVisible()
  await laboratory.getByLabel('搜索检验目录').fill('白细胞')
  await laboratory.getByRole('button', { name: '执行检验目录搜索', exact: true }).click()
  const choice = laboratory.getByRole('button', { name: '选择 合成白细胞计数 0100101A', exact: true })
  await choice.focus()
  await choice.press('Space')
  await expect(laboratory.getByText('草稿已自动保存', { exact: true })).toBeVisible()
  await expect(laboratory.getByRole('definition').filter({ hasText: /^全血$/ })).toBeVisible()
  await expect(laboratory.getByText('1 项指标', { exact: true })).toBeVisible()

  await page.getByRole('tab', { name: '放射检查 0', exact: true }).click()
  await expect(page.getByLabel('搜索放射目录')).toBeVisible()
  await expect(page.getByLabel('搜索检验目录')).toBeHidden()
  await page.getByRole('tab', { name: '病理会诊 0', exact: true }).click()
  await expect(page.getByLabel('搜索病理目录')).toBeVisible()
  await expect(page.getByText('无可送检的既往乳腺手术')).toBeVisible()
  await page.getByRole('tab', { name: '检验 0', exact: true }).click()
  await expect(laboratory.getByText('草稿已自动保存', { exact: true })).toBeVisible()
  const issueResponse = page.waitForResponse(response => response.url().endsWith('/laboratory-request/actions/issue'))
  await laboratory.getByRole('button', { name: '开具检验申请', exact: true }).click()
  const issuedResponse = await issueResponse
  expect(issuedResponse.status()).toBe(200)
  const issued = issueLaboratoryRequestResponseSchema.parse(await issuedResponse.json()).data.request
  await expect(page.getByRole('tab', { name: '检验 1', exact: true })).toBeVisible()
  await expect(laboratory.getByRole('region', { name: '申请列表', exact: true })).toBeVisible()
  const detail = laboratory.getByRole('region', { name: '申请详情', exact: true })
  await expect(detail.getByRole('heading', { name: '合成白细胞计数', exact: true })).toBeVisible()
  await expect(detail.getByRole('heading', { name: /检验报告/ })).toHaveCount(0)
  await expect(laboratory.getByLabel('搜索检验目录')).toHaveCount(0)
  expect((await readCase()).laboratoryRequests?.requests[0]?.id).toBe(issued.id)

  await browserApp.runtime.dispatchPending()
  await expect(detail.getByRole('heading', { name: '合成白细胞计数 · 检验报告', exact: true })).toBeVisible()
  await expect(detail.getByRole('table').getByText('11.2', { exact: true })).toBeVisible()
  await expect(laboratory.getByText('共 1 份申请 · 1 份待阅', { exact: true })).toBeVisible()
  await laboratory.getByRole('button', { name: '待阅', exact: true }).click()
  await detail.getByRole('button', { name: '确认已阅 合成白细胞计数', exact: true }).click()
  await expect(laboratory.getByText('共 1 份申请 · 0 份待阅', { exact: true })).toBeVisible()
  await expect(laboratory.getByText('没有匹配的申请', { exact: true })).toBeVisible()
  await expect(detail.getByRole('heading', { name: '合成白细胞计数 · 检验报告', exact: true })).toBeVisible()
  expect((await readCase()).laboratoryRequests?.requests[0]?.report?.acknowledgement).toBeDefined()
  await laboratory.getByRole('button', { name: '查看全部申请', exact: true }).click()

  await laboratory.getByRole('button', { name: '追加申请', exact: true }).click()
  const addition = page.getByRole('dialog', { name: '追加申请', exact: true })
  expect(await addition.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    return bounds.left >= 0 && bounds.right <= window.innerWidth
  })).toBe(true)
  await addition.getByLabel('搜索检验目录').fill('血红蛋白')
  await addition.getByRole('button', { name: '执行检验目录搜索', exact: true }).click()
  await addition.getByRole('button', { name: '选择 合成血红蛋白 0100501A', exact: true }).click()
  await expect(addition.getByText('草稿已自动保存', { exact: true })).toBeVisible()
  await addition.getByRole('button', { name: '开具检验申请', exact: true }).scrollIntoViewIfNeeded()
  await expect(addition.getByRole('button', { name: '开具检验申请', exact: true })).toBeInViewport()
  await addition.getByRole('button', { name: '开具检验申请', exact: true }).click()
  await expect(addition).toHaveCount(0)
  await expect(page.getByRole('tab', { name: '检验 2', exact: true })).toBeVisible()
  await expect(detail.getByRole('heading', { name: '合成血红蛋白', exact: true })).toBeVisible()
  await browserApp.runtime.dispatchPending()
  await expect(detail.getByRole('table').getByText('135', { exact: true })).toBeVisible()
  await expect(laboratory.getByRole('region', { name: '申请列表', exact: true }).getByRole('button', { name: '合成白细胞计数 医生已阅', exact: true })).toBeVisible()

  await page.reload()
  await page.getByRole('tab', { name: '检验检查', exact: true }).click()
  await expect(page.getByRole('tab', { name: '检验 2', exact: true })).toBeVisible()
  await expect(laboratory.getByRole('region', { name: '申请列表', exact: true })).toBeVisible()
  await expect(laboratory.getByLabel('搜索检验目录')).toHaveCount(0)
  const requests = (await readCase()).laboratoryRequests?.requests
  expect(requests).toHaveLength(2)
  expect(requests?.find(request => request.id === issued.id)?.status).toBe('acknowledged')
  expect(requests?.find(request => request.id !== issued.id)?.status).toBe('reported')

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
